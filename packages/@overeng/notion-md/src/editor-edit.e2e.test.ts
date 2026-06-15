import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import type { BodyCompleteness } from '@overeng/notion-core'

import { editEditorPage } from './editor-commands.ts'
import { NmdGatewayError } from './errors.ts'
import { normalizeMarkdownLineEndings } from './hash.ts'
import {
  NotionMdGateway,
  type NotionMdGatewayShape,
  type PullPageResult,
  type RemotePageSnapshot,
} from './model.ts'
import { NmdStateStoreLive, type NmdStateStore } from './state-store.ts'

const pageId = '00000000-0000-4000-8000-000000000001'

interface FakeState {
  title: string
  body: string
  completeness: BodyCompleteness
}

const snapshot = (s: FakeState): RemotePageSnapshot => ({
  id: pageId,
  title: s.title,
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

const pull = (s: FakeState): PullPageResult => ({
  page: snapshot(s),
  markdown: {
    markdown: normalizeMarkdownLineEndings(s.body),
    truncated: false,
    unknown_block_ids: [],
    completeness: s.completeness,
  },
  storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
})

class FakeGateway {
  readonly state: FakeState
  /** When set, the remote body switches to `body` after `afterPull` pulls. */
  private switchBodyOnPull: { afterPull: number; body: string } | undefined
  pullCount = 0
  constructor(initial: { title: string; body: string; completeness?: BodyCompleteness }) {
    this.state = {
      title: initial.title,
      body: normalizeMarkdownLineEndings(initial.body),
      completeness: initial.completeness ?? { _tag: 'complete' },
    }
  }

  /** Simulate a concurrent remote writer: after `afterPull` pulls, body becomes `body`. */
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

const stateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer))

const runEdit = <A, E>(
  effect: Effect.Effect<A, E, NotionMdGateway | NmdStateStore | NodeContext.NodeContext>,
  gateway: FakeGateway,
) =>
  Effect.either(effect).pipe(
    Effect.provide(Layer.mergeAll(gateway.layer, stateStoreLayer, NodeContext.layer)),
    Effect.runPromise,
  )

/** A scripted non-interactive editor: rewrite the buffer file via a transform. */
const scriptedEditor =
  (transform: (buffer: string) => string, exitCode = 0) =>
  (opts: {
    readonly filePath: string
  }): Effect.Effect<number, NmdGatewayError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      if (exitCode === 0) {
        const buffer = yield* fs.readFileString(opts.filePath)
        yield* fs.writeFileString(opts.filePath, transform(buffer))
      }
      return exitCode
    }).pipe(
      Effect.mapError(
        (cause) =>
          new NmdGatewayError({ operation: 'scripted_editor', message: String(cause), cause }),
      ),
    )

describe('edit (ephemeral file-engine session)', () => {
  it('round-trips a default-mode body edit through the engine and cleans up', async () => {
    const gateway = new FakeGateway({ title: 'Doc', body: 'original line' })
    const result = await runEdit(
      editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((buffer) => buffer.replace('original line', 'edited line')),
      }),
      gateway,
    )
    expect(result._tag).toBe('Right')
    if (result._tag === 'Right') expect(result.right.outcome).toBe('pushed')
    expect(gateway.state.body).toBe('edited line\n')
  })

  it('splices a title edit through the typed page API', async () => {
    const gateway = new FakeGateway({ title: 'Old Title', body: 'body' })
    const result = await runEdit(
      editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((buffer) => buffer.replace('# Old Title', '# New Title')),
      }),
      gateway,
    )
    expect(result._tag).toBe('Right')
    expect(gateway.state.title).toBe('New Title')
  })

  it('no-ops on an unchanged buffer (nothing pushed)', async () => {
    const gateway = new FakeGateway({ title: 'Doc', body: 'unchanged' })
    const result = await runEdit(
      editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((buffer) => buffer),
      }),
      gateway,
    )
    expect(result._tag).toBe('Right')
    if (result._tag === 'Right') expect(result.right.outcome).toBe('noop')
    expect(gateway.state.body).toBe('unchanged\n')
  })

  it('aborts with NmdEditorAbortedError (exit 8) on a non-zero editor exit; nothing pushed', async () => {
    const gateway = new FakeGateway({ title: 'Doc', body: 'safe' })
    const result = await runEdit(
      editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((buffer) => buffer.replace('safe', 'should-not-land'), 1),
      }),
      gateway,
    )
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left._tag).toBe('NmdEditorAbortedError')
    expect(gateway.state.body).toBe('safe\n')
  })

  it('relocates a conflict to a durable <page>.conflict.md when the remote changed concurrently', async () => {
    // Base body established by the ephemeral pull (pull #1). The editor changes
    // the line locally; a concurrent remote writer changes the SAME line after
    // pull #1, so the engine cannot 3-way merge → NmdConflictError with a
    // roughdraft path, which `edit` relocates out of $TMPDIR to the cwd.
    const gateway = new FakeGateway({ title: 'Doc', body: 'the original line' })
    gateway.switchRemoteBodyAfter(1, 'a totally different remote line')

    // Run in a throwaway cwd: the durable `<page>.conflict.md` is written
    // relative to the process cwd (would otherwise land in the package root).
    const cwd = mkdtempSync(join(tmpdir(), 'notion-md-conflict-'))
    const previousCwd = process.cwd()
    process.chdir(cwd)
    try {
      const result = await runEdit(
        editEditorPage({
          pageId,
          mode: 'default',
          pageRef: pageId,
          runEditor: scriptedEditor((buffer) =>
            buffer.replace('the original line', 'my local edit of that line'),
          ),
        }),
        gateway,
      )
      expect(result._tag).toBe('Right')
      if (result._tag === 'Right') {
        expect(result.right.outcome).toBe('conflict')
        expect(result.right.conflictPath).toBe(`${pageId}.conflict.md`)
        // The durable conflict file exists and carries all three bodies so the
        // edit is recoverable (the $TMPDIR roughdraft is already reaped).
        const durable = readFileSync(join(cwd, `${pageId}.conflict.md`), 'utf8')
        expect(durable).toContain('the original line')
        expect(durable).toContain('my local edit of that line')
        expect(durable).toContain('a totally different remote line')
      }
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refuses a lossy page at the ephemeral pull (exit 3)', async () => {
    const gateway = new FakeGateway({
      title: 'Doc',
      body: 'body',
      completeness: {
        _tag: 'lossy',
        reasons: ['not_round_trip_safe_blocks'],
        lossyBlockTypes: ['synced_block'],
      },
    })
    const result = await runEdit(
      editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((buffer) => `${buffer}\nmore`),
      }),
      gateway,
    )
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left._tag).toBe('NmdRemoteBodyLossyError')
  })
})
