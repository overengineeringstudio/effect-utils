import { type Cause, Deferred, Duration, Effect, type Queue, Schema, Stream } from 'effect'
import { Headers } from 'effect/unstable/http'
import { Rpc, RpcGroup, RpcMessage } from 'effect/unstable/rpc'

import {
  defaultNormalizationBounds,
  InspectorRpcGroup,
  makeExplorerStore,
  makeInspectorGroup,
  makeProtocolObserver,
  makeRpcDescriptors,
  type ExplorerEventInput,
  type ExplorerStore,
  type InspectorGroup,
  type ProtocolObserver,
  type RequestIdentity,
  type Timestamp,
} from '@overeng/effect-rpc-explorer'

import type { ExplorerClient } from '../projection.ts'

const applicationGroup = RpcGroup.make(
  Rpc.make('Fixture.ApplicationRpc', {
    payload: Schema.Struct({ projectId: Schema.String }),
    success: Schema.String,
  }),
)

const descriptors = makeRpcDescriptors(applicationGroup)
const inspectorDescriptors = makeRpcDescriptors(InspectorRpcGroup)
const captureDescriptorsByTag = new Map(
  [...descriptors, ...inspectorDescriptors].map(
    (descriptor) => [descriptor.tag, descriptor] as const,
  ),
)

const descriptorForTag = (tag: string) => {
  const descriptor = captureDescriptorsByTag.get(tag)
  if (descriptor?.live === undefined) return undefined
  const { live } = descriptor
  return {
    descriptorId: descriptor.descriptorId,
    observe: descriptor.observe,
    payloadSchema: live.payloadSchema,
    successSchema: live.successSchema,
    errorSchema: live.errorSchema,
    defectSchema: live.defectSchema,
  }
}

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

const makeInspectorClient = ({
  inspector,
  observer,
}: {
  readonly inspector: InspectorGroup
  readonly observer: ProtocolObserver
}): ExplorerClient => {
  let nextRequestId = 100
  const observeRequest = ({
    tag,
    payload,
  }: {
    readonly tag: string
    readonly payload: unknown
  }) => {
    const requestId = nextRequestId++
    const identity = observer.request({
      clientId: 1,
      direction: 'clientToServer',
      message: { _tag: 'Request', id: requestId, tag, payload, headers: [] },
    })
    observer.sendAttempted(identity)
    observer.sendFinished(identity, true, false)
    return requestId
  }
  const observeTerminal = ({
    requestId,
    value,
  }: {
    readonly requestId: number
    readonly value: unknown
  }): void =>
    observer.terminal(1, 'clientToServer', {
      _tag: 'Exit',
      requestId,
      exit: { _tag: 'Success', value },
    })

  return {
    getSnapshot: async () => {
      const requestId = observeRequest({ tag: 'RpcExplorer.GetSnapshot', payload: {} })
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* inspector.group.accessHandler('RpcExplorer.GetSnapshot')
          const handlerResult = yield* handler({}, handlerOptions)
          return yield* resolveUnary(handlerResult)
        }).pipe(Effect.provide(inspector.layer)),
      )
      observeTerminal({ requestId: requestId, value: result })
      return result
    },
    watch: (afterRevision) => ({
      async *[Symbol.asyncIterator]() {
        const payload = afterRevision === undefined ? {} : { afterRevision }
        const requestId = observeRequest({ tag: 'RpcExplorer.Watch', payload: payload })
        const handler = await Effect.runPromise(
          inspector.group.accessHandler('RpcExplorer.Watch').pipe(Effect.provide(inspector.layer)),
        )
        for await (const frame of Stream.toAsyncIterable(
          resolveStream(handler(payload, handlerOptions)),
        )) {
          observer.chunk(1, 'clientToServer', { _tag: 'Chunk', requestId, values: [frame] })
          observer.correlated('AckObserved', 1, 'clientToServer', requestId)
          yield frame
        }
      },
    }),
    clearHistory: async () => {
      const requestId = observeRequest({ tag: 'RpcExplorer.ClearHistory', payload: {} })
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* inspector.group.accessHandler('RpcExplorer.ClearHistory')
          const handlerResult = yield* handler({}, handlerOptions)
          return yield* resolveUnary(handlerResult)
        }).pipe(Effect.provide(inspector.layer)),
      )
      observeTerminal({ requestId: requestId, value: result })
      return result
    },
  }
}

const timestamp = (milliseconds: number): Timestamp => ({
  monotonicNanos: String(BigInt(milliseconds) * 1_000_000n),
  wallClockMillis: milliseconds,
})

const request: RequestIdentity = {
  observerSide: 'client',
  connectionId: 'live-story-application-connection',
  direction: 'clientToServer',
  requestId: { _tag: 'String', value: 'live-application-request' },
}
const requestAfterClear: RequestIdentity = {
  ...request,
  requestId: { _tag: 'String', value: 'live-active-after-clear' },
}

const dispatch = ({
  store,
  event,
}: {
  readonly store: ExplorerStore
  readonly event: ExplorerEventInput
}): void => {
  store.dispatch(event)
}

/** Live in-memory inspector fixture with an application lifecycle trigger. */
export interface LiveCoreFixture {
  readonly client: ExplorerClient
  readonly emitLifecycle: () => void
}

/**
 * Builds the Storybook integration bridge from the real core store and inspector
 * handler layer. Every inspector Request/Chunk/Ack/Exit is fed through the
 * public protocol observer, proving the inspector descriptors exclude their own
 * traffic while application observations remain visible.
 */
export const makeLiveCoreFixture = (): LiveCoreFixture => {
  const store = makeExplorerStore({
    instanceId: 'live-core-story',
    bounds: {
      active: { maxCount: 32, maxAge: Duration.minutes(5) },
      completed: { maxCount: 32, maxAge: Duration.minutes(5) },
      streamValuesPerRecord: 8,
      normalized: defaultNormalizationBounds,
      deltas: { maxCount: 64, maxAge: Duration.minutes(5) },
      subscriberQueue: 16,
    },
  })

  dispatch({
    store: store,
    event: {
      _tag: 'RequestObserved',
      at: timestamp(1_795_027_200_000),
      request,
      descriptorId: descriptors[0]!.descriptorId,
      notification: false,
      observations: [
        {
          channel: 'requestPayload',
          outcome: { _tag: 'Captured', mode: 'reveal', source: 'schema' },
          captured: {
            _tag: 'Object',
            value: { projectId: { _tag: 'String', value: 'live-fixture-project' } },
          },
        },
      ],
    },
  })

  const inspector = makeInspectorGroup({ store, descriptors })
  let observerMillis = 1_795_027_201_100
  const observer = makeProtocolObserver(
    {
      store,
      descriptorForTag,
      timestamp: () => timestamp(observerMillis++),
    },
    'client',
  )
  let emitted = false
  return {
    client: makeInspectorClient({ inspector, observer }),
    emitLifecycle: () => {
      if (emitted === true) return
      emitted = true
      dispatch({
        store: store,
        event: {
          _tag: 'TerminalObserved',
          at: timestamp(1_795_027_200_900),
          request,
          outcome: 'success',
          observations: [
            {
              channel: 'success',
              outcome: { _tag: 'Captured', mode: 'reveal', source: 'schema' },
              captured: { _tag: 'String', value: 'completed' },
            },
          ],
        },
      })
      dispatch({
        store: store,
        event: {
          _tag: 'RequestObserved',
          at: timestamp(1_795_027_201_000),
          request: requestAfterClear,
          descriptorId: descriptors[0]!.descriptorId,
          notification: false,
          observations: [],
        },
      })
    },
  }
}
