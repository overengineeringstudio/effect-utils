import { Effect, Exit } from 'effect'
import type { Schema } from 'effect'
import { RpcSchema } from 'effect/unstable/rpc'
import type { RpcClient, RpcMessage, RpcServer } from 'effect/unstable/rpc'

import { UnknownDescriptorId } from './model.ts'
import type {
  CaptureChannel,
  ChannelObservation,
  Direction,
  NormalizationBounds,
  RequestIdentity,
  Timestamp,
  TraceContext,
} from './model.ts'
import { applyCapturePolicy, defaultNormalizationBounds } from './policy.ts'
import type { CapturePolicies, EncodedValueDecoder } from './policy.ts'
import type { ExplorerStore } from './store.ts'

/** Schema and capture metadata required to normalize one RPC tag. */
export interface ProtocolCaptureDescriptor {
  readonly descriptorId: string
  readonly observe?: 'include' | 'exclude' | undefined
  readonly payloadSchema?: Schema.Top | undefined
  readonly successSchema?: Schema.Top | undefined
  readonly errorSchema?: Schema.Top | undefined
  readonly defectSchema?: Schema.Top | undefined
  readonly encodedDecoders?:
    | Partial<Record<Exclude<CaptureChannel, 'headers'>, EncodedValueDecoder>>
    | undefined
  readonly policies?: CapturePolicies | undefined
  readonly hostPolicies?: CapturePolicies | undefined
}

/** Dependencies and policy inputs shared by protocol observation seams. */
export interface ProtocolObserverOptions {
  readonly store: ExplorerStore
  readonly descriptorForTag?: ((tag: string) => ProtocolCaptureDescriptor | undefined) | undefined
  readonly hostPolicies?: CapturePolicies | undefined
  readonly connectionId?: ((clientId: number) => string) | undefined
  readonly timestamp?: (() => Timestamp) | undefined
  readonly normalizationBounds?: NormalizationBounds | undefined
  /** Maximum stream values normalized and retained for each request. Defaults to zero. */
  readonly streamValuesPerRecord?: number | undefined
  /** Receives content-free timing evidence after a capture succeeds or fails closed. */
  readonly onNormalization?:
    | ((measurement: {
        readonly channel: CaptureChannel
        readonly outcome: 'success' | 'failure'
        readonly durationSeconds: number
      }) => void)
    | undefined
  /** Maximum active correlations and terminal dedupe tombstones retained per store. */
  readonly coordinatorCapacity?: number | undefined
}

/** Server-specific protocol observation options. */
export interface ServerProtocolObserverOptions extends ProtocolObserverOptions {
  /** Let the decoded server middleware create the request event instead. */
  readonly requestObservation?: 'protocol' | 'middleware' | undefined
}

type ObserverSide = 'client' | 'server'
type TerminalOutcome = 'success' | 'typedFailure' | 'defect' | 'interrupted'

type RequestLifecycle = {
  readonly phase: 'active' | 'terminal'
  readonly descriptor: ProtocolCaptureDescriptor
  readonly identity: RequestIdentity
  readonly excluded: boolean
  readonly retainedStreamValues: number
  readonly requestObserved: boolean
}

type RequestStart = {
  readonly descriptor: ProtocolCaptureDescriptor
  readonly shouldDispatch: boolean
}

type RequestFinish = {
  readonly descriptor: ProtocolCaptureDescriptor
  readonly shouldDispatch: boolean
}

interface ObservationCoordinator {
  readonly requests: Map<string, RequestLifecycle>
  capacity: number
  nextFaultId: number
}

const coordinators = new WeakMap<ExplorerStore, ObservationCoordinator>()

const coordinatorFor = ({
  store,
  capacity,
}: {
  readonly store: ExplorerStore
  readonly capacity: number
}): ObservationCoordinator => {
  const existing = coordinators.get(store)
  if (existing !== undefined) {
    existing.capacity = Math.min(existing.capacity, capacity)
    return existing
  }
  const created: ObservationCoordinator = { requests: new Map(), capacity, nextFaultId: 1 }
  coordinators.set(store, created)
  return created
}

