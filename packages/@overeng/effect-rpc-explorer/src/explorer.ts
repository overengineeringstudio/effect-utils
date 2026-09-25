import { Effect } from 'effect'
import type { Scope } from 'effect'
import type { RpcClient, RpcGroup, RpcMiddleware, RpcServer } from 'effect/unstable/rpc'

import { makeRpcDescriptors } from './descriptor.ts'
import type { RpcDescriptor } from './descriptor.ts'
import { makeInspectorGroup, InspectorRpcGroup } from './inspector.ts'
import type { InspectorGroup } from './inspector.ts'
import { makeServerExplorerMiddleware } from './middleware.ts'
import type {
  ChannelObservation,
  CaptureChannel,
  ExplorerBounds,
  ExplorerEvent,
  ExplorerEventInput,
  ObserverSide,
  RequestIdentity,
  RpcRecord,
  SnapshotFrame,
  Timestamp,
} from './model.ts'
import type { CapturePolicies, EncodedValueDecoder } from './policy.ts'
import { decorateClientProtocol, decorateServerProtocol } from './protocol.ts'
import type { ProtocolCaptureDescriptor, ProtocolObserverOptions } from './protocol.ts'
import { makeExplorerStore } from './store.ts'
import type { ExplorerStore, ExplorerSubscription } from './store.ts'
import { makeExplorerTelemetry } from './telemetry.ts'
import type {
  ExplorerTelemetry,
  ExplorerTelemetryOptions,
  ExplorerTelemetryRegistrationError,
} from './telemetry.ts'

/** Host clock used to make explorer ordering deterministic without owning wall-clock services. */
export interface ExplorerClock {
  readonly now: () => Timestamp
}

/** Input used to derive one explorer-lifetime-local transport connection identity. */
export interface ExplorerConnectionIdentity {
  readonly observerSide: ObserverSide
  readonly clientId: number
}

/** Host-owned inputs for one scoped explorer instance. */
export interface ExplorerConfig {
  readonly instanceId: string
  readonly bounds: ExplorerBounds
  readonly capture?: CapturePolicies | undefined
  readonly clock?: ExplorerClock | undefined
  readonly connectionId?: ((identity: ExplorerConnectionIdentity) => string) | undefined
  readonly telemetry: Omit<ExplorerTelemetryOptions, 'readRetainedCounts'>
}

/** Named arguments for constructing one explorer from an application RPC group. */
export interface MakeExplorerOptions {
  readonly group: RpcGroup.Any
  readonly config: ExplorerConfig
}

/** Codec-bound decoders for encoded capture channels, keyed by exact RPC tag. */
export type ExplorerEncodedDecodersByTag = ReadonlyMap<
  string,
  Readonly<Partial<Record<Exclude<CaptureChannel, 'headers'>, EncodedValueDecoder>>>
>

/** Named client decorator input bound to one concrete transport codec. */
export interface ExplorerClientDecoratorOptions {
  readonly protocol: RpcClient.Protocol['Service']
  readonly encodedDecodersByTag?: ExplorerEncodedDecodersByTag | undefined
}

/** Named server decorator input bound to one concrete transport codec. */
export interface ExplorerServerDecoratorOptions {
  readonly protocol: RpcServer.Protocol['Service']
  readonly encodedDecodersByTag?: ExplorerEncodedDecodersByTag | undefined
  readonly requestObservation?: 'protocol' | 'middleware' | undefined
}

/** Complete host-facing surface owned by one scoped explorer instance. */
export interface ExplorerServices {
  /** Application descriptors only; the inspector never appears in its own UI model. */
  readonly descriptors: ReadonlyArray<RpcDescriptor>
  readonly store: ExplorerStore
  readonly middleware: RpcMiddleware.RpcMiddleware<never, never, never>
  readonly decorateClientProtocol: (
    options: ExplorerClientDecoratorOptions,
  ) => RpcClient.Protocol['Service']
  readonly decorateServerProtocol: (
    options: ExplorerServerDecoratorOptions,
  ) => RpcServer.Protocol['Service']
  readonly inspector: InspectorGroup
  readonly telemetry: ExplorerTelemetry
}

const requestIdentityKey = (identity: RequestIdentity): string =>
  JSON.stringify([
    identity.observerSide,
    identity.connectionId,
    identity.direction,
    identity.requestId._tag,
    identity.requestId.value,
  ])

