import { Clock, Effect } from 'effect'
import type { Scope } from 'effect'
import type { RpcGroup } from 'effect/rpc'

import type { CaptureSink } from '@overeng/effect-rpc-observer'

import { makeDescriptorSet } from './descriptor-set.ts'
import type { DescriptorSet } from './descriptor-set.ts'
import { makeRpcDescriptors } from './descriptor.ts'
import type { RpcDescriptor } from './descriptor.ts'
import { makeInspectorGroup, InspectorRpcGroup } from './inspector.ts'
import type { InspectorGroup } from './inspector.ts'
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
} from './model.ts'
import type { CapturePolicies, EncodedValueDecoder } from './policy.ts'
import { makeCaptureSink } from './protocol.ts'
import type { ProtocolCaptureDescriptor, MakeCaptureSinkOptions } from './protocol.ts'
import { makeExplorerStore } from './store.ts'
import type { ExplorerStore, ExplorerSubscription } from './store.ts'
import { makeExplorerTelemetry } from './telemetry.ts'
import type {
  ExplorerTelemetry,
  ExplorerTelemetryOptions,
  ExplorerTelemetryRegistrationError,
} from './telemetry.ts'

/** Stable identity supplied to the host capture selector; never includes request values. */
export type ExplorerCaptureDescriptor = Pick<RpcDescriptor, 'descriptorId' | 'key' | 'tag' | 'kind'>

/** Host-wide policy map or a once-per-descriptor selector evaluated at construction. */
export type ExplorerCaptureConfig =
  | CapturePolicies
  | ((descriptor: ExplorerCaptureDescriptor) => CapturePolicies | undefined)
/** Host-owned inputs for one scoped explorer instance. */
export interface ExplorerConfig {
  readonly instanceId: string
  readonly bounds: ExplorerBounds
  readonly capture?: ExplorerCaptureConfig | undefined
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

/** Named capture input bound to one observer side and concrete transport codec. */
export interface ExplorerCaptureSinkOptions {
  readonly side: ObserverSide
  readonly encodedDecodersByTag?: ExplorerEncodedDecodersByTag | undefined
}

/** Named input for one runtime-mounted RPC group's descriptor registration. */
export interface RegisterDescriptorsOptions {
  readonly group: RpcGroup.Any
  /** Stable mount identity; registering an owner again replaces its previous descriptors. */
  readonly owner: string
}

/** Complete host-facing surface owned by one scoped explorer instance. */
export interface ExplorerServices {
  /**
   * Current application descriptors: the construction group plus live runtime registrations.
   * The inspector never appears in its own UI model.
   */
  readonly descriptors: DescriptorSet
  /**
   * Registers a runtime-mounted group's descriptors for the lifetime of the caller's Scope.
   * Construction-group tags keep their descriptors; a runtime tag stays resolvable while any
   * owner holds it, served by the most recent registration. Closing a replaced registration's
   * Scope is a no-op.
   */
  readonly registerDescriptors: (
    options: RegisterDescriptorsOptions,
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly store: ExplorerStore
  /** Builds the explorer policy adapter registered as a capture-enabled observer sink. */
  readonly makeCaptureSink: (options: ExplorerCaptureSinkOptions) => CaptureSink
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

const captureDescriptor = ({
  descriptor,
  hostPolicies,
}: {
  readonly descriptor: RpcDescriptor
  readonly hostPolicies?: CapturePolicies | undefined
}): ProtocolCaptureDescriptor => {
  const live = descriptor.live
  return live === undefined
    ? { descriptorId: descriptor.descriptorId, observe: descriptor.observe, hostPolicies }
    : {
        descriptorId: descriptor.descriptorId,
        observe: descriptor.observe,
        hostPolicies,
        policies: live.policies,
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
    const clock = yield* Clock.Clock
    const applicationDescriptors = makeDescriptorSet(makeRpcDescriptors(group))
    // Host capture resolves once per descriptor, at construction or at its registration.
    const captureDescriptors = new WeakMap<RpcDescriptor, ProtocolCaptureDescriptor>()
    const resolveCapture = (descriptor: RpcDescriptor): ProtocolCaptureDescriptor => {
      const cached = captureDescriptors.get(descriptor)
      if (cached !== undefined) return cached
      const { descriptorId, key, tag, kind } = descriptor
      const hostPolicies =
        typeof config.capture === 'function'
          ? config.capture({ descriptorId, key, tag, kind })
          : config.capture
      const resolved = captureDescriptor({ descriptor, hostPolicies })
      captureDescriptors.set(descriptor, resolved)
      return resolved
    }
    for (const descriptor of applicationDescriptors.current().descriptors) {
      resolveCapture(descriptor)
    }
    const inspectorDescriptorsByTag = new Map(
      makeRpcDescriptors(InspectorRpcGroup).map(
        (descriptor) => [descriptor.tag, resolveCapture(descriptor)] as const,
      ),
    )
    const captureDescriptorForTag = (tag: string): ProtocolCaptureDescriptor | undefined => {
      const inspectorDescriptor = inspectorDescriptorsByTag.get(tag)
      if (inspectorDescriptor !== undefined) return inspectorDescriptor
      const descriptor = applicationDescriptors.descriptorForTag(tag)
      return descriptor === undefined ? undefined : resolveCapture(descriptor)
    }
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
    }): MakeCaptureSinkOptions => ({
      store,
      side: observerSide,
      clock,
      descriptorForTag: (tag) => {
        const descriptor = captureDescriptorForTag(tag)
        const encodedDecoders = encodedDecodersByTag?.get(tag)
        return descriptor === undefined || encodedDecoders === undefined
          ? descriptor
          : { ...descriptor, encodedDecoders }
      },
      normalizationBounds: config.bounds.normalized,
      onNormalization: ({ channel, outcome, durationSeconds }) =>
        runTelemetry(
          telemetry.normalizationDuration({
            captureChannel: channel,
            outcome,
            durationSeconds,
          }),
        ),
      streamValuesPerRecord: config.bounds.streamValuesPerRecord,
      captureCapacity: Math.max(1, config.bounds.active.maxCount),
    })
    const inspector = makeInspectorGroup({
      store,
      descriptors: applicationDescriptors,
    })

    const registerDescriptors = ({
      group: mountedGroup,
      owner,
    }: RegisterDescriptorsOptions): Effect.Effect<void, never, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const descriptors = makeRpcDescriptors(mountedGroup)
          for (const descriptor of descriptors) resolveCapture(descriptor)
          return applicationDescriptors.register({ owner, descriptors })
        }),
        (release) => Effect.sync(release),
      ).pipe(Effect.asVoid)

    return {
      descriptors: {
        current: applicationDescriptors.current,
        subscribe: applicationDescriptors.subscribe,
      },
      registerDescriptors,
      store,
      makeCaptureSink: ({ side, encodedDecodersByTag }) =>
        makeCaptureSink(optionsFor({ observerSide: side, encodedDecodersByTag })),
      inspector,
      telemetry,
    }
  })
