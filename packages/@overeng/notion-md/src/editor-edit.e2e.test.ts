import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { NodeServices as NodeServicesEnv } from '@effect/platform-node/NodeServices'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import type { BodyCompleteness } from '@overeng/notion-core'

import { editEditorPage, editReadOnlyPage } from './editor-commands.ts'
import {
  FakeGateway,
  type FakeState,
  harnessPageId as pageId,
  pull,
  scriptedEditor,
} from './editor-test-harness.ts'
import { NmdGatewayError } from './errors.ts'
import { normalizeMarkdownLineEndings } from './hash.ts'
import { NotionMdGateway, type NotionMdGatewayShape } from './model.ts'
import { NmdStateStoreLive, type NmdStateStore } from './state-store.ts'

const stateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeServices.layer))

const runEdit = <A, E>(
  effect: Effect.Effect<A, E, NotionMdGateway | NmdStateStore | NodeServicesEnv>,
  gateway: FakeGateway,
) =>
  Effect.result(effect).pipe(
    Effect.provide(Layer.mergeAll(gateway.layer, stateStoreLayer, NodeServices.layer)),
    Effect.runPromise,
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
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') expect(result.success.outcome).toBe('pushed')
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
    expect(result._tag).toBe('Success')
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
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') expect(result.success.outcome).toBe('noop')
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
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure._tag).toBe('NmdEditorAbortedError')
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
      expect(result._tag).toBe('Success')
      if (result._tag === 'Success') {
        expect(result.success.outcome).toBe('conflict')
        expect(result.success.conflictPath).toBe(`${pageId}.conflict.md`)
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
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure._tag).toBe('NmdRemoteBodyLossyError')
  })
})

/**
 * A read-only fake gateway: every write path (`updateMarkdown`,
 * `updatePageMetadata`, `updatePageProperties`) `dieMessage`s, so any push/write
 * attempt crashes the test outright — the strongest proof that `--read-only`
 * never writes (stronger than asserting empty call arrays).
 */
class ReadOnlyFakeGateway {
  readonly state: FakeState
  pullCount = 0
  constructor(initial: { title: string; body: string; completeness?: BodyCompleteness }) {
    this.state = {
      title: initial.title,
      body: normalizeMarkdownLineEndings(initial.body),
      completeness: initial.completeness ?? { _tag: 'complete' },
    }
  }

  readonly layer = Layer.succeed(NotionMdGateway, {
    pullPage: () =>
      Effect.sync(() => {
        this.pullCount += 1
        return pull(this.state)
      }),
    updateMarkdown: () => Effect.die(new Error('read-only must never call updateMarkdown')),
    updatePageProperties: () => Effect.die(new Error('read-only must never call updatePageProperties')),
    retrieveDataSource: () => Effect.die(new Error('unexpected retrieveDataSource')),
    updatePageMetadata: () => Effect.die(new Error('read-only must never call updatePageMetadata')),
    listChildPages: () => Effect.succeed([]),
    createPage: () => Effect.die(new Error('unexpected createPage')),
    movePage: () => Effect.die(new Error('unexpected movePage')),
    archivePage: () => Effect.die(new Error('unexpected archivePage')),
  } satisfies NotionMdGatewayShape)
}

/** A scripted editor that records the buffer it saw and rewrites it; tracks cleanup. */
const recordingEditor = (opts: {
  readonly transform?: (buffer: string) => string
  readonly exitCode?: number
}) => {
  const seen: { buffer?: string; filePath?: string } = {}
  const run = (args: {
    readonly filePath: string
  }): Effect.Effect<number, NmdGatewayError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const buffer = yield* fs.readFileString(args.filePath)
      seen.buffer = buffer
      seen.filePath = args.filePath
      // Edit the buffer to prove the edits are discarded (never read back).
      yield* fs.writeFileString(
        args.filePath,
        (opts.transform ?? ((b) => `${b}\nlocal edit`))(buffer),
      )
      return opts.exitCode ?? 0
    }).pipe(
      Effect.mapError(
        (cause) =>
          new NmdGatewayError({ operation: 'recording_editor', message: String(cause), cause }),
      ),
    )
  return { seen, run }
}