const trimCoordinator = (coordinator: ObservationCoordinator): void => {
  while (coordinator.requests.size > coordinator.capacity) {
    let victim: string | undefined
    for (const [key, lifecycle] of coordinator.requests) {
      if (lifecycle.phase === 'terminal') {
        victim = key
        break
      }
    }
    victim ??= coordinator.requests.keys().next().value
    if (victim === undefined) return
    coordinator.requests.delete(victim)
  }
}

/** @internal Test-only bounded-retention observation. */
export const protocolCoordinatorSize = (store: ExplorerStore): number =>
  coordinators.get(store)?.requests.size ?? 0

const identityKey = (identity: RequestIdentity): string =>
  JSON.stringify([
    identity.observerSide,
    identity.connectionId,
    identity.direction,
    identity.requestId._tag,
    identity.requestId.value,
  ])

const unmappedDescriptor: ProtocolCaptureDescriptor = {
  descriptorId: UnknownDescriptorId,
}

let lastDefaultMonotonicNanos = 0n

const performanceNowNanos = (): bigint | undefined => {
  const performanceValue: unknown = Reflect.get(globalThis, 'performance')
  if (performanceValue === null || typeof performanceValue !== 'object') return undefined
  const now: unknown = Reflect.get(performanceValue, 'now')
  if (typeof now !== 'function') return undefined
  const millis: unknown = Reflect.apply(now, performanceValue, [])
  return typeof millis === 'number' && Number.isFinite(millis) === true
    ? BigInt(Math.floor(millis * 1_000_000))
    : undefined
}

const monotonicNowNanos = (): bigint => {
  const sampledMonotonicNanos = performanceNowNanos()
  lastDefaultMonotonicNanos =
    sampledMonotonicNanos !== undefined && sampledMonotonicNanos > lastDefaultMonotonicNanos
      ? sampledMonotonicNanos
      : lastDefaultMonotonicNanos + 1n
  return lastDefaultMonotonicNanos
}

const defaultTimestamp = (): Timestamp => ({
  monotonicNanos: String(monotonicNowNanos()),
  wallClockMillis: Date.now(),
})

const requestIdentity = ({
  observerSide,
  connectionId,
  direction,
  requestId,
}: {
  readonly observerSide: ObserverSide
  readonly connectionId: string
  readonly direction: Direction
  readonly requestId: string | number
}): RequestIdentity => ({
  observerSide,
  connectionId,
  direction,
  requestId:
    typeof requestId === 'string'
      ? { _tag: 'String', value: requestId }
      : { _tag: 'Number', value: requestId },
})

const traceFromRequest = (request: RpcMessage.RequestEncoded): TraceContext | undefined => {
  if (request.traceId === undefined || request.traceId.length === 0) return undefined
  return {
    traceId: request.traceId,
    ...(request.spanId === undefined || request.spanId.length === 0
      ? {}
      : { spanId: request.spanId }),
    ...(request.sampled === undefined ? {} : { sampled: request.sampled }),
  }
}

const streamSchemas = (
  descriptor: ProtocolCaptureDescriptor,
): { readonly element: Schema.Top; readonly error: Schema.Top } | undefined => {
  const successSchema = descriptor.successSchema
  if (successSchema === undefined || RpcSchema.isStreamSchema(successSchema) === false)
    return undefined
  return { element: successSchema.success, error: successSchema.error }
}

