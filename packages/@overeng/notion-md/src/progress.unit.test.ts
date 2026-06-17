import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeContext } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import type { EditAction } from './cli-output/edit/schema.ts'
import { editReducer, initialEditState } from './cli-output/edit/schema.ts'
import { progressReporterTui } from './cli-output/progress-bridge.ts'
import { editEditorPage } from './editor-commands.ts'
import { FakeGateway, harnessPageId as pageId, scriptedEditor } from './editor-test-harness.ts'
import type { NotionMdGateway } from './model.ts'
import type { ProgressReporter } from './progress.ts'
import { NmdStateStoreLive, type NmdStateStore } from './state-store.ts'

const stateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer))

/**
 * A `dispatch` that records every `EditAction` the bridge emits, plus the
 * `SetResult` the handler appends. The bridge is the unit under test: it turns
 * the engine's `ProgressReporter` calls into the `edit` action stream.
 */
const capturingDispatch = (): {
  readonly dispatch: (action: EditAction) => void
  readonly actions: EditAction[]
} => {
  const actions: EditAction[] = []
  return { dispatch: (action) => void actions.push(action), actions }
}

/** A bridge whose dispatch dies/throws — proves emit (R45) swallows it. */
const hostileBridge: Layer.Layer<ProgressReporter> = progressReporterTui(() => {
  throw new Error('hostile dispatch')
})

const runEdit = <A, E>(
  effect: Effect.Effect<A, E, NotionMdGateway | NmdStateStore | NodeContext.NodeContext>,
  gateway: FakeGateway,
  progressLayer?: Layer.Layer<ProgressReporter>,
) => {
  const base = Layer.mergeAll(gateway.layer, stateStoreLayer, NodeContext.layer)
  const layer = progressLayer === undefined ? base : Layer.merge(base, progressLayer)
  return Effect.either(effect).pipe(
    Effect.provide(layer as Layer.Layer<NotionMdGateway | NmdStateStore | NodeContext.NodeContext>),
    Effect.runPromise,
  )
}

/** Compact view of the dispatched stage/note/terminal actions, for assertions. */
const tags = (actions: EditAction[]): string[] =>
  actions.map((action) => {
    switch (action._tag) {
      case 'StageActive':
        return `${action.id}:active`
      case 'StageSucceed':
        return `${action.id}:succeed`
      case 'StageSkip':
        return `${action.id}:skip`
      case 'StageFail':
        return `${action.id}:fail`
      case 'Note':
        return 'note'
      case 'SetResult':
        return `result:${action.result.outcome}`
      case 'SetError':
        return 'error'
    }
  })

/** Fold the captured action stream through the reducer to the final view state. */
const foldState = (page: string, actions: EditAction[]) =>
  actions.reduce((state, action) => editReducer({ state, action }), initialEditState(page))

