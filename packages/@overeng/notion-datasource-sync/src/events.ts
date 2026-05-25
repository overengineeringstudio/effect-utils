import { Schema } from 'effect'

import {
  BodyPointer,
  CapabilityName,
  CommandId,
  DataSourceId,
  Hash,
  NotionApiContract,
  NotionRequestId,
  PageId,
  PropertyId,
  QueryCursor,
  SupportedNotionApiVersion,
} from './domain.ts'
import { GuardName } from './guards.ts'

export const SyncEventId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.SyncEventId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.SyncEventId' }),
)
export type SyncEventId = typeof SyncEventId.Type

export const SyncRootId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.SyncRootId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.SyncRootId' }),
)
export type SyncRootId = typeof SyncRootId.Type

export const EventCodecVersion = Schema.Literal('v1').annotations({
  identifier: 'NotionDatasourceSync.EventCodecVersion',
})
export type EventCodecVersion = typeof EventCodecVersion.Type

export const EventFamily = Schema.Literal(
  'RemoteObserved',
  'CompatibilityChecked',
  'QueryScanRecorded',
  'LocalIntentAccepted',
  'CommandEnqueued',
  'CommandAttempted',
  'CommandSettled',
  'ConflictDetected',
  'ConflictResolved',
  'TombstoneClassified',
  'RepairObserved',
  'StorageMigrated',
).annotations({ identifier: 'NotionDatasourceSync.EventFamily' })
export type EventFamily = typeof EventFamily.Type

export const IdempotencyKey = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.IdempotencyKey'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.IdempotencyKey' }),
)
export type IdempotencyKey = typeof IdempotencyKey.Type

export const SurfaceKey = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.SurfaceKey'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.SurfaceKey' }),
)
export type SurfaceKey = typeof SurfaceKey.Type

export const VersionedJson = Schema.TaggedStruct('VersionedJson', {
  codecVersion: EventCodecVersion,
  canonicalJson: Schema.String,
}).annotations({ identifier: 'NotionDatasourceSync.VersionedJson' })
export type VersionedJson = typeof VersionedJson.Type

export const eventEnvelopeFields = <TFamily extends EventFamily, TEventType extends string>(
  family: TFamily,
  eventType: TEventType,
) =>
  ({
    eventId: SyncEventId,
    rootId: SyncRootId,
    sequence: Schema.NonNegativeBigInt,
    codecVersion: EventCodecVersion,
    family: Schema.Literal(family),
    eventType: Schema.Literal(eventType),
    idempotencyKey: IdempotencyKey,
    surface: Schema.NullOr(SurfaceKey),
    causedByEventIds: Schema.Array(SyncEventId),
    payloadHash: Hash,
    payload: VersionedJson,
    observedAt: Schema.DateTimeUtc,
  }) as const

export const ApiContractObserved = Schema.TaggedStruct('ApiContractObserved', {
  ...eventEnvelopeFields('CompatibilityChecked', 'ApiContractObserved'),
  apiContract: NotionApiContract,
}).annotations({ identifier: 'NotionDatasourceSync.ApiContractObserved' })
export type ApiContractObserved = typeof ApiContractObserved.Type

