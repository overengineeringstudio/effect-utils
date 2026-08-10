/**
 * Group G span-assertion suite (R21–R24, R29). Drives the REAL instrumented
 * `cat` / `put` / `edit` editor paths against a fake in-memory gateway (no
 * secrets, no network) and asserts the emitted span shape via the otelite
 * in-process capture bridge (`@overeng/utils-dev/otelite`), the same pattern the
 * notion-effect-client `NotionHttp` span test uses.
 *
 * Two load-bearing checks:
 *
 * 1. Each top-level editor command emits its root span (`notion-md.cat` /
 *    `notion-md.put` / `notion-md.edit`) with the actually-emitted attributes,
 *    and `edit` wraps the engine's `notion-md.sync-page` / `status-page` /
 *    `push-page` spans as children of the one `notion-md.edit` root (decision
 *    0017, R21).
 *
 * 2. R24 leak guard: no captured span attribute value carries a distinctive
 *    sentinel body, a signed-URL marker (`X-Amz-`/`Signature=`/`Expires=`), or a
 *    `Bearer ` token. The sentinel is pushed THROUGH the gateway so the assertion
 *    is meaningful (there is a real body in flight, not just "nothing to leak").
 *
 * Attribute names asserted here are the ones the implementation actually emits
 * (`notion_md.editor.mode`, `notion_md.put.body_written`, …). The spec's span
 * table uses an `nmd.*` shorthand that was never implemented; the divergence is
 * documented for a separate reconciliation rather than papered over with tests
 * that would assert non-existent attributes.
 */

import { FileSystem } from 'effect/FileSystem'
import { NodeServices } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'

import type { BodyCompleteness } from '@overeng/notion-core'
import {
  flushCaptureSpans,
  makeOteliteCaptureLayer,
  OteliteCapture,
} from '@overeng/utils-dev/otelite'

import {
  catEditorPage,
  editEditorPage,
  editReadOnlyPage,
  putEditorPage,
} from './editor-commands.ts'
import { editorBaseHash } from './editor-surface.ts'
import { NmdGatewayError } from './errors.ts'
import { normalizeMarkdownLineEndings } from './hash.ts'
import {
  NotionMdGateway,
  type NotionMdGatewayShape,
  type PullPageResult,
  type RemotePageSnapshot,
} from './model.ts'
import { NmdStateStoreLive } from './state-store.ts'

const exportInterval = 100
const CaptureLayer = makeOteliteCaptureLayer({ exportInterval })

const pageId = '00000000-0000-4000-8000-000000000001'

/**
 * A distinctive body string. If it surfaces in any captured span attribute the
 * R24 leak guard fails — bodies must never reach the telemetry.
 */
const SENTINEL_BODY = 'SECRET-SENTINEL-BODY-do-not-leak-9f3a'

const snapshot = (state: { title: string }): RemotePageSnapshot => ({
  id: pageId,
  title: state.title,
  title_property_key: 'title',
  url: 'https://notion.so/page',
  parent: { type: 'workspace', workspace: true },
  icon: null,
  cover: null,
  in_trash: false,
  is_locked: false,
  last_edited_time: '2026-06-15T12:00:00.000Z',
  properties: {},
})

const pull = (state: {
  title: string
  body: string
  completeness?: BodyCompleteness
}): PullPageResult => ({
  page: snapshot(state),
  markdown: {
    markdown: normalizeMarkdownLineEndings(state.body),
    truncated: false,
    unknown_block_ids: [],
    ...(state.completeness === undefined ? {} : { completeness: state.completeness }),
  },
  storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
})

/** A mutable fake gateway; its body can be switched after the first pull. */
class FakeGateway {
  readonly state: { title: string; body: string; completeness?: BodyCompleteness }
  /** When set, the next pull adopts this body (a concurrent remote writer). */
  private switchBodyOnPull: { afterPull: number; body: string } | undefined
  pullCount = 0

  constructor(initial: { title: string; body: string; completeness?: BodyCompleteness }) {
    this.state = { ...initial, body: normalizeMarkdownLineEndings(initial.body) }
  }

  /** After `afterPull` pulls have completed, the remote body becomes `body`. */
  switchRemoteBodyAfter(afterPull: number, body: string): void {
    this.switchBodyOnPull = { afterPull, body: normalizeMarkdownLineEndings(body) }
  }