const activeRecords = (records: ReadonlyArray<RpcRecord>): Map<string, RpcRecord> =>
  new Map(records.map((record) => [requestIdentityKey(record.key), record]))

const observationsFor = (event: ExplorerEvent): ReadonlyArray<ChannelObservation> => {
  switch (event._tag) {
    case 'RequestObserved':
    case 'TerminalObserved':
      return event.observations
    case 'ChunkObserved':
      return event.values
    default:
      return []
  }
}

const requestForEvent = ({
  event,
  before,
}: {
  readonly event: ExplorerEvent
  readonly before: ReadonlyArray<RpcRecord>
}): RequestIdentity | undefined => {
  if (event._tag !== 'ConnectionFault') return event.request
  return before.find((record) => record.key.connectionId === event.connectionId)?.key
}

const captureDescriptor = (descriptor: RpcDescriptor): ProtocolCaptureDescriptor => {
  const live = descriptor.live
  return live === undefined
    ? { descriptorId: descriptor.descriptorId, observe: descriptor.observe }
    : {
        descriptorId: descriptor.descriptorId,
        observe: descriptor.observe,
        payloadSchema: live.payloadSchema,
        successSchema: live.successSchema,
        errorSchema: live.errorSchema,
        defectSchema: live.defectSchema,
      }
}

const makeInstrumentedStore = ({
  store,
  telemetry,
  runTelemetry,
}: {
  readonly store: ExplorerStore
  readonly telemetry: ExplorerTelemetry
  readonly runTelemetry: (effect: Effect.Effect<void>) => void
}): ExplorerStore => {
  let previousSnapshot = store.snapshot()
  const reportMutation = ({
    event,
    before,
    after,
  }: {
    readonly event: ExplorerEvent
    readonly before: SnapshotFrame
    readonly after: SnapshotFrame
  }): void => {
    const request = requestForEvent({ event, before: before.active })
    if (request !== undefined) {
      runTelemetry(
        telemetry.event({
          eventKind: event._tag,
          observerSide: request.observerSide,
          direction: request.direction,
        }),
      )
    }

    for (const observation of observationsFor(event)) {
      if (observation.outcome._tag === 'Omitted') {
        runTelemetry(
          telemetry.drop({ reason: 'policyOmitted', captureChannel: observation.channel }),
        )
      } else if (observation.outcome._tag === 'PolicyFault') {
        runTelemetry(telemetry.drop({ reason: 'policyFault', captureChannel: observation.channel }))
      }
    }

    const beforeActive = activeRecords(before.active)
    const afterActive = activeRecords(after.active)
    for (const [key, record] of afterActive) {
      if (beforeActive.has(key) === true) continue
      runTelemetry(
        telemetry.activeDelta({
          observerSide: record.key.observerSide,
          direction: record.key.direction,
          delta: 1,
        }),
      )
    }
    for (const [key, record] of beforeActive) {
      if (afterActive.has(key) === true) continue
      runTelemetry(
        telemetry.activeDelta({
          observerSide: record.key.observerSide,
          direction: record.key.direction,
          delta: -1,
        }),
      )
    }

    const activeEvicted = after.counters.activeEvicted - before.counters.activeEvicted
    const completedEvicted = after.counters.completedEvicted - before.counters.completedEvicted
    const streamValuesTruncated =
      after.counters.streamValuesTruncated - before.counters.streamValuesTruncated
    for (let index = 0; index < activeEvicted; index += 1) {
      runTelemetry(telemetry.drop({ reason: 'activeRetention' }))
    }
    for (let index = 0; index < completedEvicted; index += 1) {
      runTelemetry(telemetry.drop({ reason: 'completedRetention' }))
    }
    for (let index = 0; index < streamValuesTruncated; index += 1) {
      runTelemetry(telemetry.drop({ reason: 'streamLimit' }))
    }
  }

  const watch = (options?: Parameters<ExplorerStore['watch']>[0]): ExplorerSubscription => {
    const subscription = store.watch(options)
    return {
      close: subscription.close,
      drain: () => {
        const frames = subscription.drain()
        for (const frame of frames) {
          if (frame._tag === 'Reset' && frame.reason !== 'instanceChanged') {
            runTelemetry(telemetry.subscriberReset({ reason: frame.reason }))
          }
        }
        return frames
      },
    }
  }

  const dispatch = (input: ExplorerEventInput): ExplorerEvent | undefined => {
    const event = store.dispatch(input)
    if (event === undefined) return undefined
    const nextSnapshot = store.snapshot()
    reportMutation({ event, before: previousSnapshot, after: nextSnapshot })
    previousSnapshot = nextSnapshot
    return event
  }

  const clearHistory = (): number => {
    const revision = store.clearHistory()
    previousSnapshot = store.snapshot()
    return revision
  }

  return { dispatch, snapshot: store.snapshot, watch, clearHistory }
}

