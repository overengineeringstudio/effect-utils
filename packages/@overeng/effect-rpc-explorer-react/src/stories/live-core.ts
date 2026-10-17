import { Duration, Effect, Queue, Schema, Stream } from 'effect'
import { Rpc, RpcClient, RpcGroup, type RpcMessage, RpcSerialization, RpcServer } from 'effect/rpc'

import {
  defaultNormalizationBounds,
  InspectorRpcGroup,
  makeExplorerStore,
  makeDescriptorSet,
  makeInspectorGroup,
  makeCaptureSink,
  makeRpcDescriptors,
  type ExplorerEventInput,
  type ExplorerStore,
  type InspectorGroup,
  type RequestIdentity,
  type Timestamp,
} from '@overeng/effect-rpc-explorer'
import type { ExplorerClient } from '@overeng/effect-rpc-explorer'
import {
  decorateClientProtocol,
  decorateServerProtocol,
  makeProtocolObserver,
} from '@overeng/effect-rpc-observer'

const applicationGroup = RpcGroup.make(
  Rpc.make('Fixture.ApplicationRpc', {
    payload: Schema.Struct({ projectId: Schema.String }),
    success: Schema.String,
  }),
)

const descriptors = makeRpcDescriptors(applicationGroup)
/** A group the host mounts after construction, like an app-local provider. */
const runtimeDescriptors = makeRpcDescriptors(
  RpcGroup.make(
    Rpc.make('Fixture.RuntimeProviderRpc', {
      payload: Schema.Struct({ cursor: Schema.Finite }),
      success: Schema.String,
    }),
  ),
)
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

const ignoreDelivery = (): Effect.Effect<void> => Effect.void

const makeInspectorClient = ({
  inspector,
  store,
}: {
  readonly inspector: InspectorGroup
  readonly store: ExplorerStore
}): ExplorerClient => {
  let nextConnection = 1
  let observerMillis = 1_795_027_201_100
  const makeClient = Effect.gen(function* () {
    const connection = nextConnection++
    let deliverToServer: (
      clientId: number,
      message: RpcMessage.FromClientEncoded,
    ) => Effect.Effect<void> = ignoreDelivery
    let deliverToClient: (
      clientId: number,
      message: RpcMessage.FromServerEncoded,
    ) => Effect.Effect<void> = ignoreDelivery
    const serverProtocol = yield* RpcServer.Protocol.make((writeRequest) => {
      deliverToServer = writeRequest
      return Effect.map(Queue.make<number>(), (disconnects) => ({
        disconnects,
        clientIds: Effect.succeed(new Set<number>()),
        initialMessage: Effect.succeedNone,
        // oxlint-disable-next-line overeng/named-args -- Protocol callback shape belongs to Effect.
        send: (clientId, message) => deliverToClient(clientId, message),
        end: () => Effect.void,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
        supportsNotifications: true,
        codecFor: RpcSerialization.json.codecFor,
      }))
    })
    const clientProtocol = yield* RpcClient.Protocol.make((writeResponse) => {
      deliverToClient = writeResponse
      return Effect.succeed({
        // oxlint-disable-next-line overeng/named-args -- Protocol callback shape belongs to Effect.
        send: (clientId, message) => deliverToServer(clientId, message),
        supportsAck: true,
        supportsTransferables: false,
        codecFor: RpcSerialization.json.codecFor,
      })
    })
    const serverObserver = yield* makeProtocolObserver({
      side: 'server',
      capacity: 32,
      connectionId: (clientId) => `fixture-server-${connection}-${clientId}`,
      clock: { now: () => timestamp(observerMillis++) },
      sinks: [
        { capture: true, sink: makeCaptureSink({ store, side: 'server', descriptorForTag }) },
      ],
    })
    const clientObserver = yield* makeProtocolObserver({
      side: 'client',
      capacity: 32,
      connectionId: (clientId) => `fixture-client-${connection}-${clientId}`,
      clock: { now: () => timestamp(observerMillis++) },
      sinks: [
        { capture: true, sink: makeCaptureSink({ store, side: 'client', descriptorForTag }) },
      ],
    })
    yield* RpcServer.make(InspectorRpcGroup).pipe(
      Effect.provideService(
        RpcServer.Protocol,
        decorateServerProtocol({ protocol: serverProtocol, observer: serverObserver }),
      ),
      Effect.provide(inspector.layer),
      Effect.forkScoped,
    )
    return yield* RpcClient.make(InspectorRpcGroup).pipe(
      Effect.provideService(
        RpcClient.Protocol,
        decorateClientProtocol({ protocol: clientProtocol, observer: clientObserver }),
      ),
    )
  })
  return {
    getSnapshot: () =>
      makeClient.pipe(
        Effect.flatMap((client) => client['RpcExplorer.GetSnapshot']({})),
        Effect.scoped,
        Effect.runPromise,
      ),
    watch: ({ afterRevision, descriptorRevision }) =>
      Stream.toAsyncIterable(
        Stream.unwrap(
          Effect.map(makeClient, (client) =>
            client['RpcExplorer.Watch']({
              ...(afterRevision === undefined ? {} : { afterRevision }),
              ...(descriptorRevision === undefined ? {} : { descriptorRevision }),
            }),
          ),
        ),
      ),
    clearHistory: () =>
      makeClient.pipe(
        Effect.flatMap((client) => client['RpcExplorer.ClearHistory']({})),
        Effect.scoped,
        Effect.runPromise,
      ),
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
const runtimeRequest: RequestIdentity = {
  ...request,
  requestId: { _tag: 'String', value: 'live-runtime-provider-request' },
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
  /** Registers the runtime provider group and observes one of its requests. */
  readonly mountRuntimeProvider: () => void
  /** Releases the runtime provider group's descriptor registration. */
  readonly unmountRuntimeProvider: () => void
}

/**
 * Builds the Storybook integration bridge with real scoped client/server RPC
 * protocols and shared observer capture sinks. Inspector traffic exercises the
 * production transport seams while excluded descriptors keep it out of the store.
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

  const descriptorSet = makeDescriptorSet(descriptors)
  const inspector = makeInspectorGroup({ store, descriptors: descriptorSet })
  let releaseRuntimeProvider: (() => void) | undefined
  let emitted = false
  return {
    client: makeInspectorClient({ inspector, store }),
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
    mountRuntimeProvider: () => {
      if (releaseRuntimeProvider !== undefined) return
      releaseRuntimeProvider = descriptorSet.register({
        owner: 'fixture/runtime-provider',
        descriptors: runtimeDescriptors,
      })
      dispatch({
        store,
        event: {
          _tag: 'RequestObserved',
          at: timestamp(1_795_027_201_050),
          request: runtimeRequest,
          descriptorId: runtimeDescriptors[0]!.descriptorId,
          notification: false,
          observations: [],
        },
      })
    },
    unmountRuntimeProvider: () => {
      releaseRuntimeProvider?.()
      releaseRuntimeProvider = undefined
    },
  }
}
