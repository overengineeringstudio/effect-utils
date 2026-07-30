import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { editEditorPage } from './editor-commands.ts'
import { FakeGateway, harnessPageId as pageId, scriptedEditor } from './editor-test-harness.ts'
import type { NotionMdGateway } from './model.ts'
import { ProgressReporter, type ProgressReporterShape, type ProgressStage } from './progress.ts'
import { NmdStateStoreLive, type NmdStateStore } from './state-store.ts'

const stateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeServices.layer))

/** A captured progress event: the method that fired and the stage/note payload. */
type ProgressEvent =
  | { readonly kind: 'active' | 'succeed' | 'skip' | 'fail'; readonly stage: ProgressStage }
  | { readonly kind: 'note'; readonly message: string }

/** A `ProgressReporter` Layer that records every emitted transition for assertions. */
const capturingLayer = (sink: ProgressEvent[]): Layer.Layer<ProgressReporter> =>
  Layer.succeed(ProgressReporter, {
    stageActive: (stage) => Effect.sync(() => void sink.push({ kind: 'active', stage })),
    stageSucceed: (stage) => Effect.sync(() => void sink.push({ kind: 'succeed', stage })),
    stageSkip: (stage) => Effect.sync(() => void sink.push({ kind: 'skip', stage })),
    stageFail: (stage) => Effect.sync(() => void sink.push({ kind: 'fail', stage })),
    note: (message) => Effect.sync(() => void sink.push({ kind: 'note', message })),
  } satisfies ProgressReporterShape)

/** A `ProgressReporter` Layer whose every method defects/fails — proves emit swallows it. */
const hostileLayer: Layer.Layer<ProgressReporter> = Layer.succeed(ProgressReporter, {
  stageActive: () => Effect.die(new Error('hostile stageActive')),
  stageSucceed: () => Effect.fail(new Error('hostile stageSucceed') as never),
  stageSkip: () => Effect.die(new Error('hostile stageSkip')),
  stageFail: () => Effect.die(new Error('hostile stageFail')),
  note: () => Effect.die(new Error('hostile note')),
} satisfies ProgressReporterShape)

const runEdit = <A, E>(
  effect: Effect.Effect<A, E, NotionMdGateway | NmdStateStore | NodeContext.NodeContext>,
  gateway: FakeGateway,
  progressLayer?: Layer.Layer<ProgressReporter>,
) => {
  const base = Layer.mergeAll(gateway.layer, stateStoreLayer, NodeServices.layer)
  const layer = progressLayer === undefined ? base : Layer.merge(base, progressLayer)
  return Effect.either(effect).pipe(
    Effect.provide(layer as Layer.Layer<NotionMdGateway | NmdStateStore | NodeContext.NodeContext>),
    Effect.runPromise,
  )
}

const ids = (events: ProgressEvent[]): string[] =>
  events.map((e) => (e.kind === 'note' ? `note` : `${e.stage.id}:${e.kind}`))

