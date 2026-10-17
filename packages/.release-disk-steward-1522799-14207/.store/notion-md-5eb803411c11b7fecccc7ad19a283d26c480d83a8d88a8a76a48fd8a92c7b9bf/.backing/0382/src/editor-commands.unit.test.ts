import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import type { BodyCompleteness } from '@overeng/notion-core'

import { catEditorPage, putEditorPage } from './editor-commands.ts'
import { editorBaseHash } from './editor-surface.ts'
import { NmdGatewayError } from './errors.ts'
import { normalizeMarkdownLineEndings } from './hash.ts'
import {
  NotionMdGateway,
  type NotionMdGatewayShape,
  type PullPageResult,
  type RemotePageSnapshot,
} from './model.ts'

const pageId = '00000000-0000-4000-8000-000000000001'

const lossyCompleteness: BodyCompleteness = {
  _tag: 'lossy',
  reasons: ['not_round_trip_safe_blocks'],
  lossyBlockTypes: ['child_database'],
}

interface FakeState {
  title: string
  body: string
  completeness?: BodyCompleteness
}

const pageSnapshot = (state: FakeState): RemotePageSnapshot => ({
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

const pullResult = (state: FakeState): PullPageResult => ({
  page: pageSnapshot(state),
  markdown: {
    markdown: normalizeMarkdownLineEndings(state.body),
    truncated: false,
    unknown_block_ids: [],
    ...(state.completeness === undefined ? {} : { completeness: state.completeness }),
  },
  storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
})

/** A mutable fake gateway whose body/title can be edited and read back. */
class FakeGateway {
  readonly state: FakeState
  readonly metadataCalls: Array<{ readonly title?: { readonly value: string } }> = []
  readonly markdownCalls: Array<{ readonly markdown: string }> = []
  /** Body returned by the next pull only, simulating a concurrent remote writer. */
  private injectNextPullBody: string | undefined = undefined
  pullCount = 0
  /** When true, the title metadata write fails (to exercise the exit-10 partial write). */
  failTitleWrite = false

  constructor(initial: FakeState) {
    this.state = { ...initial, body: normalizeMarkdownLineEndings(initial.body) }
  }

  /** Simulate a concurrent writer: the next `pullPage` reports a different body. */
  concurrentlyChangeBodyOnce(body: string): void {
    this.injectNextPullBody = normalizeMarkdownLineEndings(body)
  }

  readonly layer = Layer.succeed(NotionMdGateway, {
    pullPage: () =>
      Effect.sync(() => {
        this.pullCount += 1
        if (this.injectNextPullBody !== undefined) {
          this.state.body = this.injectNextPullBody
          this.injectNextPullBody = undefined
        }
        return pullResult(this.state)
      }),
    updateMarkdown: ({ command }) =>
      Effect.sync(() => {
        if (command._tag === 'replace_content') {
          this.state.body = normalizeMarkdownLineEndings(command.markdown)
          this.markdownCalls.push({ markdown: command.markdown })
        }
        return { markdown: pullResult(this.state).markdown }
      }),
    updatePageProperties: () => Effect.die(new Error('unexpected updatePageProperties')),
    retrieveDataSource: () => Effect.die(new Error('unexpected retrieveDataSource')),
    updatePageMetadata: ({ metadata }) =>
      this.failTitleWrite === true
        ? Effect.fail(
            new NmdGatewayError({
              operation: 'update_page_metadata',
              page_id: pageId,
              message: 'forced title write failure',
            }),
          )
        : Effect.sync(() => {
            if (metadata.title !== undefined) {
              this.state.title = metadata.title.value
              this.metadataCalls.push({ title: { value: metadata.title.value } })
            }
            return pageSnapshot(this.state)
          }),
    listChildPages: () => Effect.succeed([]),
    createPage: () => Effect.die(new Error('unexpected createPage')),
    movePage: () => Effect.die(new Error('unexpected movePage')),
    archivePage: () => Effect.die(new Error('unexpected archivePage')),
  } satisfies NotionMdGatewayShape)
}

const runWith = <A, E>(effect: Effect.Effect<A, E, NotionMdGateway>, gateway: FakeGateway) =>
  Effect.result(effect).pipe(Effect.provide(gateway.layer), Effect.runPromise)

describe('cat', () => {
  it('emits `# title` + body to stdout and the base hash to stderr', async () => {
    const gateway = new FakeGateway({ title: 'Hello', body: 'world' })
    const stdout: string[] = []
    const stderr: string[] = []
    const result = await runWith(
      catEditorPage({
        pageId,
        mode: 'default',
        writeStdout: (v) => Effect.sync(() => void stdout.push(v)),
        writeStderr: (v) => Effect.sync(() => void stderr.push(v)),
      }),
      gateway,
    )
    expect(result._tag).toBe('Success')
    expect(stdout).toEqual(['# Hello\n\nworld\n'])
    expect(stderr[0]).toBe(`base-hash: ${editorBaseHash({ title: 'Hello', body: 'world\n' })}`)
  })

  it('refuses a lossy page (NmdRemoteBodyLossyError → exit 3)', async () => {
    const gateway = new FakeGateway({ title: 'X', body: 'y', completeness: lossyCompleteness })
    const result = await runWith(
      catEditorPage({
        pageId,
        mode: 'default',
        writeStdout: () => Effect.void,
        writeStderr: () => Effect.void,
      }),
      gateway,
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure._tag).toBe('NmdRemoteBodyLossyError')
  })

  it('--frontmatter dumps the full envelope', async () => {
    const gateway = new FakeGateway({ title: 'Env', body: 'body text' })
    const stdout: string[] = []
    const result = await runWith(
      catEditorPage({
        pageId,
        mode: 'frontmatter',
        writeStdout: (v) => Effect.sync(() => void stdout.push(v)),
        writeStderr: () => Effect.void,
      }),
      gateway,
    )
    expect(result._tag).toBe('Success')
    expect(stdout[0]).toContain('---\n')
    expect(stdout[0]).toContain('"version": 2')
    expect(stdout[0]).toContain('body text')
  })
})

describe('put', () => {
  it('round-trips a cat→put fixpoint with a matching base hash', async () => {
    const gateway = new FakeGateway({ title: 'Title', body: 'original' })
    const baseHash = editorBaseHash({ title: 'Title', body: 'original\n' })
    const result = await runWith(
      putEditorPage({
        pageId,
        buffer: '# Title\n\nedited body\n',
        baseHash,
        force: false,
      }),
      gateway,
    )
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') {
      expect(result.success.bodyWritten).toBe(true)
      expect(result.success.titleWritten).toBe(false)
    }
    expect(gateway.state.body).toBe('edited body\n')
    expect(gateway.markdownCalls).toHaveLength(1)
  })

  it('writes the title through the typed API when it changed (body first, title last)', async () => {
    const gateway = new FakeGateway({ title: 'Old', body: 'b' })
    const baseHash = editorBaseHash({ title: 'Old', body: 'b\n' })
    const result = await runWith(
      putEditorPage({ pageId, buffer: '# New\n\nb\n', baseHash, force: false }),
      gateway,
    )
    expect(result._tag).toBe('Success')
    expect(gateway.state.title).toBe('New')
    expect(gateway.metadataCalls).toHaveLength(1)
  })

  it('refuses a stale base hash with NmdConflictError (exit 7)', async () => {
    const gateway = new FakeGateway({ title: 'T', body: 'current' })
    const result = await runWith(
      putEditorPage({
        pageId,
        buffer: '# T\n\nnew\n',
        baseHash: editorBaseHash({ title: 'T', body: 'STALE\n' }),
        force: false,
      }),
      gateway,
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure._tag).toBe('NmdConflictError')
    // Nothing written on a guard refusal.
    expect(gateway.markdownCalls).toHaveLength(0)
  })

  it('refuses a missing title H1 (NmdInvalidDocumentError → exit 5)', async () => {
    const gateway = new FakeGateway({ title: 'T', body: 'b' })
    const result = await runWith(
      putEditorPage({ pageId, buffer: 'no heading here\n', force: true }),
      gateway,
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure._tag).toBe('NmdInvalidDocumentError')
  })

  it('--force bypasses the stale-base guard (concurrency-only)', async () => {
    const gateway = new FakeGateway({ title: 'T', body: 'current' })
    const result = await runWith(
      putEditorPage({ pageId, buffer: '# T\n\nforced\n', force: true }),
      gateway,
    )
    expect(result._tag).toBe('Success')
    expect(gateway.state.body).toBe('forced\n')
  })

  it('--force overwrites a remote that changed mid-flight (last-writer-wins, not a crash)', async () => {
    const gateway = new FakeGateway({ title: 'T', body: 'observed' })
    // After the initial observe pull, a concurrent writer changes the body.
    // A verified guard would *die* here; force must overwrite instead.
    gateway.concurrentlyChangeBodyOnce('someone-elses-edit')
    const result = await runWith(
      putEditorPage({ pageId, buffer: '# T\n\nmy forced body\n', force: true }),
      gateway,
    )
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') expect(result.success.bodyWritten).toBe(true)
    expect(gateway.state.body).toBe('my forced body\n')
  })

  it('reports a partial write (body landed, title failed) as NmdPartialWriteError → exit 10', async () => {
    const gateway = new FakeGateway({ title: 'Old', body: 'b' })
    gateway.failTitleWrite = true
    const baseHash = editorBaseHash({ title: 'Old', body: 'b\n' })
    const result = await runWith(
      // Title changes → triggers the title write, which is forced to fail.
      putEditorPage({ pageId, buffer: '# New\n\nedited\n', baseHash, force: false }),
      gateway,
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(result.failure._tag).toBe('NmdPartialWriteError')
      if (result.failure._tag === 'NmdPartialWriteError') {
        expect(result.failure.body_written).toBe(true)
        expect(result.failure.title_written).toBe(false)
      }
    }
    // The body write did land; the title did not.
    expect(gateway.state.body).toBe('edited\n')
    expect(gateway.state.title).toBe('Old')
  })

  it('refuses a lossy page even with --force (correctness, not concurrency)', async () => {
    const gateway = new FakeGateway({ title: 'T', body: 'b', completeness: lossyCompleteness })
    const result = await runWith(
      putEditorPage({ pageId, buffer: '# T\n\nx\n', force: true }),
      gateway,
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure._tag).toBe('NmdRemoteBodyLossyError')
  })
})