// oxlint-disable-next-line overeng/named-args -- Schema selection is an internal two-key lookup.
const schemaForChannel = (
  descriptor: ProtocolCaptureDescriptor,
  channel: CaptureChannel,
): Schema.Top | undefined => {
  switch (channel) {
    case 'requestPayload':
      return descriptor.payloadSchema
    case 'success':
      return streamSchemas(descriptor) === undefined ? descriptor.successSchema : undefined
    case 'typedFailure':
      return descriptor.errorSchema
    case 'defect':
      return descriptor.defectSchema
    case 'streamElement':
      return streamSchemas(descriptor)?.element
    case 'streamError':
      return streamSchemas(descriptor)?.error
    case 'headers':
      return undefined
  }
}
const decoderForChannel = ({
  descriptor,
  channel,
}: {
  readonly descriptor: ProtocolCaptureDescriptor
  readonly channel: CaptureChannel
}): EncodedValueDecoder | undefined =>
  channel === 'headers' ? undefined : descriptor.encodedDecoders?.[channel]

const safely = (effect: () => void): void => {
  try {
    effect()
  } catch {
    // Observation must never alter transport behavior.
  }
}

/** Store-scoped normalized RPC observer shared by transport and middleware seams. */
export interface ProtocolObserver {
  readonly request: (input: {
    readonly clientId: number
    readonly direction: Direction
    readonly message: RpcMessage.RequestEncoded
    readonly observe?: boolean | undefined
  }) => RequestIdentity
  readonly decodedRequest: (input: {
    readonly clientId: number
    readonly requestId: string | number
    readonly tag: string
    readonly payload: unknown
    readonly headers: unknown
  }) => RequestIdentity
  readonly sendAttempted: (identity: RequestIdentity) => void
  readonly sendFinished: (
    identity: RequestIdentity,
    succeeded: boolean,
    notification: boolean,
  ) => void
  readonly chunk: (
    clientId: number,
    direction: Direction,
    message: RpcMessage.ResponseChunkEncoded,
  ) => void
  readonly correlated: (
    tag: 'AckObserved' | 'InterruptObserved',
    clientId: number,
    direction: Direction,
    requestId: string | number,
  ) => void
  readonly terminal: (
    clientId: number,
    direction: Direction,
    message: RpcMessage.ResponseExitEncoded,
  ) => void
  readonly terminalValue: (input: {
    readonly identity: RequestIdentity
    readonly outcome: TerminalOutcome
    readonly values: ReadonlyArray<{
      readonly channel: CaptureChannel
      readonly value: unknown
      readonly encoded?: boolean | undefined
    }>
  }) => void
  readonly fault: (
    clientId: number,
    fault: 'defect' | 'clientProtocolError' | 'disconnect' | 'eof',
  ) => void
  readonly identity: (
    clientId: number,
    direction: Direction,
    requestId: string | number,
  ) => RequestIdentity
}