export const DataSourceObserved = Schema.TaggedStruct('DataSourceObserved', {
  ...eventEnvelopeFields('RemoteObserved', 'DataSourceObserved'),
  dataSourceId: DataSourceId,
  requestId: NotionRequestId,
  schemaHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.DataSourceObserved' })
export type DataSourceObserved = typeof DataSourceObserved.Type

export const RowObserved = Schema.TaggedStruct('RowObserved', {
  ...eventEnvelopeFields('RemoteObserved', 'RowObserved'),
  dataSourceId: DataSourceId,
  pageId: PageId,
  propertiesHash: Hash,
  bodyPointer: Schema.optional(BodyPointer),
  inTrash: Schema.Boolean,
}).annotations({ identifier: 'NotionDatasourceSync.RowObserved' })
export type RowObserved = typeof RowObserved.Type

export const LocalIntentAccepted = Schema.TaggedStruct('LocalIntentAccepted', {
  ...eventEnvelopeFields('LocalIntentAccepted', 'LocalIntentAccepted'),
  commandId: CommandId,
  pageId: Schema.optional(PageId),
  dataSourceId: Schema.optional(DataSourceId),
  intentHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.LocalIntentAccepted' })
export type LocalIntentAccepted = typeof LocalIntentAccepted.Type

export const RemoteWritePlanned = Schema.TaggedStruct('RemoteWritePlanned', {
  ...eventEnvelopeFields('CommandEnqueued', 'RemoteWritePlanned'),
  commandId: CommandId,
  commandKey: IdempotencyKey,
  intentEventId: SyncEventId,
  commandTag: Schema.String,
  baseHash: Schema.optional(Hash),
  desiredHash: Hash,
  preflight: Schema.Array(GuardName),
}).annotations({ identifier: 'NotionDatasourceSync.RemoteWritePlanned' })
export type RemoteWritePlanned = typeof RemoteWritePlanned.Type

export const RemoteWriteAttempted = Schema.TaggedStruct('RemoteWriteAttempted', {
  ...eventEnvelopeFields('CommandAttempted', 'RemoteWriteAttempted'),
  commandId: CommandId,
  attempt: Schema.NonNegativeInt,
  attemptState: Schema.Literal('running', 'retryable', 'blocked', 'fenced', 'ambiguous'),
  leaseToken: Schema.optional(Schema.NonEmptyTrimmedString),
  guard: Schema.optional(GuardName),
}).annotations({ identifier: 'NotionDatasourceSync.RemoteWriteAttempted' })
export type RemoteWriteAttempted = typeof RemoteWriteAttempted.Type

export const RemoteWriteSettled = Schema.TaggedStruct('RemoteWriteSettled', {
  ...eventEnvelopeFields('CommandSettled', 'RemoteWriteSettled'),
  commandId: CommandId,
  commandTag: Schema.String,
  requestId: NotionRequestId,
  desiredHash: Hash,
  observedHash: Hash,
  settlementKind: Schema.Literal('verified-success', 'verified-no-op'),
}).annotations({ identifier: 'NotionDatasourceSync.RemoteWriteSettled' })
export type RemoteWriteSettled = typeof RemoteWriteSettled.Type

export const ConflictRaised = Schema.TaggedStruct('ConflictRaised', {
  ...eventEnvelopeFields('ConflictDetected', 'ConflictRaised'),
  conflictKind: Schema.optional(
    Schema.Literal(
      'property',
      'body',
      'schema',
      'delete-vs-edit',
      'path',
      'relation',
      'permission',
    ),
  ),
  pageId: PageId,
  propertyId: Schema.optional(PropertyId),
  baseHash: Hash,
  localHash: Hash,
  remoteHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.ConflictRaised' })
export type ConflictRaised = typeof ConflictRaised.Type

export const TombstoneRecorded = Schema.TaggedStruct('TombstoneRecorded', {
  ...eventEnvelopeFields('TombstoneClassified', 'TombstoneRecorded'),
  pageId: PageId,
  reason: Schema.Literal(
    'remote_trash',
    'moved_out',
    'moved_between_tracked_sources',
    'inaccessible',
    'unknown',
  ),
  directClassifierEventId: Schema.optional(SyncEventId),
  destructiveIntentEventId: Schema.optional(SyncEventId),
  policyProofHash: Schema.optional(Hash),
}).annotations({ identifier: 'NotionDatasourceSync.TombstoneRecorded' })
export type TombstoneRecorded = typeof TombstoneRecorded.Type

export const TombstoneCandidateObserved = Schema.TaggedStruct('TombstoneCandidateObserved', {
  ...eventEnvelopeFields('RemoteObserved', 'TombstoneCandidateObserved'),
  pageId: PageId,
  reason: Schema.Literal(
    'query_absence_unclassified',
    'filtered_absence_not_proof',
    'permission_ambiguous',
    'local_file_delete_candidate',
  ),
}).annotations({ identifier: 'NotionDatasourceSync.TombstoneCandidateObserved' })
export type TombstoneCandidateObserved = typeof TombstoneCandidateObserved.Type

export const CapabilityPreflightChecked = Schema.TaggedStruct('CapabilityPreflightChecked', {
  ...eventEnvelopeFields('CompatibilityChecked', 'CapabilityPreflightChecked'),
  dataSourceId: DataSourceId,
  capability: CapabilityName,
  supported: Schema.Boolean,
  requestId: Schema.optional(NotionRequestId),
}).annotations({ identifier: 'NotionDatasourceSync.CapabilityPreflightChecked' })
export type CapabilityPreflightChecked = typeof CapabilityPreflightChecked.Type

export const QueryScanCheckpointRecorded = Schema.TaggedStruct('QueryScanCheckpointRecorded', {
  ...eventEnvelopeFields('QueryScanRecorded', 'QueryScanCheckpointRecorded'),
  dataSourceId: DataSourceId,
  queryContractHash: Hash,
  nextCursor: Schema.NullOr(QueryCursor),
  complete: Schema.Boolean,
  highWatermark: Schema.NullOr(Schema.DateTimeUtc),
}).annotations({ identifier: 'NotionDatasourceSync.QueryScanCheckpointRecorded' })
export type QueryScanCheckpointRecorded = typeof QueryScanCheckpointRecorded.Type

export const PagePropertyCheckpointRecorded = Schema.TaggedStruct(
  'PagePropertyCheckpointRecorded',
  {
    ...eventEnvelopeFields('QueryScanRecorded', 'PagePropertyCheckpointRecorded'),
    pageId: PageId,
    propertyId: PropertyId,
    nextCursor: Schema.NullOr(QueryCursor),
    complete: Schema.Boolean,
    valueHash: Schema.optional(Hash),
  },
).annotations({ identifier: 'NotionDatasourceSync.PagePropertyCheckpointRecorded' })
export type PagePropertyCheckpointRecorded = typeof PagePropertyCheckpointRecorded.Type

export const PathClaimed = Schema.TaggedStruct('PathClaimed', {
  ...eventEnvelopeFields('LocalIntentAccepted', 'PathClaimed'),
  pageId: PageId,
  relativePath: Schema.NonEmptyTrimmedString,
  claimState: Schema.Literal('active', 'released', 'conflict'),
}).annotations({ identifier: 'NotionDatasourceSync.PathClaimed' })
export type PathClaimed = typeof PathClaimed.Type

export const DecodeDriftBlocked = Schema.TaggedStruct('DecodeDriftBlocked', {
  ...eventEnvelopeFields('CompatibilityChecked', 'DecodeDriftBlocked'),
  apiVersion: SupportedNotionApiVersion,
  surface: Schema.String,
  message: Schema.String,
}).annotations({ identifier: 'NotionDatasourceSync.DecodeDriftBlocked' })
export type DecodeDriftBlocked = typeof DecodeDriftBlocked.Type

export const SyncEvent = Schema.Union(
  ApiContractObserved,
  DataSourceObserved,
  RowObserved,
  LocalIntentAccepted,
  RemoteWritePlanned,
  RemoteWriteAttempted,
  RemoteWriteSettled,
  ConflictRaised,
  TombstoneRecorded,
  TombstoneCandidateObserved,
  CapabilityPreflightChecked,
  QueryScanCheckpointRecorded,
  PagePropertyCheckpointRecorded,
  PathClaimed,
  DecodeDriftBlocked,
).annotations({ identifier: 'NotionDatasourceSync.SyncEvent' })
export type SyncEvent = typeof SyncEvent.Type