describe('progress bridge (ProgressReporter → tui.dispatch)', () => {
  it('R45: the edit push result is identical with no / capturing / hostile bridge', async () => {
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

    const captured = capturingDispatch()
    const none = await run(undefined)
    const capturing = await run(progressReporterTui(captured.dispatch))
    const hostile = await run(hostileBridge)

    for (const r of [none, capturing, hostile]) {
      expect(r.result._tag).toBe('Right')
      if (r.result._tag === 'Right') {
        expect(r.result.right).toEqual({ pageId, outcome: 'pushed' })
      }
      expect(r.body).toBe('edited line\n')
    }
    // The hostile bridge (throwing dispatch) never surfaced or changed the result.
    expect(captured.actions.length).toBeGreaterThan(0)
  })

  it('dispatches observe → write-body → (skip title) → settle → SetResult for a changed-buffer push', async () => {
    const gateway = new FakeGateway({ title: 'Doc', body: 'original line' })
    const captured = capturingDispatch()
    const result = await runEdit(
      editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((b) => b.replace('original line', 'edited line')),
      }),
      gateway,
      progressReporterTui(captured.dispatch),
    )
    expect(result._tag).toBe('Right')
    // The handler appends SetResult after the engine returns; emulate that here so
    // the captured stream is the full action sequence the CLI would dispatch.
    if (result._tag === 'Right') captured.dispatch({ _tag: 'SetResult', result: result.right })

    // Body-only edit: title unchanged → write-title is a skip (no active/succeed).
    expect(tags(captured.actions)).toEqual([
      'observe:active',
      'observe:succeed',
      'write-body:active',
      'write-body:succeed',
      'write-title:skip',
      'settle:active',
      'settle:succeed',
      'result:pushed',
    ])

    // The reducer folds the stream into a terminal Success with settled stages.
    const state = foldState(pageId, captured.actions)
    expect(state._tag).toBe('Success')
    if (state._tag === 'Success') {
      expect(state.noChange).toBe(false)
      expect(state.stages.map((s) => `${s.id}:${s.status}`)).toEqual([
        'observe:success',
        'write-body:success',
        'write-title:skipped',
        'settle:success',
      ])
    }
  })

  it('dispatches a Note (→ WARNING ProblemItem) for an auto-merged push', async () => {
    const gateway = new FakeGateway({ title: 'Doc', body: 'line one\nline two' })
    gateway.switchRemoteBodyAfter(1, 'line one\nremote line two')
    const captured = capturingDispatch()
    const result = await runEdit(
      editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((b) => b.replace('line one', 'local line one')),
      }),
      gateway,
      progressReporterTui(captured.dispatch),
    )
    expect(result._tag).toBe('Right')
    if (result._tag === 'Right') captured.dispatch({ _tag: 'SetResult', result: result.right })

    const notes = captured.actions.filter((a) => a._tag === 'Note')
    expect(notes).toHaveLength(1)
    if (notes[0]?._tag === 'Note') expect(notes[0].message).toContain('auto-merged')

    const state = foldState(pageId, captured.actions)
    expect(state.warnings).toHaveLength(1)
    expect(state.warnings[0]?.severity).toBe('warning')
    expect(state.warnings[0]?.fixes.length).toBeGreaterThan(0)
  })

  it('dispatches the conflict Note + SetResult(conflict) → terminal Conflict state', async () => {
    const gateway = new FakeGateway({ title: 'Doc', body: 'the original line' })
    gateway.switchRemoteBodyAfter(1, 'a totally different remote line')
    const captured = capturingDispatch()
    const cwd = mkdtempSync(join(tmpdir(), 'notion-md-bridge-conflict-'))
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
        progressReporterTui(captured.dispatch),
      )
      expect(result._tag).toBe('Right')
      if (result._tag === 'Right') {
        expect(result.right.outcome).toBe('conflict')
        captured.dispatch({ _tag: 'SetResult', result: result.right })
      }
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }

    const notes = captured.actions.filter((a) => a._tag === 'Note')
    expect(notes).toHaveLength(1)
    if (notes[0]?._tag === 'Note') {
      expect(notes[0].message).toContain('conflict draft')
      expect(notes[0].message).toContain(`${pageId}.conflict.md`)
    }
    // Conflict never reaches a body write → no write-body stage dispatched.
    expect(tags(captured.actions).some((t) => t.startsWith('write-body'))).toBe(false)

    const state = foldState(pageId, captured.actions)
    expect(state._tag).toBe('Conflict')
    if (state._tag === 'Conflict') {
      expect(state.conflictPath).toBe(`${pageId}.conflict.md`)
      // The conflict warning carries the durable path as an actionable fix.
      expect(state.warnings[0]?.fixes[0]).toContain(`${pageId}.conflict.md`)
    }
  })

  it('dispatches write-body active+fail and propagates the original error on a body-write failure', async () => {
    const gateway = new FakeGateway({ title: 'Doc', body: 'original line' })
    gateway.failUpdateMarkdownOnce()
    const captured = capturingDispatch()
    const result = await runEdit(
      editEditorPage({
        pageId,
        mode: 'default',
        pageRef: pageId,
        runEditor: scriptedEditor((b) => b.replace('original line', 'edited line')),
      }),
      gateway,
      progressReporterTui(captured.dispatch),
    )
    // The wrapped stage failed: the engine error still propagates (Left), proving
    // the bridge's fail dispatch is observation-only and never swallows the error.
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left._tag).toBe('NmdGatewayError')
    expect(tags(captured.actions)).toEqual([
      'observe:active',
      'observe:succeed',
      'write-body:active',
      'write-body:fail',
    ])
    expect(gateway.state.body).toBe('original line\n')
  })
})
