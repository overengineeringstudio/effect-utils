import { describe, expect, it } from 'vitest'

import type {
  InspectorSnapshotFrame,
  RequestIdentity,
  RpcRecord,
} from '@overeng/effect-rpc-explorer'

import {
  applyDelta,
  createExplorerProjectionStore,
  initialExplorerProjection,
  projectionFromSnapshot,
  recordIdentityKey,
  reduceFrame,
  type ExplorerClient,
} from './projection.ts'

const numberIdentity: RequestIdentity = {
  observerSide: 'client',
  connectionId: 'connection-a',
  direction: 'clientToServer',
  requestId: { _tag: 'Number', value: 1 },
}

const stringIdentity: RequestIdentity = {
  ...numberIdentity,
  requestId: { _tag: 'String', value: '1' },
}

const record: RpcRecord = {
  key: numberIdentity,
  descriptorId: 'rpc:Lookup',
  state: 'awaiting',
  notification: false,
  startedAt: { monotonicNanos: '1000', wallClockMillis: 1 },
  lastAt: { monotonicNanos: '1000', wallClockMillis: 1 },
  send: 'sent',
  chunkEnvelopes: 0,
  streamValues: 0,
  retainedStreamValues: 0,
  events: [],
  evidence: [],
}

const snapshot: InspectorSnapshotFrame = {
  _tag: 'Snapshot',
  protocolVersion: 'rpc-explorer.v1',
  instanceId: 'projection-test',
  revision: 4,
  descriptors: [],
  active: [record],
  completed: [],
  events: [],
  counters: {
    activeEvicted: 0,
    completedEvicted: 0,
    streamValuesTruncated: 0,
    subscriberResets: 0,
  },
}