  readonly layer = Layer.succeed(NotionMdGateway, {
    pullPage: () =>
      Effect.sync(() => {
        this.pullCount += 1
        if (
          this.switchBodyOnPull !== undefined &&
          this.pullCount > this.switchBodyOnPull.afterPull
        ) {
          this.state.body = this.switchBodyOnPull.body
          this.switchBodyOnPull = undefined
        }
        return pull(this.state)
      }),
    updateMarkdown: ({ command }) =>
      Effect.sync(() => {
        if (command._tag === 'replace_content') {
          this.state.body = normalizeMarkdownLineEndings(command.markdown)
        }
        return { markdown: pull(this.state).markdown }
      }),
    updatePageProperties: () => Effect.dieMessage('unexpected updatePageProperties'),
    retrieveDataSource: () => Effect.dieMessage('unexpected retrieveDataSource'),
    updatePageMetadata: ({ metadata }) =>
      Effect.sync(() => {
        if (metadata.title !== undefined) this.state.title = metadata.title.value
        return snapshot(this.state)
      }),
    listChildPages: () => Effect.succeed([]),
    createPage: () => Effect.dieMessage('unexpected createPage'),
    movePage: () => Effect.dieMessage('unexpected movePage'),
    archivePage: () => Effect.dieMessage('unexpected archivePage'),
  } satisfies NotionMdGatewayShape)
}

/** A scripted non-interactive editor used by the `edit` span test. */
const scriptedEditor =
  (transform: (buffer: string) => string) =>
  (opts: {
    readonly filePath: string
  }): Effect.Effect<number, NmdGatewayError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const buffer = yield* fs.readFileString(opts.filePath)
      yield* fs.writeFileString(opts.filePath, transform(buffer))
      return 0
    }).pipe(
      Effect.mapError(
        (cause) =>
          new NmdGatewayError({ operation: 'scripted_editor', message: String(cause), cause }),
      ),
    )

const stateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeServices.layer))

/** R24 leak guard applied across every captured span attribute value. */
const assertNoSensitiveAttrs = (
  spans: ReadonlyArray<{ readonly attrs: Readonly<Record<string, string>> }>,
): void => {
  for (const span of spans) {
    for (const [key, value] of Object.entries(span.attrs)) {
      expect(value).not.toContain(SENTINEL_BODY)
      expect(value).not.toContain('X-Amz-')
      expect(value).not.toContain('Signature=')
      expect(value).not.toContain('Expires=')
      expect(value).not.toContain('Bearer ')
      expect(key.toLowerCase()).not.toContain('authorization')
    }
  }
}

