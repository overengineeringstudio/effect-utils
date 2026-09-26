import { type Cause, Deferred, Duration, Effect, Fiber, type Queue, Schema, Stream } from 'effect'
import { Headers } from 'effect/unstable/http'
import * as OpenApi from 'effect/unstable/httpapi/OpenApi'
import { Rpc, RpcGroup, RpcMessage } from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'

import { makeRpcDescriptors } from './descriptor.ts'
import type { InspectorGroup } from './inspector.ts'
import {
  encodeWatchFrameNdjson,
  isSupportedInspectorProtocolVersion,
  makeInspectorGroup,
} from './inspector.ts'
import type { ExplorerBounds, ExplorerEventInput, RequestIdentity, Timestamp } from './model.ts'
import { defaultNormalizationBounds } from './policy.ts'
import type { ExplorerStore } from './store.ts'
import { makeExplorerStore } from './store.ts'

const bounds = (overrides: Partial<ExplorerBounds> = {}): ExplorerBounds => ({
  active: { maxCount: 16, maxAge: Duration.seconds(10) },
  completed: { maxCount: 16, maxAge: Duration.seconds(10) },
  streamValuesPerRecord: 16,
  normalized: defaultNormalizationBounds,
  deltas: { maxCount: 16, maxAge: Duration.seconds(10) },
  subscriberQueue: 16,
  ...overrides,
})

const at = (value: number): Timestamp => ({
  monotonicNanos: String(value * 1_000_000),
  wallClockMillis: value,
})

const requestKey: RequestIdentity = {
  observerSide: 'client',
  connectionId: 'connection',
  direction: 'clientToServer',
  requestId: { _tag: 'Number', value: 1 },
}

const requestObserved = (
  time: number,
  request: RequestIdentity = requestKey,
): ExplorerEventInput => ({
  _tag: 'RequestObserved',
  at: at(time),
  request,
  descriptorId: 'rpc:ApplicationRpc',
  notification: false,
  observations: [],
})

const terminal = (time: number): ExplorerEventInput => ({
  _tag: 'TerminalObserved',
  at: at(time),
  request: requestKey,
  outcome: 'success',
  observations: [],
})

const applicationDescriptors = makeRpcDescriptors(
  RpcGroup.make(
    Rpc.make('ApplicationRpc', {
      payload: Schema.String,
      success: Schema.String,
    })
      .annotate(OpenApi.Title, 'Application operation')
      .annotate(OpenApi.Summary, 'Inspects the application.')
      .annotate(OpenApi.Description, 'Returns the public application result.')
      .annotate(OpenApi.Deprecated, false),
  ),
)

const handlerOptions = {
  client: new Rpc.ServerClient(1),
  requestId: RpcMessage.RequestId(1),
  headers: Headers.empty,
}

const resolveUnary = <A, E>(result: A | Deferred.Deferred<A, E>): Effect.Effect<A, E> =>
  Deferred.isDeferred<A, E>(result) === true ? Deferred.await(result) : Effect.succeed(result)

const resolveStream = <A, E, R>(
  result: Stream.Stream<A, E, R> | Effect.Effect<Queue.Dequeue<A, E | Cause.Done>, E, R>,
): Stream.Stream<A, E, R> =>
  Stream.isStream(result) === true
    ? result
    : Stream.unwrap(Effect.map(result, (queue) => Stream.fromQueue(queue)))

const runSnapshot = (inspector: InspectorGroup) => {
  const effect = Effect.gen(function* () {
    const handler = yield* inspector.group.accessHandler('RpcExplorer.GetSnapshot')
    const result = yield* handler({}, handlerOptions)
    return yield* resolveUnary(result)
  }).pipe(Effect.provide(inspector.layer))
  return Effect.runPromise(effect)
}

const collectWatch = (
  inspector: InspectorGroup,
  payload: { readonly afterRevision?: number },
  count: number,
) => {
  const effect = Effect.gen(function* () {
    const handler = yield* inspector.group.accessHandler('RpcExplorer.Watch')
    return yield* resolveStream(handler(payload, handlerOptions)).pipe(
      Stream.take(count),
      Stream.runCollect,
    )
  }).pipe(Effect.provide(inspector.layer))
  return Effect.runPromise(effect)
}