/** Shared, store-scoped observation seam used by protocol decorators and server middleware. */
// oxlint-disable-next-line overeng/named-args -- The observer side is a fixed construction discriminator.
export const makeProtocolObserver = (
  options: ProtocolObserverOptions,
  observerSide: ObserverSide,
): ProtocolObserver => {
  const requestedCapacity = options.coordinatorCapacity ?? 1_024
  const capacity =
    Number.isSafeInteger(requestedCapacity) === true && requestedCapacity > 0
      ? requestedCapacity
      : 1_024
  const coordinator = coordinatorFor({ store: options.store, capacity })

  const timestamp = (): Timestamp => {
    try {
      return options.timestamp?.() ?? defaultTimestamp()
    } catch {
      return defaultTimestamp()
    }
  }

  const connectionId = (clientId: number): string => {
    try {
      const resolved = options.connectionId?.(clientId) ?? String(clientId)
      return resolved.length === 0 ? String(clientId) : resolved
    } catch {
      return String(clientId)
    }
  }

  const descriptorForTag = (tag: string): ProtocolCaptureDescriptor => {
    try {
      return options.descriptorForTag?.(tag) ?? unmappedDescriptor
    } catch {
      return unmappedDescriptor
    }
  }

  const observation = ({
    channel,
    descriptor,
    value,
    encoded = false,
  }: {
    readonly channel: CaptureChannel
    readonly descriptor: ProtocolCaptureDescriptor
    readonly value: unknown
    readonly encoded?: boolean | undefined
  }): ChannelObservation => {
    const startedAt = monotonicNowNanos()
    const result = applyCapturePolicy({
      channel,
      value,
      encoded,
      decodeEncoded: encoded === true ? decoderForChannel({ descriptor, channel }) : undefined,
      bounds: options.normalizationBounds ?? defaultNormalizationBounds,
      host: descriptor.hostPolicies ?? options.hostPolicies,
      rpc: descriptor.policies,
      schema: schemaForChannel(descriptor, channel),
    })
    if (result.outcome._tag !== 'Omitted') {
      const durationSeconds = Number(monotonicNowNanos() - startedAt) / 1_000_000_000
      safely(() => {
        options.onNormalization?.({
          channel,
          outcome: result.outcome._tag === 'Captured' ? 'success' : 'failure',
          durationSeconds,
        })
      })
    }
    return result
  }

  // oxlint-disable-next-line overeng/named-args -- Lifecycle mutation keeps its three correlated inputs explicit.
  const beginRequest = (
    identity: RequestIdentity,
    descriptor: ProtocolCaptureDescriptor,
    shouldObserve: boolean,
  ): RequestStart => {
    const key = identityKey(identity)
    const current = coordinator.requests.get(key)
    const excluded = descriptor.observe === 'exclude'
    const shouldDispatch = shouldObserve === true && excluded === false
    if (current === undefined || current.phase === 'terminal') {
      if (current !== undefined) coordinator.requests.delete(key)
      coordinator.requests.set(key, {
        phase: 'active',
        descriptor,
        requestObserved: shouldDispatch,
        identity,
        excluded,
        retainedStreamValues: 0,
      })
      trimCoordinator(coordinator)
      return { descriptor, shouldDispatch }
    }
    if (
      current.requestObserved === false &&
      shouldDispatch === true &&
      current.excluded === false
    ) {
      coordinator.requests.set(key, { ...current, requestObserved: true })
      return { descriptor: current.descriptor, shouldDispatch: true }
    }
    return { descriptor: current.descriptor, shouldDispatch: false }
  }

  const activeLifecycle = (identity: RequestIdentity): RequestLifecycle | undefined => {
    const lifecycle = coordinator.requests.get(identityKey(identity))
    return lifecycle?.phase === 'active' && lifecycle.excluded === false ? lifecycle : undefined
  }

  const activeDescriptor = (identity: RequestIdentity): ProtocolCaptureDescriptor | undefined =>
    activeLifecycle(identity)?.descriptor

  const finishRequest = (identity: RequestIdentity): RequestFinish | undefined => {
    const key = identityKey(identity)
    const lifecycle = coordinator.requests.get(key)
    if (lifecycle === undefined) return undefined
    if (lifecycle.phase === 'terminal') {
      return { descriptor: lifecycle.descriptor, shouldDispatch: false }
    }
    coordinator.requests.delete(key)
    coordinator.requests.set(key, { ...lifecycle, phase: 'terminal' })
    trimCoordinator(coordinator)
    return {
      descriptor: lifecycle.descriptor,
      shouldDispatch: lifecycle.excluded === false && lifecycle.requestObserved === true,
    }
  }

  const completeWithoutTerminalEvent = (identity: RequestIdentity): void => {
    const key = identityKey(identity)
    const lifecycle = coordinator.requests.get(key)
    if (lifecycle?.phase === 'active') {
      coordinator.requests.delete(key)
      coordinator.requests.set(key, { ...lifecycle, phase: 'terminal' })
      trimCoordinator(coordinator)
    }
  }

  const request = ({
    clientId,
    direction,
    message,
    observe = true,
  }: {
    readonly clientId: number
    readonly direction: Direction
    readonly message: RpcMessage.RequestEncoded
    readonly observe?: boolean | undefined
  }): RequestIdentity => {
    const identity = requestIdentity({
      observerSide,
      connectionId: connectionId(clientId),
      direction,
      requestId: message.id,
    })
    const descriptor = descriptorForTag(message.tag)
    const start = beginRequest(identity, descriptor, observe)
    const trace = traceFromRequest(message)
    if (start.shouldDispatch === true) {
      safely(() => {
        options.store.dispatch({
          _tag: 'RequestObserved',
          at: timestamp(),
          request: identity,
          descriptorId: start.descriptor.descriptorId,
          notification: message.isNotification === true,
          ...(trace === undefined ? {} : { trace }),
          observations: [
            observation({
              channel: 'requestPayload',
              descriptor: start.descriptor,
              value: message.payload,
              encoded: true,
            }),
            observation({
              channel: 'headers',
              descriptor: start.descriptor,
              value: message.headers,
            }),
          ],
        })
      })
    }
    return identity
  }

  const decodedRequest = ({
    clientId,
    requestId,
    tag,
    payload,
    headers,
  }: {
    readonly clientId: number
    readonly requestId: string | number
    readonly tag: string
    readonly payload: unknown
    readonly headers: unknown
  }): RequestIdentity => {
    const identity = requestIdentity({
      observerSide,
      connectionId: connectionId(clientId),
      direction: 'clientToServer',
      requestId,
    })
    const start = beginRequest(identity, descriptorForTag(tag), true)
    if (start.shouldDispatch === true) {
      safely(() => {
        options.store.dispatch({
          _tag: 'RequestObserved',
          at: timestamp(),
          request: identity,
          descriptorId: start.descriptor.descriptorId,
          notification: false,
          observations: [
            observation({
              channel: 'requestPayload',
              descriptor: start.descriptor,
              value: payload,
            }),
            observation({ channel: 'headers', descriptor: start.descriptor, value: headers }),
          ],
        })
      })
    }
    return identity
  }

  const sendAttempted = (identity: RequestIdentity): void => {
    if (activeDescriptor(identity) === undefined) return
    safely(() => {
      options.store.dispatch({ _tag: 'SendAttempted', at: timestamp(), request: identity })
    })
  }

  // oxlint-disable-next-line overeng/named-args -- Send completion mirrors the transport callback fields.
  const sendFinished = (
    identity: RequestIdentity,
    succeeded: boolean,
    notification: boolean,
  ): void => {
    const observable = activeDescriptor(identity) !== undefined
    if (observable === true) {
      safely(() => {
        options.store.dispatch({
          _tag: succeeded === true ? 'SendSucceeded' : 'SendFailed',
          at: timestamp(),
          request: identity,
        })
      })
    }
    if (succeeded === false || notification === true) completeWithoutTerminalEvent(identity)
  }

  // oxlint-disable-next-line overeng/named-args -- Chunk observation mirrors the protocol callback signature.
  const chunk = (
    clientId: number,
    direction: Direction,
    message: RpcMessage.ResponseChunkEncoded,
  ): void => {
    const identity = requestIdentity({
      observerSide,
      connectionId: connectionId(clientId),
      direction,
      requestId: message.requestId,
    })
    const key = identityKey(identity)
    const lifecycle = activeLifecycle(identity)
    if (lifecycle === undefined) return
    const requestedLimit = options.streamValuesPerRecord ?? 0
    const limit =
      Number.isSafeInteger(requestedLimit) === true && requestedLimit >= 0 ? requestedLimit : 0
    const remaining = Math.max(0, limit - lifecycle.retainedStreamValues)
    const retainedValues = message.values.slice(0, remaining)
    coordinator.requests.set(key, {
      ...lifecycle,
      retainedStreamValues: lifecycle.retainedStreamValues + retainedValues.length,
    })
    safely(() => {
      options.store.dispatch({
        _tag: 'ChunkObserved',
        at: timestamp(),
        request: identity,
        valueCount: message.values.length,
        values: retainedValues.map((value) =>
          observation({
            channel: 'streamElement',
            descriptor: lifecycle.descriptor,
            value,
            encoded: true,
          }),
        ),
      })
    })
  }

  // oxlint-disable-next-line overeng/named-args -- Correlated envelopes mirror the protocol fields.
  const correlated = (
    tag: 'AckObserved' | 'InterruptObserved',
    clientId: number,
    direction: Direction,
    requestIdValue: string | number,
  ): void => {
    const identity = requestIdentity({
      observerSide,
      connectionId: connectionId(clientId),
      direction,
      requestId: requestIdValue,
    })
    if (activeDescriptor(identity) === undefined) return
    safely(() => {
      options.store.dispatch({ _tag: tag, at: timestamp(), request: identity })
    })
  }

  const terminalValue = ({
    identity,
    outcome,
    values,
  }: {
    readonly identity: RequestIdentity
    readonly outcome: TerminalOutcome
    readonly values: ReadonlyArray<{
      readonly channel: CaptureChannel
      readonly value: unknown
      readonly encoded?: boolean | undefined
    }>
  }): void => {
    const finish = finishRequest(identity)
    if (finish === undefined || finish.shouldDispatch === false) return
    safely(() => {
      options.store.dispatch({
        _tag: 'TerminalObserved',
        at: timestamp(),
        request: identity,
        outcome,
        observations: values.map(({ channel, value, encoded }) =>
          observation({ channel, descriptor: finish.descriptor, value, encoded }),
        ),
      })
    })
  }

  // oxlint-disable-next-line overeng/named-args -- Terminal observation mirrors the protocol callback signature.
  const terminal = (
    clientId: number,
    direction: Direction,
    message: RpcMessage.ResponseExitEncoded,
  ): void => {
    const identity = requestIdentity({
      observerSide,
      connectionId: connectionId(clientId),
      direction,
      requestId: message.requestId,
    })
    if (message.exit._tag === 'Success') {
      const descriptor = activeDescriptor(identity)
      terminalValue({
        identity,
        outcome: 'success',
        values:
          descriptor === undefined || streamSchemas(descriptor) !== undefined
            ? []
            : [{ channel: 'success', value: message.exit.value, encoded: true }],
      })
      return
    }
    if (Array.isArray(message.exit.cause) === false || message.exit.cause.length === 0) return
    const requestedLimit =
      options.normalizationBounds?.maxEntries ?? defaultNormalizationBounds.maxEntries
    const terminalObservationLimit =
      Number.isSafeInteger(requestedLimit) === true && requestedLimit >= 0 ? requestedLimit : 0
    let hasDefect = false
    let hasInterrupt = false
    const descriptor = activeDescriptor(identity)
    const isStream = descriptor !== undefined && streamSchemas(descriptor) !== undefined
    const values: Array<{
      readonly channel: CaptureChannel
      readonly value: unknown
      readonly encoded: true
    }> = []
    for (const cause of message.exit.cause) {
      switch (cause._tag) {
        case 'Die':
          hasDefect = true
          if (values.length < terminalObservationLimit) {
            values.push({ channel: 'defect', value: cause.defect, encoded: true })
          }
          break
        case 'Fail':
          if (values.length < terminalObservationLimit) {
            values.push({
              channel: isStream === true ? 'streamError' : 'typedFailure',
              value: cause.error,
              encoded: true,
            })
          }
          break
        case 'Interrupt':
          hasInterrupt = true
          break
      }
    }
    terminalValue({
      identity,
      outcome:
        hasDefect === true ? 'defect' : hasInterrupt === true ? 'interrupted' : 'typedFailure',
      values,
    })
  }

  // oxlint-disable-next-line overeng/named-args -- Connection faults are keyed by transport client and kind.
  const fault = (
    clientId: number,
    faultKind: 'defect' | 'clientProtocolError' | 'disconnect' | 'eof',
  ): void => {
    const resolvedConnectionId = connectionId(clientId)
    const related = [...coordinator.requests].filter(
      ([, lifecycle]) =>
        lifecycle.identity.observerSide === observerSide &&
        lifecycle.identity.connectionId === resolvedConnectionId,
    )
    for (const [key, lifecycle] of related) {
      if (lifecycle.phase === 'terminal') continue
      coordinator.requests.delete(key)
      coordinator.requests.set(key, { ...lifecycle, phase: 'terminal' })
    }
    trimCoordinator(coordinator)
    if (
      related.length > 0 &&
      related.every(([, lifecycle]) => lifecycle.excluded === true) === true
    )
      return
    const faultId = `${observerSide}:${resolvedConnectionId}:${coordinator.nextFaultId}`
    coordinator.nextFaultId += 1
    safely(() => {
      options.store.dispatch({
        _tag: 'ConnectionFault',
        at: timestamp(),
        connectionId: resolvedConnectionId,
        fault: faultKind,
        faultId,
      })
    })
  }

  return {
    request,
    decodedRequest,
    sendAttempted,
    sendFinished,
    chunk,
    correlated,
    terminal,
    terminalValue,
    fault,
    // oxlint-disable-next-line overeng/named-args -- Identity construction mirrors the wire correlation tuple.
    identity: (
      clientId: number,
      direction: Direction,
      requestIdValue: string | number,
    ): RequestIdentity =>
      requestIdentity({
        observerSide,
        connectionId: connectionId(clientId),
        direction,
        requestId: requestIdValue,
      }),
  }
}
// oxlint-disable-next-line overeng/named-args -- Adapter mirrors Effect's fixed Protocol.run callback.
const observeClientInbound = (
  observer: ProtocolObserver,
  clientId: number,
  message: RpcMessage.FromServerEncoded,
): void => {
  switch (message._tag) {
    case 'Request':
      observer.request({ clientId, direction: 'serverToClient', message })
      return
    case 'Chunk':
      observer.chunk(clientId, 'clientToServer', message)
      return
    case 'Exit':
      observer.terminal(clientId, 'clientToServer', message)
      return
    case 'Defect':
      observer.fault(clientId, 'defect')
      return
    case 'ClientProtocolError':
      observer.fault(clientId, 'clientProtocolError')
      return
    case 'Pong':
      return
  }
}

