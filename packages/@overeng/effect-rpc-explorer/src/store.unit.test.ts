import { Duration } from 'effect'
import { describe, expect, it } from 'vitest'

import type {
  ChannelObservation,
  ExplorerBounds,
  ExplorerEventInput,
  RequestIdentity,
  Timestamp,
} from './model.ts'
import { UnknownDescriptorId } from './model.ts'
import { applyCapturePolicy, defaultNormalizationBounds } from './policy.ts'
import { makeExplorerStore } from './store.ts'

type RequestObservedInput = Extract<ExplorerEventInput, { readonly _tag: 'RequestObserved' }>
type TerminalObservedInput = Extract<ExplorerEventInput, { readonly _tag: 'TerminalObserved' }>

const at = (value: number): Timestamp => ({
  monotonicNanos: String(value * 1_000_000),
  wallClockMillis: value,
})

const request = (requestId: string | number, connectionId = 'connection-a'): RequestIdentity => ({
  observerSide: 'client',
  connectionId,
  direction: 'clientToServer',
  requestId:
    typeof requestId === 'string'
      ? { _tag: 'String', value: requestId }
      : { _tag: 'Number', value: requestId },
})

const bounds = (overrides: Partial<ExplorerBounds> = {}): ExplorerBounds => ({
  active: { maxCount: 16, maxAge: Duration.millis(10_000) },
  completed: { maxCount: 16, maxAge: Duration.millis(10_000) },
  streamValuesPerRecord: 16,
  normalized: defaultNormalizationBounds,
  deltas: { maxCount: 16, maxAge: Duration.millis(10_000) },
  subscriberQueue: 16,
  ...overrides,
})

const requestObserved = (
  key: RequestIdentity,
  time: number,
  notification = false,
): RequestObservedInput => ({
  _tag: 'RequestObserved',
  at: at(time),
  request: key,
  descriptorId: 'rpc:example',
  notification,
  observations: [],
})

const terminal = (
  key: RequestIdentity,
  time: number,
  outcome: 'success' | 'typedFailure' | 'defect' | 'interrupted',
): TerminalObservedInput => ({
  _tag: 'TerminalObserved',
  at: at(time),
  request: key,
  outcome,
  observations: [],
})

const captured = (value: string): ChannelObservation => ({
  channel: 'streamElement',
  outcome: { _tag: 'Captured', mode: 'reveal', source: 'host' },
  captured: { _tag: 'String', value },
})