/**
 * Builds one scoped explorer composition. A plain object cannot inhabit a Layer success channel in
 * Effect 4 (that channel contains Context service identifiers), so this constructor returns the
 * scoped service value directly and keeps telemetry registration tied to the caller's Scope.
 */
export const makeExplorer = ({
  group,
  config,
}: MakeExplorerOptions): Effect.Effect<
  ExplorerServices,
  ExplorerTelemetryRegistrationError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const applicationDescriptors = makeRpcDescriptors(group)
    const inspectorDescriptors = makeRpcDescriptors(InspectorRpcGroup)
    const descriptorsByTag = new Map(
      [...applicationDescriptors, ...inspectorDescriptors].map((descriptor) => [
        descriptor.tag,
        captureDescriptor(descriptor),
      ]),
    )
    let reportDeltaEvicted: ((count: number) => void) | undefined
    const rawStore = makeExplorerStore({
      instanceId: config.instanceId,
      bounds: config.bounds,
      onDeltaEvicted: (count) => reportDeltaEvicted?.(count),
    })
    const runtime = yield* Effect.context<never>()
    const telemetry = yield* makeExplorerTelemetry({
      ...config.telemetry,
      readRetainedCounts: () => {
        const snapshot = rawStore.snapshot()
        return { active: snapshot.active.length, completed: snapshot.completed.length }
      },
    })
    const runTelemetry = (effect: Effect.Effect<void>): void => {
      try {
        Effect.runSyncWith(runtime)(effect)
      } catch {
        // Observation and host telemetry are best effort and cannot alter RPC transport behavior.
      }
    }
    reportDeltaEvicted = (count) => {
      for (let index = 0; index < count; index += 1) {
        runTelemetry(telemetry.drop({ reason: 'deltaRetention' }))
      }
    }
    const store = makeInstrumentedStore({ store: rawStore, telemetry, runTelemetry })
    const optionsFor = ({
      observerSide,
      encodedDecodersByTag,
    }: {
      readonly observerSide: ObserverSide
      readonly encodedDecodersByTag?: ExplorerEncodedDecodersByTag | undefined
    }): ProtocolObserverOptions => ({
      store,
      descriptorForTag: (tag) => {
        const descriptor = descriptorsByTag.get(tag)
        const encodedDecoders = encodedDecodersByTag?.get(tag)
        return descriptor === undefined || encodedDecoders === undefined
          ? descriptor
          : { ...descriptor, encodedDecoders }
      },
      hostPolicies: config.capture,
      normalizationBounds: config.bounds.normalized,
      onNormalization: ({ channel, outcome, durationSeconds }) =>
        runTelemetry(
          telemetry.normalizationDuration({
            captureChannel: channel,
            outcome,
            durationSeconds,
          }),
        ),
      coordinatorCapacity: Math.max(1, config.bounds.active.maxCount),
      ...(config.clock === undefined ? {} : { timestamp: config.clock.now }),
      ...(config.connectionId === undefined
        ? {}
        : {
            connectionId: (clientId: number) =>
              config.connectionId?.({ observerSide, clientId }) ?? String(clientId),
          }),
    })
    const middlewareOptions = optionsFor({ observerSide: 'server' })
    const inspector = makeInspectorGroup({
      store,
      descriptors: applicationDescriptors,
    })

    return {
      descriptors: applicationDescriptors,
      store,
      middleware: makeServerExplorerMiddleware(middlewareOptions),
      decorateClientProtocol: ({ protocol, encodedDecodersByTag }) =>
        decorateClientProtocol(
          protocol,
          optionsFor({ observerSide: 'client', encodedDecodersByTag }),
        ),
      decorateServerProtocol: ({
        protocol,
        encodedDecodersByTag,
        requestObservation = 'protocol',
      }) =>
        decorateServerProtocol(protocol, {
          ...optionsFor({ observerSide: 'server', encodedDecodersByTag }),
          requestObservation,
        }),
      inspector,
      telemetry,
    }
  })