type OutgoingRequest = {
  readonly identity: RequestIdentity
  readonly notification: boolean
}

// oxlint-disable-next-line overeng/named-args -- Adapter mirrors Effect's fixed Protocol.send callback.
const observeClientOutbound = (
  observer: ProtocolObserver,
  clientId: number,
  message: RpcMessage.FromClientEncoded,
): OutgoingRequest | undefined => {
  switch (message._tag) {
    case 'Request': {
      const identity = observer.request({ clientId, direction: 'clientToServer', message })
      observer.sendAttempted(identity)
      return { identity, notification: message.isNotification === true }
    }
    case 'Ack':
      observer.correlated('AckObserved', clientId, 'clientToServer', message.requestId)
      return undefined
    case 'Interrupt':
      observer.correlated('InterruptObserved', clientId, 'clientToServer', message.requestId)
      return undefined
    case 'Eof':
      observer.fault(clientId, 'eof')
      return undefined
    case 'Ping':
      return undefined
  }
}

/** Decorates a public client Protocol without changing its transport contract. */
// oxlint-disable-next-line overeng/named-args -- Public decorator pairs a protocol with its observer options.
export const decorateClientProtocol = (
  protocol: RpcClient.Protocol['Service'],
  options: ProtocolObserverOptions,
): RpcClient.Protocol['Service'] => {
  const observer = makeProtocolObserver(options, 'client')
  return {
    ...protocol,
    // oxlint-disable-next-line overeng/named-args -- Effect Protocol.run has a fixed positional signature.
    run: (clientId, callback) =>
      Effect.onExit(
        protocol.run(clientId, (message) =>
          Effect.sync(() => observeClientInbound(observer, clientId, message)).pipe(
            Effect.andThen(Effect.suspend(() => callback(message))),
          ),
        ),
        () => Effect.sync(() => observer.fault(clientId, 'disconnect')),
      ),
    // oxlint-disable-next-line overeng/named-args -- Effect Protocol.send has a fixed positional signature.
    send: (clientId, message, transferables) =>
      Effect.suspend(() => {
        const outgoing = observeClientOutbound(observer, clientId, message)
        return Effect.onExit(protocol.send(clientId, message, transferables), (exit) =>
          Effect.sync(() => {
            if (outgoing !== undefined) {
              observer.sendFinished(outgoing.identity, Exit.isSuccess(exit), outgoing.notification)
            }
          }),
        )
      }),
  }
}

