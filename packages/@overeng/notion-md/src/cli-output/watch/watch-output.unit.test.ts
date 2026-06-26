import { describe, expect, it } from 'vitest'

import { toWatchAction } from './map.ts'
import { type WatchAction, type WatchState, initialWatchState, watchReducer } from './schema.ts'

/** Fold a sequence of actions onto the initial state. */
const fold = (target: string, actions: readonly WatchAction[]): WatchState =>
  actions.reduce((state, action) => watchReducer({ state, action }), initialWatchState(target))

describe('toWatchAction (emit-event → WatchAction seam)', () => {
  it('maps a single-file sync result to a Single outcome', () => {
    expect(
      toWatchAction({ event: 'sync', reason: 'file', result: { _tag: 'pushed', path: 'a.nmd' } }),
    ).toEqual({ _tag: 'WatchPass', reason: 'file', result: { _tag: 'Single', outcome: 'pushed' } })
  })

  it('synthesizes conflict from a single-file NmdConflictError sync_error', () => {
    const action = toWatchAction({
      event: 'sync_error',
      reason: 'poll',
      error: { _tag: 'NmdConflictError', message: 'both changed' },
    })
    expect(action).toMatchObject({
      _tag: 'WatchPass',
      reason: 'poll',
      result: { _tag: 'Single', outcome: 'conflict' },
    })
  })

  it('maps a genuine single-file failure to a Failure result', () => {
    const action = toWatchAction({
      event: 'sync_error',
      reason: 'poll',
      error: { _tag: 'NmdGatewayError', message: 'timed out' },
    })
    expect(action).toMatchObject({
      _tag: 'WatchPass',
      result: { _tag: 'Failure', message: 'timed out' },
    })
  })

  it('classifies a batch pass per item, reclassifying wrapped conflicts', () => {
    // A per-file conflict reaches the batch as a `BatchFailure` wrapping
    // `NmdConflictError` — it must count as `conflict`, not the generic `error`.
    const action = toWatchAction({
      event: 'sync',
      reason: 'batch',
      paths: ['a.nmd', 'b.nmd', 'c.nmd'],
      result: {
        _tag: 'batch',
        items: [
          { _tag: 'success', result: { _tag: 'pushed' } },
          { _tag: 'error', error: { _tag: 'NmdConflictError', message: 'conflict' } },
          { _tag: 'error', error: { _tag: 'NmdGatewayError', message: 'boom' } },
        ],
      },
    })
    expect(action).toMatchObject({
      _tag: 'WatchPass',
      reason: 'batch',
      result: { _tag: 'Batch', outcomes: ['pushed', 'conflict', 'error'] },
    })
  })

  it('surfaces a watch_error as a failed pass', () => {
    const action = toWatchAction({
      event: 'watch_error',
      path: '/tmp/dir',
      error: { _tag: 'NmdFileSystemError', message: 'EACCES' },
    })
    expect(action).toMatchObject({ _tag: 'WatchPass', result: { _tag: 'Failure' } })
  })

  it('ignores non-pass events', () => {
    expect(toWatchAction({ event: 'unknown' })).toBeUndefined()
    expect(toWatchAction(null)).toBeUndefined()
  })
})

describe('watchReducer (counter + ring folding)', () => {
  it('accumulates counters and caps the recent-events ring at 5 (newest retained)', () => {
    const passes: readonly WatchAction[] = [
      { _tag: 'Init', target: 'a.nmd', pollIntervalMs: 2000 },
      { _tag: 'WatchPass', reason: 'initial', result: { _tag: 'Single', outcome: 'pulled' } },
      { _tag: 'WatchPass', reason: 'file', result: { _tag: 'Single', outcome: 'pushed' } },
      { _tag: 'WatchPass', reason: 'poll', result: { _tag: 'Single', outcome: 'noop' } },
      { _tag: 'WatchPass', reason: 'poll', result: { _tag: 'Single', outcome: 'noop' } },
      { _tag: 'WatchPass', reason: 'file', result: { _tag: 'Single', outcome: 'pushed' } },
      { _tag: 'WatchPass', reason: 'poll', result: { _tag: 'Single', outcome: 'noop' } },
    ]
    const state = fold('a.nmd', passes)

    expect(state.pollIntervalMs).toBe(2000)
    expect(state.active).toBe(true)
    // 6 passes total: 2 pushed, 1 pulled, 3 noop.
    expect(state.counters).toEqual({ pushed: 2, pulled: 1, noop: 3, conflict: 0, error: 0 })
    // Ring keeps the last 5 passes (the initial `pulled` dropped).
    expect(state.recentEvents).toHaveLength(5)
    expect(state.recentEvents.map((event) => event.label)).toEqual([
      'pushed',
      'noop',
      'noop',
      'pushed',
      'noop',
    ])
    expect(state.lastResult).toMatchObject({ reason: 'poll', label: 'noop', problem: false })
  })

  it('bumps the conflict counter and flags the last result as a problem', () => {
    const state = fold('a.nmd', [
      { _tag: 'Init', target: 'a.nmd', pollIntervalMs: 1000 },
      { _tag: 'WatchPass', reason: 'initial', result: { _tag: 'Single', outcome: 'pushed' } },
      {
        _tag: 'WatchPass',
        reason: 'file',
        result: { _tag: 'Single', outcome: 'conflict' },
        detail: 'both changed',
      },
    ])
    expect(state.counters.conflict).toBe(1)
    expect(state.lastResult).toMatchObject({ problem: true, detail: 'both changed' })
  })

  it('bumps shared counters once per page for a batch pass', () => {
    const state = fold('3 targets', [
      { _tag: 'Init', target: '3 targets', pollIntervalMs: 5000 },
      {
        _tag: 'WatchPass',
        reason: 'batch',
        result: { _tag: 'Batch', outcomes: ['pushed', 'pushed', 'conflict'] },
      },
    ])
    expect(state.counters).toEqual({ pushed: 2, pulled: 0, noop: 0, conflict: 1, error: 0 })
    expect(state.recentEvents[0]?.label).toBe('2 pushed · 1 conflict')
  })
})
