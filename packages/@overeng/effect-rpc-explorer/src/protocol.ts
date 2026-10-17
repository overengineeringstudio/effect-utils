import { Clock, Effect } from 'effect'
import type { Schema } from 'effect'
import { RpcSchema } from 'effect/rpc'
import type { RpcMessage } from 'effect/rpc'

import type {
  CaptureSink,
  ObserverSide,
  RawValue,
  RequestIdentity,
} from '@overeng/effect-rpc-observer'

import { UnknownDescriptorId } from './model.ts'
import type {
  CaptureChannel,
  ChannelObservation,
  NormalizationBounds,
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

/** Explorer-owned policy adapter inputs; transport correlation belongs to the observer. */
export interface MakeCaptureSinkOptions {
  readonly store: ExplorerStore
  readonly side: ObserverSide
  readonly descriptorForTag?: ((tag: string) => ProtocolCaptureDescriptor | undefined) | undefined
  readonly hostPolicies?: CapturePolicies | undefined
  readonly normalizationBounds?: NormalizationBounds | undefined
  /** Maximum stream values normalized per record, independent of full chunk counts. */
  readonly streamValuesPerRecord?: number | undefined
  /** Bounds capture metadata even if a host uses an observer with a larger capacity. */
  readonly captureCapacity?: number | undefined
  /** Ambient Effect clock used for platform-neutral normalization timing. */
  readonly clock?: Clock.Clock | undefined
  /** Content-free timing evidence emitted only for non-omitted captures. */
  readonly onNormalization?:
    | ((measurement: {
        readonly channel: CaptureChannel
        readonly outcome: 'success' | 'failure'
        readonly durationSeconds: number
      }) => void)
    | undefined
}

const identityKey = (identity: RequestIdentity): string =>
  JSON.stringify([
    identity.observerSide,
    identity.connectionId,
    identity.direction,
    identity.requestId._tag,
    identity.requestId.value,
  ])

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

const streamSchemas = (descriptor: ProtocolCaptureDescriptor) => {
  const schema = descriptor.successSchema
  return schema !== undefined && RpcSchema.isStreamSchema(schema) === true
    ? { element: schema.success, error: schema.error }
    : undefined
}

const schemaForChannel = ({
  descriptor,
  channel,
}: {
  readonly descriptor: ProtocolCaptureDescriptor
  readonly channel: CaptureChannel
}): Schema.Top | undefined => {
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

const safely = (callback: () => void): void => {
  try {
    callback()
  } catch {
    /* Capture cannot change transport behavior. */
  }
}

/** Applies explorer capture policy synchronously to borrowed observer values without retaining raw content. */
export const makeCaptureSink = (options: MakeCaptureSinkOptions): CaptureSink => {
  const clock = options.clock ?? Effect.runSync(Clock.Clock)
  const requestedCapacity = options.captureCapacity ?? 1_024
  const capacity =
    Number.isSafeInteger(requestedCapacity) === true && requestedCapacity > 0
      ? requestedCapacity
      : 1_024
  const captures = new Map<
    string,
    {
      readonly descriptor: ProtocolCaptureDescriptor
      readonly notification: boolean
      retainedStreamValues: number
      completedBySend: boolean
    }
  >()
  const pending = new Map<
    string,
    { readonly trace?: TraceContext; readonly sendAttempted: boolean }
  >()
  const excludedConnections = new Map<string, boolean>()
  let nextFaultId = 1
  const bound = <T>(map: Map<string, T>): void => {
    while (map.size > capacity) {
      const oldest = map.keys().next().value
      if (oldest === undefined) return
      map.delete(oldest)
    }
  }
  const descriptorForTag = (tag: string): ProtocolCaptureDescriptor => {
    try {
      return options.descriptorForTag?.(tag) ?? { descriptorId: UnknownDescriptorId }
    } catch {
      return { descriptorId: UnknownDescriptorId }
    }
  }
  const observation = ({
    raw,
    descriptor,
  }: {
    readonly raw: RawValue
    readonly descriptor: ProtocolCaptureDescriptor
  }): ChannelObservation => {
    const channel =
      raw.channel === 'payload'
        ? 'requestPayload'
        : raw.channel === 'typedFailure' && streamSchemas(descriptor) !== undefined
          ? 'streamError'
          : raw.channel
    const startedAt = clock.currentTimeNanosUnsafe()
    const result = applyCapturePolicy({
      channel,
      value: raw.value,
      encoded: raw.encoding === 'encoded',
      decodeEncoded: channel === 'headers' ? undefined : descriptor.encodedDecoders?.[channel],
      bounds: options.normalizationBounds ?? defaultNormalizationBounds,
      host: descriptor.hostPolicies ?? options.hostPolicies,
      rpc: descriptor.policies,
      schema: schemaForChannel({ descriptor, channel }),
    })
    if (result.outcome._tag !== 'Omitted')
      safely(() =>
        options.onNormalization?.({
          channel,
          outcome: result.outcome._tag === 'Captured' ? 'success' : 'failure',
          durationSeconds:
            Math.max(0, Number(clock.currentTimeNanosUnsafe() - startedAt)) / 1_000_000_000,
        }),
      )
    return result
  }
  return {
    // oxlint-disable-next-line overeng/named-args -- The shared capture callback owns this positional signature.
    onRequest: (event, raw) => {
      const key = identityKey(event.identity)
      const descriptor = descriptorForTag(event.tag)
      captures.set(key, {
        descriptor,
        notification: event.notification,
        retainedStreamValues: 0,
        completedBySend: false,
      })
      bound(captures)
      const envelope = pending.get(key)
      pending.delete(key)
      const connectionKey = JSON.stringify([
        event.identity.observerSide,
        event.identity.connectionId,
      ])
      excludedConnections.set(
        connectionKey,
        (excludedConnections.get(connectionKey) ?? true) && descriptor.observe === 'exclude',
      )
      bound(excludedConnections)
      if (descriptor.observe === 'exclude') return
      options.store.dispatch({
        _tag: 'RequestObserved',
        at: event.at,
        request: event.identity,
        descriptorId: descriptor.descriptorId,
        notification: event.notification,
        ...(envelope?.trace === undefined ? {} : { trace: envelope.trace }),
        observations: raw.map((value) => observation({ raw: value, descriptor })),
      })
      if (envelope?.sendAttempted === true)
        options.store.dispatch({ _tag: 'SendAttempted', at: event.at, request: event.identity })
    },
    // oxlint-disable-next-line overeng/named-args -- The shared capture callback owns this positional signature.
    onChunk: (event, raw) => {
      const capture = captures.get(identityKey(event.identity))
      if (capture === undefined || capture.descriptor.observe === 'exclude') return
      const requestedLimit = options.streamValuesPerRecord ?? 0
      const limit =
        Number.isSafeInteger(requestedLimit) === true && requestedLimit >= 0 ? requestedLimit : 0
      const values = raw.slice(0, Math.max(0, limit - capture.retainedStreamValues))
      capture.retainedStreamValues += values.length
      options.store.dispatch({
        _tag: 'ChunkObserved',
        at: event.at,
        request: event.identity,
        valueCount: event.valueCount,
        values: values.map((value) => observation({ raw: value, descriptor: capture.descriptor })),
      })
    },
    // oxlint-disable-next-line overeng/named-args -- The shared capture callback owns this positional signature.
    onTerminal: (event, raw) => {
      const key = identityKey(event.identity)
      const capture = captures.get(key)
      captures.delete(key)
      pending.delete(key)
      if (
        capture === undefined ||
        capture.descriptor.observe === 'exclude' ||
        capture.completedBySend === true
      )
        return
      const requestedLimit =
        options.normalizationBounds?.maxEntries ?? defaultNormalizationBounds.maxEntries
      const limit =
        Number.isSafeInteger(requestedLimit) === true && requestedLimit >= 0 ? requestedLimit : 0
      options.store.dispatch({
        _tag: 'TerminalObserved',
        at: event.at,
        request: event.identity,
        outcome: event.outcome,
        observations: raw
          .slice(0, limit)
          .filter(
            (value) =>
              value.channel !== 'success' || streamSchemas(capture.descriptor) === undefined,
          )
          .map((value) => observation({ raw: value, descriptor: capture.descriptor })),
      })
    },
    onFault: (event) => {
      if (
        excludedConnections.get(JSON.stringify([event.observerSide, event.connectionId])) === true
      )
        return
      options.store.dispatch({
        _tag: 'ConnectionFault',
        at: event.at,
        observerSide: event.observerSide,
        connectionId: event.connectionId,
        fault: event.reason,
        faultId: `${event.observerSide}:${event.connectionId}:${nextFaultId++}`,
      })
    },
    onMessage: ({ connectionId, at, direction, phase, message, succeeded }) => {
      if (message._tag !== 'Request' && message._tag !== 'Ack' && message._tag !== 'Interrupt')
        return
      const responseDirection = direction === 'clientToServer' ? 'serverToClient' : 'clientToServer'
      const requestDirection =
        message._tag === 'Request'
          ? direction
          : options.side === 'client' && phase !== 'received'
            ? direction
            : options.side === 'server' && phase === 'received'
              ? direction
              : responseDirection
      const id = message._tag === 'Request' ? message.id : message.requestId
      const identity: RequestIdentity = {
        observerSide: options.side,
        connectionId,
        direction: requestDirection,
        requestId:
          typeof id === 'string' ? { _tag: 'String', value: id } : { _tag: 'Number', value: id },
      }
      const key = identityKey(identity)
      const capture = captures.get(key)
      if (message._tag === 'Request') {
        if (capture === undefined && phase !== 'sendFinished') {
          const trace = traceFromRequest(message)
          pending.set(key, {
            ...(trace === undefined ? {} : { trace }),
            sendAttempted: phase === 'sendAttempted',
          })
          bound(pending)
          return
        }
        if (capture === undefined || capture.descriptor.observe === 'exclude') return
        if (phase === 'sendAttempted')
          options.store.dispatch({ _tag: 'SendAttempted', at, request: identity })
        if (phase === 'sendFinished') {
          capture.completedBySend = succeeded === false || capture.notification === true
          options.store.dispatch({
            _tag: succeeded === true ? 'SendSucceeded' : 'SendFailed',
            at,
            request: identity,
          })
        }
      } else if (
        capture !== undefined &&
        capture.descriptor.observe !== 'exclude' &&
        phase !== 'sendFinished'
      ) {
        options.store.dispatch({
          _tag: message._tag === 'Ack' ? 'AckObserved' : 'InterruptObserved',
          at,
          request: identity,
        })
      }
    },
  }
}