// `excludeTestServices: true` runs on the REAL clock so the OTLP exporter's
// batch loop + the flush sleep tick against wall time.
layer(CaptureLayer, { excludeTestServices: true })('editor span shapes (Group G)', (it) => {
  it.effect('notion-md.cat emits page_id + editor.mode + span.label, no body leak', () =>
    Effect.gen(function* () {
      const cap = yield* OteliteCapture
      const gateway = new FakeGateway({ title: 'Hello', body: SENTINEL_BODY })

      yield* catEditorPage({
        pageId,
        mode: 'default',
        writeStdout: () => Effect.void,
        writeStderr: () => Effect.void,
      }).pipe(Effect.provide(gateway.layer))

      yield* flushCaptureSpans({ exportInterval })

      const catSpans = yield* cap.inspect({ signal: 'traces', name: 'notion-md.cat' })
      expect(catSpans).toHaveLength(1)
      const span = catSpans[0]!
      expect(span.attrs['notion_md.page_id']).toBe(pageId)
      expect(span.attrs['notion_md.editor.mode']).toBe('default')
      expect(span.attrs['span.label']).toBe(pageId.slice(0, 8))

      assertNoSensitiveAttrs(yield* cap.inspect({ signal: 'traces' }))
    }),
  )

  it.effect('notion-md.put emits force + body_written + title_written result attrs', () =>
    Effect.gen(function* () {
      const cap = yield* OteliteCapture
      const gateway = new FakeGateway({ title: 'Title', body: 'before' })
      const baseHash = editorBaseHash({ title: 'Title', body: 'before\n' })

      const result = yield* putEditorPage({
        pageId,
        // Title changes (→ title_written true) and the body becomes the sentinel.
        buffer: `# New Title\n\n${SENTINEL_BODY}\n`,
        baseHash,
        force: false,
      }).pipe(Effect.provide(gateway.layer))
      expect(result.bodyWritten).toBe(true)
      expect(result.titleWritten).toBe(true)

      yield* flushCaptureSpans({ exportInterval })

      const putSpans = yield* cap.inspect({ signal: 'traces', name: 'notion-md.put' })
      expect(putSpans).toHaveLength(1)
      const span = putSpans[0]!
      expect(span.attrs['notion_md.page_id']).toBe(pageId)
      expect(span.attrs['notion_md.put.force']).toBe('false')
      expect(span.attrs['notion_md.put.body_written']).toBe('true')
      expect(span.attrs['notion_md.put.title_written']).toBe('true')
      expect(span.attrs['span.label']).toBe(pageId.slice(0, 8))

      // R24: the sentinel body went through the gateway but must not be in a span.
      assertNoSensitiveAttrs(yield* cap.inspect({ signal: 'traces' }))
    }),
  )

  it.effect('notion-md.edit wraps the engine status/push spans and records outcome=pushed', () =>
    Effect.gen(function* () {
      const cap = yield* OteliteCapture
      const gateway = new FakeGateway({ title: 'Doc', body: 'original line' })

      const result = yield* editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((buffer) => buffer.replace('original line', SENTINEL_BODY)),
      }).pipe(Effect.provide(Layer.mergeAll(gateway.layer, stateStoreLayer, NodeServices.layer)))
      expect(result.outcome).toBe('pushed')

      yield* flushCaptureSpans({ exportInterval })

      const editSpans = yield* cap.inspect({ signal: 'traces', name: 'notion-md.edit' })
      expect(editSpans).toHaveLength(1)
      const root = editSpans[0]!
      expect(root.attrs['notion_md.page_id']).toBe(pageId)
      expect(root.attrs['notion_md.editor.mode']).toBe('default')
      expect(root.attrs['notion_md.edit.outcome']).toBe('pushed')

      // The engine spans the edit wraps (decision 0017). They share the edit's
      // trace id, proving they are children of the one `notion-md.edit` root.
      const syncPage = yield* cap.inspect({ signal: 'traces', name: 'notion-md.sync-page' })
      expect(syncPage).toHaveLength(1)
      expect(syncPage[0]!.trace_id).toBe(root.trace_id)
      const statusPage = yield* cap.inspect({ signal: 'traces', name: 'notion-md.status-page' })
      expect(statusPage.length).toBeGreaterThanOrEqual(1)
      expect(statusPage[0]!.trace_id).toBe(root.trace_id)
      const pushPage = yield* cap.inspect({ signal: 'traces', name: 'notion-md.push-page' })
      expect(pushPage.length).toBeGreaterThanOrEqual(1)
      expect(pushPage[0]!.trace_id).toBe(root.trace_id)

      // R24 across the whole tree, including the wrapped engine spans.
      assertNoSensitiveAttrs(yield* cap.inspect({ signal: 'traces' }))
    }),
  )

  it.effect('notion-md.edit --read-only records outcome=read-only and never pushes', () =>
    Effect.gen(function* () {
      const cap = yield* OteliteCapture
      const gateway = new FakeGateway({ title: 'Doc', body: SENTINEL_BODY })

      const result = yield* editReadOnlyPage({
        pageId,
        mode: 'default',
        writeStderr: () => Effect.void,
        // The editor "edits" the buffer, but read-only discards it.
        runEditor: scriptedEditor((buffer) => `${buffer}\ndiscarded edit`),
      }).pipe(Effect.provide(Layer.mergeAll(gateway.layer, stateStoreLayer, NodeServices.layer)))
      expect(result.outcome).toBe('read-only')
      // Read-only never calls updateMarkdown: the remote body is untouched.
      expect(gateway.state.body).toBe(normalizeMarkdownLineEndings(SENTINEL_BODY))

      yield* flushCaptureSpans({ exportInterval })

      // The capture layer accumulates across the cases in this block, so select
      // the read-only span by its outcome rather than asserting a global count.
      const editSpans = yield* cap.inspect({ signal: 'traces', name: 'notion-md.edit' })
      const root = editSpans.find((s) => s.attrs['notion_md.edit.outcome'] === 'read-only')
      expect(root).toBeDefined()
      expect(root!.attrs['notion_md.page_id']).toBe(pageId)
      expect(root!.attrs['notion_md.editor.mode']).toBe('default')

      assertNoSensitiveAttrs(yield* cap.inspect({ signal: 'traces' }))
    }),
  )
})