describe('explorer store lifecycle', () => {
  it('keeps numeric and string request identifiers distinct', () => {
    const store = makeExplorerStore({ instanceId: 'instance', bounds: bounds() })

    store.dispatch(requestObserved(request(1), 1))
    store.dispatch(requestObserved(request('1'), 2))

    const snapshot = store.snapshot()
    expect(snapshot.active).toHaveLength(2)
    expect(snapshot.active.map((record) => record.key.requestId._tag).toSorted()).toEqual([
      'Number',
      'String',
    ])
  })

  it('preserves the first terminal outcome and turns a later terminal into content-free evidence', () => {
    const store = makeExplorerStore({ instanceId: 'instance', bounds: bounds() })
    const key = request(1)

    store.dispatch(requestObserved(key, 1))
    store.dispatch(terminal(key, 2, 'success'))
    store.dispatch({
      ...terminal(key, 3, 'defect'),
      observations: [captured('late-content-must-be-dropped')],
    })

    const snapshot = store.snapshot()
    expect(snapshot.completed).toHaveLength(1)
    expect(snapshot.completed[0]?.state).toBe('succeeded')
    expect(snapshot.completed[0]?.evidence).toContainEqual({
      _tag: 'LateEvent',
      eventTag: 'TerminalObserved',
    })
    expect(JSON.stringify(snapshot)).not.toContain('late-content-must-be-dropped')
  })

  it('fans one uncorrelated connection fault out to every active request on that connection', () => {
    const store = makeExplorerStore({ instanceId: 'instance', bounds: bounds() })
    store.dispatch(requestObserved(request(1), 1))
    store.dispatch(requestObserved(request(2), 2))
    store.dispatch(requestObserved(request(3, 'connection-b'), 3))

    const event = store.dispatch({
      _tag: 'ConnectionFault',
      at: at(4),
      connectionId: 'connection-a',
      fault: 'disconnect',
      faultId: 'fault-1',
    })

    const snapshot = store.snapshot()
    expect(event?._tag).toBe('ConnectionFault')
    expect(snapshot.completed.map((record) => record.state)).toEqual(['uncertain', 'uncertain'])
    expect(snapshot.completed.every((record) => record.events.includes(event!.eventId))).toBe(true)
    expect(
      snapshot.completed.every((record) =>
        record.evidence.some(
          (evidence) =>
            evidence._tag === 'ConnectionFault' &&
            evidence.faultId === 'fault-1' &&
            evidence.fault === 'disconnect',
        ),
      ),
    ).toBe(true)
    expect(snapshot.active).toHaveLength(1)
    expect(snapshot.active[0]?.key.connectionId).toBe('connection-b')
  })

  it('completes a notification after its request send succeeds', () => {
    const store = makeExplorerStore({ instanceId: 'instance', bounds: bounds() })
    const key = request(1)
    store.dispatch(requestObserved(key, 1, true))
    store.dispatch({ _tag: 'SendAttempted', at: at(2), request: key })
    store.dispatch({ _tag: 'SendSucceeded', at: at(3), request: key })

    expect(store.snapshot().completed[0]).toMatchObject({
      notification: true,
      send: 'sent',
      state: 'notificationSent',
    })
  })

  it('counts chunk envelopes separately from values and bounds retained values', () => {
    const store = makeExplorerStore({
      instanceId: 'instance',
      bounds: bounds({ streamValuesPerRecord: 2 }),
    })
    const key = request(1)
    store.dispatch(requestObserved(key, 1))
    store.dispatch({
      _tag: 'ChunkObserved',
      at: at(2),
      request: key,
      valueCount: 3,
      values: [captured('one'), captured('two'), captured('three')],
    })

    const record = store.snapshot().active[0]!
    expect(record).toMatchObject({
      state: 'streaming',
      chunkEnvelopes: 1,
      streamValues: 3,
      retainedStreamValues: 2,
    })
    expect(record.evidence).toContainEqual({ _tag: 'ValuesTruncated', count: 1 })
    expect(JSON.stringify(store.snapshot())).not.toContain('three')
  })

  it('enforces active and completed retention independently', () => {
    const store = makeExplorerStore({
      instanceId: 'instance',
      bounds: bounds({
        active: { maxCount: 2, maxAge: Duration.millis(10_000) },
        completed: { maxCount: 1, maxAge: Duration.millis(10_000) },
      }),
    })

    const first = request(1)
    const second = request(2)
    const third = request(3)
    store.dispatch(requestObserved(first, 1))
    store.dispatch(requestObserved(second, 2))
    store.dispatch(requestObserved(third, 3))

    expect(store.snapshot().active.map((record) => record.key.requestId)).toEqual([
      { _tag: 'Number', value: 2 },
      { _tag: 'Number', value: 3 },
    ])
    expect(store.snapshot().completed[0]).toMatchObject({
      key: first,
      state: 'uncertain',
    })

    store.dispatch(terminal(second, 4, 'success'))
    expect(store.snapshot().completed).toHaveLength(1)
    expect(store.snapshot().completed[0]?.key).toEqual(second)
    expect(store.snapshot().active[0]?.key).toEqual(third)
    expect(store.snapshot().counters.activeEvicted).toBe(1)
    expect(store.snapshot().counters.completedEvicted).toBe(1)
  })

  it('clears completed history while preserving active records and their events', () => {
    const store = makeExplorerStore({ instanceId: 'instance', bounds: bounds() })
    const active = request(1)
    const completed = request(2)
    store.dispatch(requestObserved(active, 1))
    store.dispatch(requestObserved(completed, 2))
    store.dispatch(terminal(completed, 3, 'success'))
    const before = store.snapshot()

    const clearedRevision = store.clearHistory()
    const after = store.snapshot()

    expect(clearedRevision).toBe(before.revision + 1)
    expect(after.active.map((record) => record.key)).toEqual([active])
    expect(after.completed).toEqual([])
    expect(after.events.map((event) => event.eventId)).toEqual(after.active[0]?.events)
  })

  it('never retains a raw secret in the store, snapshot, or watch queue', () => {
    const store = makeExplorerStore({ instanceId: 'instance', bounds: bounds() })
    const subscription = store.watch()
    const secret = 'raw-secret-that-must-not-survive'
    const input = { label: 'safe-label', token: secret }
    const observation = applyCapturePolicy({
      channel: 'requestPayload',
      value: input,
      host: {
        requestPayload: {
          _tag: 'redact',
          transform: (value: unknown) => {
            if (
              typeof value !== 'object' ||
              value === null ||
              !('label' in value) ||
              typeof value.label !== 'string'
            ) {
              return {}
            }
            return { label: value.label }
          },
        },
      },
      bounds: defaultNormalizationBounds,
    })

    store.dispatch({ ...requestObserved(request(1), 1), observations: [observation] })
    input.token = 'mutated-secret'

    expect(JSON.stringify(store.snapshot())).not.toContain(secret)
    expect(JSON.stringify(subscription.drain())).not.toContain(secret)
    subscription.close()
  })

  it('marks an unknown descriptor once without retaining a raw RPC tag', () => {
    const store = makeExplorerStore({ instanceId: 'instance', bounds: bounds() })
    const subscription = store.watch()
    subscription.drain()
    const key = request(1)
    const rawTag = 'private.rpc.Unlisted'
    const input = {
      ...requestObserved(key, 1),
      descriptorId: UnknownDescriptorId,
    }

    store.dispatch(input)
    expect(store.dispatch(input)).toBeUndefined()

    const snapshot = store.snapshot()
    const frames = subscription.drain()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.active[0]?.evidence).toEqual([{ _tag: 'UnknownDescriptor' }])
    expect(frames).toMatchObject([{ _tag: 'Delta', fromRevision: 0, toRevision: 1 }])
    const delta = frames[0]
    const upsert =
      delta?._tag === 'Delta'
        ? delta.operations.find((operation) => operation._tag === 'UpsertRecord')
        : undefined
    expect(upsert).toMatchObject({
      _tag: 'UpsertRecord',
      record: { evidence: [{ _tag: 'UnknownDescriptor' }] },
    })
    expect(JSON.stringify({ snapshot, frames })).not.toContain(rawTag)
    subscription.close()
  })

  it('bounds active stream history while preserving aggregate counters', () => {
    const eventHistoryLimit = 3
    const store = makeExplorerStore({
      instanceId: 'instance',
      bounds: bounds({
        deltas: { maxCount: eventHistoryLimit, maxAge: Duration.millis(10_000) },
        streamValuesPerRecord: 0,
      }),
    })
    const key = request(1)
    store.dispatch(requestObserved(key, 1))

    for (let index = 1; index <= 100; index += 1) {
      store.dispatch({
        _tag: 'ChunkObserved',
        at: at(index + 1),
        request: key,
        valueCount: 1,
        values: [captured(`discarded-${index}`)],
      })
    }

    const snapshot = store.snapshot()
    const record = snapshot.active[0]
    expect(record).toMatchObject({
      state: 'streaming',
      chunkEnvelopes: 100,
      streamValues: 100,
      retainedStreamValues: 0,
      evidence: [{ _tag: 'ValuesTruncated', count: 100 }],
    })
    expect(record?.events).toHaveLength(eventHistoryLimit)
    expect(snapshot.events).toHaveLength(eventHistoryLimit)

    const replay = store.watch({ afterRevision: 0 }).drain()
    expect(replay.map((frame) => frame._tag)).toEqual(['Reset', 'Snapshot'])
    const replaySnapshot = replay[1]
    expect(replaySnapshot?._tag).toBe('Snapshot')
    expect(
      replaySnapshot?._tag === 'Snapshot' ? replaySnapshot.active[0]?.events : [],
    ).toHaveLength(eventHistoryLimit)
    expect(replaySnapshot?._tag === 'Snapshot' ? replaySnapshot.events : []).toHaveLength(
      eventHistoryLimit,
    )
    expect(JSON.stringify(snapshot).length).toBeLessThan(5_000)
    expect(JSON.stringify(replay).length).toBeLessThan(6_000)
  })

  it('keeps snapshot and watch revisions contiguous across registration races and replay', () => {
    const store = makeExplorerStore({ instanceId: 'instance', bounds: bounds() })
    const key = request(1)
    store.dispatch(requestObserved(key, 1))

    const subscription = store.watch()
    store.dispatch({
      _tag: 'ChunkObserved',
      at: at(2),
      request: key,
      valueCount: 0,
      values: [],
    })

    const frames = subscription.drain()
    expect(frames.map((frame) => frame._tag)).toEqual(['Snapshot', 'Delta'])
    expect(frames[0]).toMatchObject({ _tag: 'Snapshot', revision: 1 })
    expect(frames[1]).toMatchObject({ _tag: 'Delta', fromRevision: 1, toRevision: 2 })

    const replay = store.watch({ afterRevision: 1 }).drain()
    expect(replay).toHaveLength(1)
    expect(replay[0]).toMatchObject({ _tag: 'Delta', fromRevision: 1, toRevision: 2 })
    subscription.close()
  })

  it('reports the number of replay frames evicted by delta retention', () => {
    const evictions: Array<number> = []
    const store = makeExplorerStore({
      instanceId: 'instance',
      bounds: bounds({ deltas: { maxCount: 1, maxAge: Duration.millis(10_000) } }),
      onDeltaEvicted: (count) => {
        evictions.push(count)
      },
    })

    store.dispatch(requestObserved(request(1), 1))
    store.dispatch(requestObserved(request(2), 2))

    expect(evictions).toEqual([1])
  })

  it('does not let delta eviction telemetry defects interrupt a mutation', () => {
    const store = makeExplorerStore({
      instanceId: 'instance',
      bounds: bounds({ deltas: { maxCount: 1, maxAge: Duration.millis(10_000) } }),
      onDeltaEvicted: () => {
        throw new Error('telemetry unavailable')
      },
    })

    store.dispatch(requestObserved(request(1), 1))
    expect(() => store.dispatch(requestObserved(request(2), 2))).not.toThrow()
    const snapshot = store.snapshot()
    expect(snapshot.revision).toBe(2)
    expect(snapshot.active).toHaveLength(2)
  })

  it('notifies a watcher after publication without allowing notification failure to escape', () => {
    const store = makeExplorerStore({ instanceId: 'instance', bounds: bounds() })
    const revisions: Array<number> = []
    const subscription = store.watch({
      onFrames: () => {
        revisions.push(store.snapshot().revision)
        throw new Error('inspector unavailable')
      },
    })

    expect(subscription.drain().map((frame) => frame._tag)).toEqual(['Snapshot'])
    expect(() => store.dispatch(requestObserved(request(1), 1))).not.toThrow()
    expect(revisions).toEqual([1])
    expect(subscription.drain()).toMatchObject([{ _tag: 'Delta', fromRevision: 0, toRevision: 1 }])

    subscription.close()
    store.dispatch(requestObserved(request(2), 2))
    expect(revisions).toEqual([1])
  })
})

describe('explorer store active retention', () => {
  it('ages active records by idle time so a streaming record with recent activity stays active', () => {
    const store = makeExplorerStore({ instanceId: 'instance', bounds: bounds() })
    const stream = request('stream')
    const silent = request('silent')

    store.dispatch(requestObserved(stream, 0))
    store.dispatch(requestObserved(silent, 1_000))
    for (const time of [8_000, 16_000]) {
      store.dispatch({
        _tag: 'ChunkObserved',
        at: at(time),
        request: stream,
        valueCount: 1,
        values: [captured(`chunk-${time}`)],
      })
    }
    // Started 20 s ago but last active 4 s ago: past maxAge by start, within it by idle time.
    store.dispatch(requestObserved(request('trigger'), 20_000))

    const snapshot = store.snapshot()
    expect(snapshot.active.map((record) => record.key.requestId.value).toSorted()).toEqual([
      'stream',
      'trigger',
    ])
    const expired = snapshot.completed.find((record) => record.key.requestId.value === 'silent')
    expect(expired?.state).toBe('uncertain')
    expect(expired?.evidence).toContainEqual({ _tag: 'RetentionExpired', reason: 'age' })
  })
})