describe('progress (staged write-path sync indicator)', () => {
  it('R45: the edit push result is identical with no / capturing / hostile reporter', async () => {
    const run = (progressLayer?: Layer.Layer<ProgressReporter>) => {
      const gateway = new FakeGateway({ title: 'Doc', body: 'original line' })
      return runEdit(
        editEditorPage({
          pageId,
          mode: 'default',
          pageRef: pageId,
          runEditor: scriptedEditor((b) => b.replace('original line', 'edited line')),
        }),
        gateway,
        progressLayer,
      ).then((result) => ({ result, body: gateway.state.body }))
    }

    const captured: ProgressEvent[] = []
    const none = await run(undefined)
    const capturing = await run(capturingLayer(captured))
    const hostile = await run(hostileLayer)

    // Byte-identical outcome + remote effect across all three reporter wirings.
    for (const r of [none, capturing, hostile]) {
      expect(r.result._tag).toBe('Right')
      if (r.result._tag === 'Right') {
        expect(r.result.right).toEqual({ pageId, outcome: 'pushed' })
      }
      expect(r.body).toBe('edited line\n')
    }
    // The hostile reporter (die/fail) never surfaced as a defect or changed the result.
    expect(captured.length).toBeGreaterThan(0)
  })

  it('emits observe → write-body → write-title → settle for a changed-buffer push', async () => {
    const gateway = new FakeGateway({ title: 'Doc', body: 'original line' })
    const events: ProgressEvent[] = []
    const result = await runEdit(
      editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((b) => b.replace('original line', 'edited line')),
      }),
      gateway,
      capturingLayer(events),
    )
    expect(result._tag).toBe('Right')
    // Body-only edit: title is unchanged, so write-title is a skip (no active/succeed).
    expect(ids(events)).toEqual([
      'observe:active',
      'observe:succeed',
      'write-body:active',
      'write-body:succeed',
      'write-title:skip',
      'settle:active',
      'settle:succeed',
    ])
  })

  it('emits write-title active+succeed when the title also changed', async () => {
    const gateway = new FakeGateway({ title: 'Old', body: 'original line' })
    const events: ProgressEvent[] = []
    await runEdit(
      editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((b) =>
          b.replace('# Old', '# New').replace('original line', 'edited line'),
        ),
      }),
      gateway,
      capturingLayer(events),
    )
    expect(ids(events)).toEqual([
      'observe:active',
      'observe:succeed',
      'write-body:active',
      'write-body:succeed',
      'write-title:active',
      'write-title:succeed',
      'settle:active',
      'settle:succeed',
    ])
  })

  it('warn: a remote-changed-but-auto-mergeable edit emits the auto-merge note', async () => {
    // Two-line base; the editor changes line 1, a concurrent remote writer changes
    // line 2 (a disjoint hunk) after the ephemeral pull → a clean 3-way auto-merge.
    const gateway = new FakeGateway({ title: 'Doc', body: 'line one\nline two' })
    gateway.switchRemoteBodyAfter(1, 'line one\nremote line two')
    const events: ProgressEvent[] = []
    const result = await runEdit(
      editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((b) => b.replace('line one', 'local line one')),
      }),
      gateway,
      capturingLayer(events),
    )
    expect(result._tag).toBe('Right')
    if (result._tag === 'Right') expect(result.right).toEqual({ pageId, outcome: 'pushed' })
    const notes = events.filter((e) => e.kind === 'note')
    expect(notes).toHaveLength(1)
    if (notes[0]?.kind === 'note') {
      expect(notes[0].message).toContain('auto-merged')
    }
    // The auto-merge body landed both hunks.
    expect(gateway.state.body).toBe('local line one\nremote line two\n')
  })

  it('warn: a conflicting edit emits the conflict note and returns the exit-7 conflict outcome', async () => {
    const gateway = new FakeGateway({ title: 'Doc', body: 'the original line' })
    // Remote changes the SAME line the editor edits → unmergeable → conflict.
    gateway.switchRemoteBodyAfter(1, 'a totally different remote line')
    const events: ProgressEvent[] = []
    // Run in a throwaway cwd: the durable `<page>.conflict.md` is written
    // relative to the process cwd (would otherwise land in the package root).
    const cwd = mkdtempSync(join(tmpdir(), 'notion-md-progress-conflict-'))
    const previousCwd = process.cwd()
    process.chdir(cwd)
    try {
      const result = await runEdit(
        editEditorPage({
          pageId,
          mode: 'default',
          pageRef: pageId,
          runEditor: scriptedEditor((b) =>
            b.replace('the original line', 'my local edit of that line'),
          ),
        }),
        gateway,
        capturingLayer(events),
      )
      expect(result._tag).toBe('Right')
      if (result._tag === 'Right') expect(result.right.outcome).toBe('conflict')
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
    const notes = events.filter((e) => e.kind === 'note')
    expect(notes).toHaveLength(1)
    if (notes[0]?.kind === 'note') {
      expect(notes[0].message).toContain('conflict draft')
      expect(notes[0].message).toContain(`${pageId}.conflict.md`)
    }
    // Conflict branch never reaches a body write → no write-body stage.
    expect(ids(events).some((id) => id.startsWith('write-body'))).toBe(false)
  })

  it('emits write-body active+fail and propagates the original error when the body write fails', async () => {
    const gateway = new FakeGateway({ title: 'Doc', body: 'original line' })
    gateway.failUpdateMarkdownOnce()
    const events: ProgressEvent[] = []
    const result = await runEdit(
      editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((b) => b.replace('original line', 'edited line')),
      }),
      gateway,
      capturingLayer(events),
    )
    // The wrapped stage failed: the engine error still propagates (Left), proving
    // `withStage`'s fail branch is observation-only and never swallows the error.
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left._tag).toBe('NmdGatewayError')
    expect(ids(events)).toEqual([
      'observe:active',
      'observe:succeed',
      'write-body:active',
      'write-body:fail',
    ])
    // The body write never landed.
    expect(gateway.state.body).toBe('original line\n')
  })
})