describe('explorer client projection', () => {
  it('preserves the full typed identity in stable record keys', () => {
    expect(recordIdentityKey(numberIdentity)).not.toBe(recordIdentityKey(stringIdentity))
    expect(recordIdentityKey({ ...numberIdentity, observerSide: 'server' })).not.toBe(
      recordIdentityKey(numberIdentity),
    )
  })

  it('applies a contiguous delta transaction without mutating the prior revision', () => {
    const before = projectionFromSnapshot(snapshot)
    const completed = { ...record, state: 'succeeded' as const }
    const result = applyDelta({
      state: before,
      frame: {
        _tag: 'Delta',
        protocolVersion: 'rpc-explorer.v1',
        fromRevision: 4,
        toRevision: 5,
        operations: [{ _tag: 'UpsertRecord', bucket: 'completed', record: completed }],
      },
    })

    expect(result._tag).toBe('applied')
    if (result._tag !== 'applied') return
    expect(result.projection.revision).toBe(5)
    expect(result.projection.active.size).toBe(0)
    expect(result.projection.completed.get(recordIdentityKey(numberIdentity))?.state).toBe(
      'succeeded',
    )
    expect(before.revision).toBe(4)
    expect(before.active.get(recordIdentityKey(numberIdentity))?.state).toBe('awaiting')
  })

  it('rejects revision gaps and unknown operation targets atomically', () => {
    const before = projectionFromSnapshot(snapshot)
    expect(
      applyDelta({
        state: before,
        frame: {
          _tag: 'Delta',
          protocolVersion: 'rpc-explorer.v1',
          fromRevision: 3,
          toRevision: 5,
          operations: [],
        },
      }),
    ).toEqual({ _tag: 'recover', reason: 'revision-gap' })

    const unknownRemoval = applyDelta({
      state: before,
      frame: {
        _tag: 'Delta',
        protocolVersion: 'rpc-explorer.v1',
        fromRevision: 4,
        toRevision: 5,
        operations: [{ _tag: 'RemoveEvent', eventId: 99 }],
      },
    })
    expect(unknownRemoval).toEqual({ _tag: 'recover', reason: 'unknown-target' })
    expect(before.revision).toBe(4)
    expect(before.active.size).toBe(1)
  })

  it('marks resets stale and only replaces the complete model with a snapshot', () => {
    const live = projectionFromSnapshot(snapshot)
    const reset = reduceFrame({
      state: live,
      frame: {
        _tag: 'Reset',
        protocolVersion: 'rpc-explorer.v1',
        reason: 'cleared',
        revision: 5,
      },
    })
    expect(reset._tag).toBe('applied')
    if (reset._tag !== 'applied') return
    expect(reset.projection.stale).toBe(true)
    expect(reset.projection.revision).toBe(4)

    const replaced = reduceFrame({
      state: reset.projection,
      frame: { ...snapshot, revision: 5, active: [] },
    })
    expect(replaced._tag).toBe('applied')
    if (replaced._tag !== 'applied') return
    expect(replaced.projection.stale).toBe(false)
    expect(replaced.projection.revision).toBe(5)
    expect(replaced.projection.active.size).toBe(0)
    expect(replaced.projection.resetReason).toBe('cleared')
  })

  it('never applies a delta while the projection is stale', () => {
    const result = applyDelta({
      state: initialExplorerProjection,
      frame: {
        _tag: 'Delta',
        protocolVersion: 'rpc-explorer.v1',
        fromRevision: 0,
        toRevision: 1,
        operations: [],
      },
    })
    expect(result).toEqual({ _tag: 'recover', reason: 'revision-gap' })
  })

  it('keeps clear history stale until the clear response and Reset/Snapshot boundary', async () => {
    const initial = {
      ...snapshot,
      active: [],
      completed: [{ ...record, state: 'succeeded' as const }],
    }
    const clearResponse = Promise.withResolvers<unknown>()
    const queued: Array<{
      readonly frame: unknown
      readonly consumed: PromiseWithResolvers<void>
    }> = []
    const waiting: Array<PromiseWithResolvers<IteratorResult<unknown>>> = []
    let priorConsumed: PromiseWithResolvers<void> | undefined
    let closed = false

    const iterator: AsyncIterator<unknown> = {
      next: () => {
        priorConsumed?.resolve()
        priorConsumed = undefined
        const entry = queued.shift()
        if (entry !== undefined) {
          priorConsumed = entry.consumed
          return Promise.resolve({ done: false, value: entry.frame })
        }
        if (closed === true) return Promise.resolve({ done: true, value: undefined })
        const pending = Promise.withResolvers<IteratorResult<unknown>>()
        waiting.push(pending)
        return pending.promise
      },
      return: () => {
        closed = true
        priorConsumed?.resolve()
        priorConsumed = undefined
        for (const pending of waiting.splice(0)) {
          pending.resolve({ done: true, value: undefined })
        }
        for (const entry of queued.splice(0)) entry.consumed.resolve()
        return Promise.resolve({ done: true, value: undefined })
      },
    }
    const push = (frame: unknown): Promise<void> => {
      const consumed = Promise.withResolvers<void>()
      const pending = waiting.shift()
      if (pending === undefined) {
        queued.push({ frame, consumed })
      } else {
        priorConsumed = consumed
        pending.resolve({ done: false, value: frame })
      }
      return consumed.promise
    }

    let snapshotReads = 0
    const client: ExplorerClient = {
      getSnapshot: async () => {
        snapshotReads += 1
        return initial
      },
      watch: () => ({ [Symbol.asyncIterator]: () => iterator }),
      clearHistory: () => clearResponse.promise,
    }
    const store = createExplorerProjectionStore(client)
    const connected = Promise.withResolvers<void>()
    const cleared = Promise.withResolvers<void>()
    const unsubscribe = store.subscribe(() => {
      const current = store.getSnapshot()
      if (current.connection._tag === 'live' && current.revision === 4) connected.resolve()
      if (current.stale === false && current.revision === 7) cleared.resolve()
    })
    await connected.promise

    const clearing = store.clearHistory()
    await push({
      _tag: 'Delta',
      protocolVersion: 'rpc-explorer.v1',
      fromRevision: 4,
      toRevision: 5,
      operations: [],
    })
    expect(snapshotReads).toBe(1)
    expect(store.getSnapshot().stale).toBe(true)
    expect(store.getSnapshot().completed.size).toBe(1)

    await push({
      _tag: 'Reset',
      protocolVersion: 'rpc-explorer.v1',
      reason: 'cleared',
      revision: 6,
    })
    await push({ ...initial, revision: 6, completed: [] })
    await push({
      _tag: 'Delta',
      protocolVersion: 'rpc-explorer.v1',
      fromRevision: 6,
      toRevision: 7,
      operations: [],
    })
    expect(store.getSnapshot().stale).toBe(true)
    expect(store.getSnapshot().completed.size).toBe(1)

    clearResponse.resolve(undefined)
    await clearing
    await cleared.promise
    expect(store.getSnapshot().completed.size).toBe(0)
    expect(store.getSnapshot().resetReason).toBe('cleared')

    unsubscribe()
  })
})