// oxlint-disable-next-line overeng/named-args -- Adapter mirrors Effect's fixed Protocol.run callback.
const observeServerInbound = (
  observer: ProtocolObserver,
  clientId: number,
  message: RpcMessage.FromClientEncoded,
  requestObservation: 'protocol' | 'middleware',
): void => {
  switch (message._tag) {
    case 'Request':
      observer.request({
        clientId,
        direction: 'clientToServer',
        message,
        observe: requestObservation === 'protocol',
      })
      return
    case 'Ack':
      observer.correlated('AckObserved', clientId, 'clientToServer', message.requestId)
      return
    case 'Interrupt':
      observer.correlated('InterruptObserved', clientId, 'clientToServer', message.requestId)
      return
    case 'Eof':
      // Server-side EOF only says this body carries no further client messages;
      // the HTTP protocol emits it per request batch before responses are
      // produced. In-flight requests stay servable (real loss arrives via
      // disconnect and synthesized Interrupts), so it is a transport fact like
      // Ping, not a connection fault (decision q3).
      return
    case 'Ping':
      return
  }
}

// oxlint-disable-next-line overeng/named-args -- Adapter mirrors Effect's fixed Protocol.send callback.
const observeServerOutbound = (
  observer: ProtocolObserver,
  clientId: number,
  message: RpcMessage.FromServerEncoded,
): OutgoingRequest | undefined => {
  switch (message._tag) {
    case 'Request': {
      const identity = observer.request({ clientId, direction: 'serverToClient', message })
      observer.sendAttempted(identity)
      return { identity, notification: message.isNotification === true }
    }
    case 'Chunk':
      observer.chunk(clientId, 'clientToServer', message)
      return undefined
    case 'Exit':
      observer.terminal(clientId, 'clientToServer', message)
      return undefined
    case 'Defect':
      observer.fault(clientId, 'defect')
      return undefined
    case 'ClientProtocolError':
      observer.fault(clientId, 'clientProtocolError')
      return undefined
    case 'Pong':
      return undefined
  }
}