const runReadOnly = <A, E>(
  effect: Effect.Effect<A, E, NotionMdGateway | NodeServicesEnv>,
  gateway: ReadOnlyFakeGateway,
) =>
  Effect.result(effect).pipe(
    // Deliberately NO stateStoreLayer: read-only's narrow R never needs it.
    Effect.provide(Layer.mergeAll(gateway.layer, NodeServices.layer)),
    Effect.runPromise,
  )

describe('edit --read-only (inspection-only session)', () => {
  it('presents the body, discards edits, and never calls any write gateway method', async () => {
    const gateway = new ReadOnlyFakeGateway({ title: 'Doc', body: 'original line' })
    const editor = recordingEditor({ transform: (b) => b.replace('original line', 'edited line') })
    const stderr: string[] = []
    const result = await runReadOnly(
      editReadOnlyPage({
        pageId,
        mode: 'default',
        writeStderr: (line) => Effect.sync(() => void stderr.push(line)),
        runEditor: editor.run,
      }),
      gateway,
    )
    // No write method was hit (else the gateway would have died, surfacing as a defect).
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') expect(result.success.outcome).toBe('read-only')
    // The editor saw the cat-style projection (`# title` + body).
    expect(editor.seen.buffer).toBe('# Doc\n\noriginal line\n')
    // Remote body is untouched; the local edit was discarded.
    expect(gateway.state.body).toBe('original line\n')
    expect(stderr).toEqual(['read-only: changes were not synced'])
  })

  it('cleans up the scoped temp tree after the session', async () => {
    const gateway = new ReadOnlyFakeGateway({ title: 'Doc', body: 'body' })
    const editor = recordingEditor({})
    const result = await runReadOnly(
      editReadOnlyPage({ pageId, mode: 'default', runEditor: editor.run }),
      gateway,
    )
    expect(result._tag).toBe('Success')
    // The buffer path lived under a scoped temp dir, reaped on scope close.
    const dir = dirname(editor.seen.filePath ?? '')
    expect(existsSync(dir)).toBe(false)
  })

  it('a non-zero editor exit is still a clean no-op (no abort, no push), exits read-only', async () => {
    const gateway = new ReadOnlyFakeGateway({ title: 'Doc', body: 'safe' })
    const editor = recordingEditor({ exitCode: 1 })
    const stderr: string[] = []
    const result = await runReadOnly(
      editReadOnlyPage({
        pageId,
        mode: 'default',
        writeStderr: (line) => Effect.sync(() => void stderr.push(line)),
        runEditor: editor.run,
      }),
      gateway,
    )
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') expect(result.success.outcome).toBe('read-only')
    expect(gateway.state.body).toBe('safe\n')
    expect(stderr).toEqual(['read-only: changes were not synced'])
  })

  it('--read-only --frontmatter inspects the full envelope read-only, still no writes', async () => {
    const gateway = new ReadOnlyFakeGateway({ title: 'Env', body: 'envelope body' })
    const editor = recordingEditor({})
    const result = await runReadOnly(
      editReadOnlyPage({ pageId, mode: 'frontmatter', runEditor: editor.run }),
      gateway,
    )
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') expect(result.success.outcome).toBe('read-only')
    // The editor saw the full strict `.nmd` envelope, not the `# title` form.
    expect(editor.seen.buffer).toContain('---\n')
    expect(editor.seen.buffer).toContain('"version": 2')
    expect(editor.seen.buffer).toContain('envelope body')
  })

  it('refuses a lossy page at observe time (exit 3); the editor is never launched', async () => {
    const gateway = new ReadOnlyFakeGateway({
      title: 'Doc',
      body: 'body',
      completeness: {
        _tag: 'lossy',
        reasons: ['not_round_trip_safe_blocks'],
        lossyBlockTypes: ['synced_block'],
      },
    })
    const editor = recordingEditor({})
    const result = await runReadOnly(
      editReadOnlyPage({ pageId, mode: 'default', runEditor: editor.run }),
      gateway,
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure._tag).toBe('NmdRemoteBodyLossyError')
    // Refused before any editor launch.
    expect(editor.seen.buffer).toBeUndefined()
  })
})
