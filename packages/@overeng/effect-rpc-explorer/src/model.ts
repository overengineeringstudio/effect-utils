import { Schema } from 'effect'

/** Stable wire major shared by snapshot, delta, and reset frames. */
export const ProtocolVersion = Schema.Literal('rpc-explorer.v1').annotate({
  identifier: 'RpcExplorer.ProtocolVersion',
})
export type ProtocolVersion = typeof ProtocolVersion.Type

/** Process-local observation boundary that prevents client/server key collisions. */
export const ObserverSide = Schema.Literals(['client', 'server']).annotate({
  identifier: 'RpcExplorer.ObserverSide',
})
export type ObserverSide = typeof ObserverSide.Type

/** Encoded request flow used as part of correlation identity. */
export const Direction = Schema.Literals(['clientToServer', 'serverToClient']).annotate({
  identifier: 'RpcExplorer.Direction',
})
export type Direction = typeof Direction.Type

/** Preserves the protocol's original string-or-number request ID type. */
export const RequestId = Schema.Union([
  Schema.TaggedStruct('String', { value: Schema.String }),
  Schema.TaggedStruct('Number', { value: Schema.Finite }),
]).annotate({ identifier: 'RpcExplorer.RequestId' })
export type RequestId = typeof RequestId.Type

/** Full correlation key; no field may be dropped or string-coerced. */
export const RequestIdentity = Schema.Struct({
  observerSide: ObserverSide,
  connectionId: Schema.NonEmptyString,
  direction: Direction,
  requestId: RequestId,
}).annotate({ identifier: 'RpcExplorer.RequestIdentity' })
export type RequestIdentity = typeof RequestIdentity.Type

/** Paired monotonic/display time captured at one observation point. */
export const Timestamp = Schema.Struct({
  monotonicNanos: Schema.String,
  wallClockMillis: Schema.Finite,
}).annotate({ identifier: 'RpcExplorer.Timestamp' })
export type Timestamp = typeof Timestamp.Type

/** Optional application trace correlation copied without inventing identifiers. */
export const TraceContext = Schema.Struct({
  traceId: Schema.NonEmptyString,
  spanId: Schema.optionalKey(Schema.NonEmptyString),
  sampled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: 'RpcExplorer.TraceContext' })
export type TraceContext = typeof TraceContext.Type

/** Detached algebra permitted to cross the capture-to-store security boundary. */
export type NormalizedValue =
  | { readonly _tag: 'Null' }
  | { readonly _tag: 'Boolean'; readonly value: boolean }
  | {
      readonly _tag: 'Number'
      readonly value: number | 'NaN' | '+Infinity' | '-Infinity'
    }
  | { readonly _tag: 'String'; readonly value: string }
  | { readonly _tag: 'BigInt'; readonly value: string }
  | { readonly _tag: 'Bytes'; readonly base64: string; readonly byteLength: number }
  | { readonly _tag: 'Array'; readonly value: ReadonlyArray<NormalizedValue> }
  | {
      readonly _tag: 'Object'
      readonly value: Readonly<Record<string, NormalizedValue>>
    }
  | { readonly _tag: 'Redacted'; readonly label?: string }
  | { readonly _tag: 'Unsupported'; readonly type: string }
  | {
      readonly _tag: 'Truncated'
      readonly reason: 'depth' | 'entries' | 'bytes'
      readonly retained?: NormalizedValue
    }

const NormalizedValueRef: Schema.Codec<NormalizedValue> = Schema.suspend(
  (): Schema.Codec<NormalizedValue> => NormalizedValue,
)