/** Decorates a public server Protocol while preserving every capability field. */
// oxlint-disable-next-line overeng/named-args -- Public decorator pairs a protocol with its observer options.
export const decorateServerProtocol = (
  protocol: RpcServer.Protocol['Service'],
  options: ServerProtocolObserverOptions,
): RpcServer.Protocol['Service'] => {
  const observer = makeProtocolObserver(options, 'server')
  return {
    ...protocol,
    disconnects: protocol.disconnects,
    run: (callback) =>
      protocol.run((clientId, message) =>
        Effect.sync(() =>
          observeServerInbound(
            observer,
            clientId,
            message,
            options.requestObservation ?? 'protocol',
          ),
        ).pipe(Effect.andThen(Effect.suspend(() => callback(clientId, message)))),
      ),
    // oxlint-disable-next-line overeng/named-args -- Effect Protocol.send has a fixed positional signature.
    send: (clientId, message, transferables) =>
      Effect.suspend(() => {
        const outgoing = observeServerOutbound(observer, clientId, message)
        return Effect.onExit(protocol.send(clientId, message, transferables), (exit) =>
          Effect.sync(() => {
            if (outgoing !== undefined) {
              observer.sendFinished(outgoing.identity, Exit.isSuccess(exit), outgoing.notification)
            }
          }),
        )
      }),
    end: (clientId) =>
      Effect.tap(protocol.end(clientId), () =>
        Effect.sync(() => observer.fault(clientId, 'disconnect')),
      ),
  }
}