describe('RPC explorer inspector', () => {
  it('returns a typed initial snapshot, strips live descriptors, and encodes one NDJSON line', async () => {
    const store = makeExplorerStore({ instanceId: 'inspector', bounds: bounds() })
    const inspector = makeInspectorGroup({ store, descriptors: applicationDescriptors })

    const snapshot = await runSnapshot(inspector)
    expect(snapshot).toMatchObject({
      _tag: 'Snapshot',
      protocolVersion: 'rpc-explorer.v1',
      instanceId: 'inspector',
      revision: 0,
    })
    expect(snapshot.descriptors).toHaveLength(1)
    expect(snapshot.descriptors[0]).not.toHaveProperty('live')
    expect(snapshot.descriptors[0]).toMatchObject({
      title: 'Application operation',
      summary: 'Inspects the application.',
      description: 'Returns the public application result.',
      deprecated: false,
    })

    const encoded = encodeWatchFrameNdjson(snapshot)
    expect(encoded.endsWith('\n')).toBe(true)
    expect(encoded.split('\n')).toHaveLength(2)
    expect(JSON.parse(encoded.slice(0, -1))).toEqual(snapshot)
    expect(isSupportedInspectorProtocolVersion('rpc-explorer.v1')).toBe(true)
    expect(isSupportedInspectorProtocolVersion('rpc-explorer.v2')).toBe(false)

    expect(makeRpcDescriptors(inspector.group).map((descriptor) => descriptor.observe)).toEqual([
      'exclude',
      'exclude',
      'exclude',
    ])
  })

  it('replays contiguous deltas and resets a revision outside the replay window', async () => {
    const replayStore = makeExplorerStore({ instanceId: 'replay', bounds: bounds() })
    replayStore.dispatch(requestObserved(1))
    replayStore.dispatch(terminal(2))
    const replayInspector = makeInspectorGroup({
      store: replayStore,
      descriptors: applicationDescriptors,
    })

    const replay = await collectWatch(replayInspector, { afterRevision: 0 }, 2)
    expect(replay.map((frame) => frame._tag)).toEqual(['Delta', 'Delta'])
    expect(replay.map((frame) => (frame._tag === 'Delta' ? frame.toRevision : -1))).toEqual([1, 2])

    const resetStore = makeExplorerStore({
      instanceId: 'reset',
      bounds: bounds({ deltas: { maxCount: 1, maxAge: Duration.seconds(10) } }),
    })
    resetStore.dispatch(requestObserved(1))
    resetStore.dispatch(terminal(2))
    const resetInspector = makeInspectorGroup({
      store: resetStore,
      descriptors: applicationDescriptors,
    })

    const reset = await collectWatch(resetInspector, { afterRevision: 0 }, 2)
    expect(reset.map((frame) => frame._tag)).toEqual(['Reset', 'Snapshot'])
    expect(reset[0]).toMatchObject({ _tag: 'Reset', reason: 'behind', revision: 2 })
    expect(reset[1]).toMatchObject({ _tag: 'Snapshot', revision: 2 })
  })

  it('publishes clear reset and snapshot while preserving active records', async () => {
    const store = makeExplorerStore({ instanceId: 'clear', bounds: bounds() })
    store.dispatch(requestObserved(1))
    store.dispatch(terminal(2))
    store.dispatch(
      requestObserved(3, {
        ...requestKey,
        requestId: { _tag: 'Number', value: 2 },
      }),
    )

    const effect = Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>()
      const context = yield* Effect.context<never>()
      const watchedStore: ExplorerStore = {
        ...store,
        watch: (options = {}) => {
          const subscription = store.watch(options)
          let initialDrained = false
          return {
            drain: () => {
              const frames = subscription.drain()
              if (initialDrained === false) {
                initialDrained = true
                Effect.runSyncWith(context)(Deferred.succeed(subscribed, undefined))
              }
              return frames
            },
            close: subscription.close,
          }
        },
      }
      const inspector = makeInspectorGroup({
        store: watchedStore,
        descriptors: applicationDescriptors,
      })
      const watchHandler = yield* inspector.group
        .accessHandler('RpcExplorer.Watch')
        .pipe(Effect.provide(inspector.layer))
      const clearHandler = yield* inspector.group
        .accessHandler('RpcExplorer.ClearHistory')
        .pipe(Effect.provide(inspector.layer))
      const watchFiber = yield* resolveStream(watchHandler({}, handlerOptions)).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      )

      yield* Deferred.await(subscribed)
      const clearResult = yield* clearHandler({}, handlerOptions)
      const cleared = yield* resolveUnary(clearResult)
      const frames = yield* Fiber.join(watchFiber)
      return { cleared, frames }
    })
    const result = await Effect.runPromise(effect)

    expect(result.cleared).toEqual({ clearedRevision: 4 })
    expect(result.frames.map((frame) => frame._tag)).toEqual(['Snapshot', 'Reset', 'Snapshot'])
    expect(result.frames[1]).toMatchObject({ _tag: 'Reset', reason: 'cleared', revision: 4 })
    expect(result.frames[2]).toMatchObject({
      _tag: 'Snapshot',
      revision: 4,
      active: [{ key: { requestId: { _tag: 'Number', value: 2 } } }],
      completed: [],
    })
  })

  it('closes the store subscription when stream consumption ends', async () => {
    const store = makeExplorerStore({ instanceId: 'cleanup', bounds: bounds() })
    let closeCount = 0
    const trackedStore: ExplorerStore = {
      ...store,
      watch: (options = {}) => {
        const subscription = store.watch(options)
        return {
          drain: subscription.drain,
          close: () => {
            closeCount += 1
            subscription.close()
          },
        }
      },
    }
    const inspector = makeInspectorGroup({
      store: trackedStore,
      descriptors: applicationDescriptors,
    })

    const frames = await collectWatch(inspector, {}, 1)
    expect(frames).toHaveLength(1)
    expect(closeCount).toBe(1)
  })
})