/** Recursive schema for retained values after policy and normalization. */
export const NormalizedValue: Schema.Codec<NormalizedValue> = Schema.Union([
  Schema.TaggedStruct('Null', {}),
  Schema.TaggedStruct('Boolean', { value: Schema.Boolean }),
  Schema.TaggedStruct('Number', {
    value: Schema.Union([Schema.Finite, Schema.Literals(['NaN', '+Infinity', '-Infinity'])]),
  }),
  Schema.TaggedStruct('String', { value: Schema.String }),
  Schema.TaggedStruct('BigInt', { value: Schema.String }),
  Schema.TaggedStruct('Bytes', {
    base64: Schema.String,
    byteLength: Schema.Natural,
  }),
  Schema.TaggedStruct('Array', { value: Schema.Array(NormalizedValueRef) }),
  Schema.TaggedStruct('Object', {
    value: Schema.Record(Schema.String, NormalizedValueRef),
  }),
  Schema.TaggedStruct('Redacted', {
    label: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct('Unsupported', { type: Schema.String }),
  Schema.TaggedStruct('Truncated', {
    reason: Schema.Literals(['depth', 'entries', 'bytes']),
    retained: Schema.optionalKey(NormalizedValueRef),
  }),
]).annotate({ identifier: 'RpcExplorer.NormalizedValue' })

/** Exhaustive channel order used by resolution tests and host configuration. */
export const CaptureChannels = [
  'requestPayload',
  'success',
  'typedFailure',
  'defect',
  'streamElement',
  'streamError',
  'headers',
] as const

/** Schema for the seven independently governed capture channels. */
export const CaptureChannel = Schema.Literals(CaptureChannels).annotate({
  identifier: 'RpcExplorer.CaptureChannel',
})
export type CaptureChannel = typeof CaptureChannel.Type

/** Precedence layer that supplied a resolved channel policy. */
export const PolicySource = Schema.Literals(['host', 'rpc', 'schema', 'default']).annotate({
  identifier: 'RpcExplorer.PolicySource',
})
export type PolicySource = typeof PolicySource.Type

const OmittedPolicyOutcome = Schema.TaggedStruct('Omitted', {
  source: PolicySource,
}).annotate({ identifier: 'RpcExplorer.PolicyOutcome.Omitted' })

const CapturedPolicyOutcome = Schema.TaggedStruct('Captured', {
  mode: Schema.Literals(['reveal', 'redact']),
  source: Schema.Literals(['host', 'rpc', 'schema']),
}).annotate({ identifier: 'RpcExplorer.PolicyOutcome.Captured' })

const PolicyFaultOutcome = Schema.TaggedStruct('PolicyFault', {
  source: Schema.Literals(['host', 'rpc', 'schema']),
  fault: Schema.Literals(['transform', 'normalize']),
}).annotate({ identifier: 'RpcExplorer.PolicyOutcome.PolicyFault' })

/** Strict outcome union that never attaches content to omission or faults. */
export const PolicyOutcome = Schema.Union([
  OmittedPolicyOutcome,
  CapturedPolicyOutcome,
  PolicyFaultOutcome,
]).annotate({ identifier: 'RpcExplorer.PolicyOutcome' })
export type PolicyOutcome = typeof PolicyOutcome.Type

/** Only policy-safe value container accepted by event construction and storage. */
export const ChannelObservation = Schema.Union([
  Schema.Struct({ channel: CaptureChannel, outcome: OmittedPolicyOutcome }),
  Schema.Struct({
    channel: CaptureChannel,
    outcome: CapturedPolicyOutcome,
    captured: NormalizedValue,
  }),
  Schema.Struct({ channel: CaptureChannel, outcome: PolicyFaultOutcome }),
]).annotate({ identifier: 'RpcExplorer.ChannelObservation' })
export type ChannelObservation = typeof ChannelObservation.Type

/** Content-free descriptor sentinel used when logical RPC mapping fails. */
export const UnknownDescriptorId = 'unknown:unmapped' as const

const EventId = Schema.Natural
const Revision = Schema.Natural
const EventObservations = Schema.Array(ChannelObservation)
const EventTrace = Schema.optionalKey(TraceContext)

const RequestObservedEvent = Schema.TaggedStruct('RequestObserved', {
  eventId: EventId,
  revision: Revision,
  at: Timestamp,
  request: RequestIdentity,
  descriptorId: Schema.NonEmptyString,
  notification: Schema.Boolean,
  trace: EventTrace,
  observations: EventObservations,
})

const SendAttemptedEvent = Schema.TaggedStruct('SendAttempted', {
  eventId: EventId,
  revision: Revision,
  at: Timestamp,
  request: RequestIdentity,
})

const SendSucceededEvent = Schema.TaggedStruct('SendSucceeded', {
  eventId: EventId,
  revision: Revision,
  at: Timestamp,
  request: RequestIdentity,
})

const SendFailedEvent = Schema.TaggedStruct('SendFailed', {
  eventId: EventId,
  revision: Revision,
  at: Timestamp,
  request: RequestIdentity,
})

const ChunkObservedEvent = Schema.TaggedStruct('ChunkObserved', {
  eventId: EventId,
  revision: Revision,
  at: Timestamp,
  request: RequestIdentity,
  valueCount: Schema.Natural,
  values: Schema.Array(ChannelObservation),
})

const AckObservedEvent = Schema.TaggedStruct('AckObserved', {
  eventId: EventId,
  revision: Revision,
  at: Timestamp,
  request: RequestIdentity,
})

const InterruptObservedEvent = Schema.TaggedStruct('InterruptObserved', {
  eventId: EventId,
  revision: Revision,
  at: Timestamp,
  request: RequestIdentity,
})

const TerminalObservedEvent = Schema.TaggedStruct('TerminalObserved', {
  eventId: EventId,
  revision: Revision,
  at: Timestamp,
  request: RequestIdentity,
  outcome: Schema.Literals(['success', 'typedFailure', 'defect', 'interrupted']),
  observations: EventObservations,
})

const ConnectionFaultEvent = Schema.TaggedStruct('ConnectionFault', {
  eventId: EventId,
  revision: Revision,
  at: Timestamp,
  connectionId: Schema.NonEmptyString,
  fault: Schema.Literals(['defect', 'clientProtocolError', 'disconnect', 'eof']),
  faultId: Schema.NonEmptyString,
})

const LateEvent = Schema.TaggedStruct('LateEvent', {
  eventId: EventId,
  revision: Revision,
  at: Timestamp,
  request: RequestIdentity,
  eventTag: Schema.Literal('TerminalObserved'),
})

/** Versioned lifecycle facts after content policy has already been applied. */
export const ExplorerEvent = Schema.Union([
  RequestObservedEvent,
  SendAttemptedEvent,
  SendSucceededEvent,
  SendFailedEvent,
  ChunkObservedEvent,
  AckObservedEvent,
  InterruptObservedEvent,
  TerminalObservedEvent,
  ConnectionFaultEvent,
  LateEvent,
]).annotate({ identifier: 'RpcExplorer.ExplorerEvent' })
export type ExplorerEvent = typeof ExplorerEvent.Type

type ObservableExplorerEvent = Exclude<ExplorerEvent, { readonly _tag: 'LateEvent' }>
type WithoutStoreFields<TEvent> = TEvent extends ObservableExplorerEvent
  ? Omit<TEvent, 'eventId' | 'revision'>
  : never
/** Safe observer input; store-owned event IDs and revisions are allocated later. */
export type ExplorerEventInput = WithoutStoreFields<ObservableExplorerEvent>

/** Request lifecycle projection, including explicit uncertainty and notifications. */
export const RecordState = Schema.Literals([
  'sending',
  'sent',
  'awaiting',
  'streaming',
  'cancellationRequested',
  'sendFailed',
  'succeeded',
  'failed',
  'defect',
  'interrupted',
  'uncertain',
  'notificationSent',
]).annotate({ identifier: 'RpcExplorer.RecordState' })
export type RecordState = typeof RecordState.Type

/** Transport-send fact kept independent from handler completion. */
export const SendState = Schema.Literals(['unobserved', 'attempted', 'sent', 'failed']).annotate({
  identifier: 'RpcExplorer.SendState',
})
export type SendState = typeof SendState.Type

/** Content-free anomaly and retention evidence attached to aggregate records. */
export const RecordEvidence = Schema.Union([
  Schema.TaggedStruct('UnknownDescriptor', {}),
  Schema.TaggedStruct('LateEvent', {
    eventTag: Schema.Literal('TerminalObserved'),
  }),
  Schema.TaggedStruct('ConnectionFault', {
    faultId: Schema.NonEmptyString,
    fault: Schema.Literals(['defect', 'clientProtocolError', 'disconnect', 'eof']),
  }),
  Schema.TaggedStruct('RetentionExpired', {
    reason: Schema.Literals(['count', 'age']),
  }),
  Schema.TaggedStruct('ValuesTruncated', { count: Schema.Natural }),
]).annotate({ identifier: 'RpcExplorer.RecordEvidence' })
export type RecordEvidence = typeof RecordEvidence.Type

/** Aggregate projection for one typed request identity. */
export const RpcRecord = Schema.Struct({
  key: RequestIdentity,
  descriptorId: Schema.NonEmptyString,
  state: RecordState,
  notification: Schema.Boolean,
  startedAt: Timestamp,
  lastAt: Timestamp,
  trace: Schema.optionalKey(TraceContext),
  send: SendState,
  chunkEnvelopes: Schema.Natural,
  streamValues: Schema.Natural,
  retainedStreamValues: Schema.Natural,
  events: Schema.Array(EventId),
  evidence: Schema.Array(RecordEvidence),
}).annotate({ identifier: 'RpcExplorer.RpcRecord' })
export type RpcRecord = typeof RpcRecord.Type

/** Independent depth, entry, and encoded-byte limits for one normalized value. */
export const NormalizationBounds = Schema.Struct({
  maxDepth: Schema.Natural,
  maxEntries: Schema.Natural,
  maxBytes: Schema.Natural,
}).annotate({ identifier: 'RpcExplorer.NormalizationBounds' })
export type NormalizationBounds = typeof NormalizationBounds.Type

const RetentionBound = Schema.Struct({
  maxCount: Schema.Natural,
  maxAge: Schema.Duration,
})

/** Independent retention and queue limits for every bounded store surface. */
export const ExplorerBounds = Schema.Struct({
  completed: RetentionBound,
  active: RetentionBound,
  streamValuesPerRecord: Schema.Natural,
  normalized: NormalizationBounds,
  deltas: RetentionBound,
  subscriberQueue: Schema.Natural,
}).annotate({ identifier: 'RpcExplorer.ExplorerBounds' })
export type ExplorerBounds = typeof ExplorerBounds.Type

/** Content-free cumulative evidence of retention loss and subscriber resets. */
export const RetentionCounters = Schema.Struct({
  activeEvicted: Schema.Natural,
  completedEvicted: Schema.Natural,
  streamValuesTruncated: Schema.Natural,
  subscriberResets: Schema.Natural,
}).annotate({ identifier: 'RpcExplorer.RetentionCounters' })
export type RetentionCounters = typeof RetentionCounters.Type

/** Complete point-in-time model used to start or reset a watch. */
export const SnapshotFrame = Schema.TaggedStruct('Snapshot', {
  protocolVersion: ProtocolVersion,
  instanceId: Schema.NonEmptyString,
  revision: Revision,
  active: Schema.Array(RpcRecord),
  completed: Schema.Array(RpcRecord),
  events: Schema.Array(ExplorerEvent),
  counters: RetentionCounters,
}).annotate({ identifier: 'RpcExplorer.SnapshotFrame' })
export type SnapshotFrame = typeof SnapshotFrame.Type

/** Ordered mutation operations carried by a single revision delta. */
export const DeltaOperation = Schema.Union([
  Schema.TaggedStruct('UpsertRecord', {
    bucket: Schema.Literals(['active', 'completed']),
    record: RpcRecord,
  }),
  Schema.TaggedStruct('RemoveRecord', {
    bucket: Schema.Literals(['active', 'completed']),
    key: RequestIdentity,
  }),
  Schema.TaggedStruct('AppendEvent', { event: ExplorerEvent }),
  Schema.TaggedStruct('RemoveEvent', { eventId: EventId }),
  Schema.TaggedStruct('CountersChanged', { counters: RetentionCounters }),
]).annotate({ identifier: 'RpcExplorer.DeltaOperation' })
export type DeltaOperation = typeof DeltaOperation.Type

/** Exactly one accepted mutation from one revision to the next. */
export const DeltaFrame = Schema.TaggedStruct('Delta', {
  protocolVersion: ProtocolVersion,
  fromRevision: Revision,
  toRevision: Revision,
  operations: Schema.Array(DeltaOperation),
}).annotate({ identifier: 'RpcExplorer.DeltaFrame' })
export type DeltaFrame = typeof DeltaFrame.Type

/** Content-free instruction to discard replay state before applying a snapshot. */
export const ResetFrame = Schema.TaggedStruct('Reset', {
  protocolVersion: ProtocolVersion,
  reason: Schema.Literals(['behind', 'overflow', 'cleared', 'instanceChanged']),
  revision: Revision,
}).annotate({ identifier: 'RpcExplorer.ResetFrame' })
export type ResetFrame = typeof ResetFrame.Type

/** Frames emitted by the race-free in-process watch subscription. */
export const WatchFrame = Schema.Union([SnapshotFrame, DeltaFrame, ResetFrame]).annotate({
  identifier: 'RpcExplorer.WatchFrame',
})
export type WatchFrame = typeof WatchFrame.Type
