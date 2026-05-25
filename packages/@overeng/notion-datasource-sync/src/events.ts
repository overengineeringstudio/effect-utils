import { Schema } from 'effect'

import {
  BodyPointer,
  CommandId,
  DataSourceId,
  Hash,
  NotionApiContract,
  NotionRequestId,
  PageId,
  PropertyId,
  SupportedNotionApiVersion,
} from './domain.ts'

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
  'compatibility',
  'remote-observation',
  'local-intent',
  'command',
  'conflict',
  'tombstone',
  'repair',
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

export const EventEnvelopeFields = {
  eventId: SyncEventId,
  rootId: SyncRootId,
  sequence: Schema.NonNegativeBigInt,
  codecVersion: EventCodecVersion,
  family: EventFamily,
  eventType: Schema.NonEmptyTrimmedString,
  idempotencyKey: IdempotencyKey,
  surface: Schema.NullOr(SurfaceKey),
  causedByEventIds: Schema.Array(SyncEventId),
  payloadHash: Hash,
  payload: VersionedJson,
  observedAt: Schema.DateTimeUtc,
} as const

export const ApiContractObserved = Schema.TaggedStruct('ApiContractObserved', {
  ...EventEnvelopeFields,
  apiContract: NotionApiContract,
}).annotations({ identifier: 'NotionDatasourceSync.ApiContractObserved' })
export type ApiContractObserved = typeof ApiContractObserved.Type

export const DataSourceObserved = Schema.TaggedStruct('DataSourceObserved', {
  ...EventEnvelopeFields,
  dataSourceId: DataSourceId,
  requestId: NotionRequestId,
  schemaHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.DataSourceObserved' })
export type DataSourceObserved = typeof DataSourceObserved.Type

export const RowObserved = Schema.TaggedStruct('RowObserved', {
  ...EventEnvelopeFields,
  dataSourceId: DataSourceId,
  pageId: PageId,
  propertiesHash: Hash,
  bodyPointer: Schema.optional(BodyPointer),
  inTrash: Schema.Boolean,
}).annotations({ identifier: 'NotionDatasourceSync.RowObserved' })
export type RowObserved = typeof RowObserved.Type

export const LocalIntentAccepted = Schema.TaggedStruct('LocalIntentAccepted', {
  ...EventEnvelopeFields,
  commandId: CommandId,
  pageId: Schema.optional(PageId),
  dataSourceId: Schema.optional(DataSourceId),
  intentHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.LocalIntentAccepted' })
export type LocalIntentAccepted = typeof LocalIntentAccepted.Type

export const RemoteWritePlanned = Schema.TaggedStruct('RemoteWritePlanned', {
  ...EventEnvelopeFields,
  commandId: CommandId,
  commandTag: Schema.String,
}).annotations({ identifier: 'NotionDatasourceSync.RemoteWritePlanned' })
export type RemoteWritePlanned = typeof RemoteWritePlanned.Type

export const RemoteWriteSettled = Schema.TaggedStruct('RemoteWriteSettled', {
  ...EventEnvelopeFields,
  commandId: CommandId,
  requestId: NotionRequestId,
}).annotations({ identifier: 'NotionDatasourceSync.RemoteWriteSettled' })
export type RemoteWriteSettled = typeof RemoteWriteSettled.Type

export const ConflictRaised = Schema.TaggedStruct('ConflictRaised', {
  ...EventEnvelopeFields,
  pageId: PageId,
  propertyId: Schema.optional(PropertyId),
  baseHash: Hash,
  localHash: Hash,
  remoteHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.ConflictRaised' })
export type ConflictRaised = typeof ConflictRaised.Type

export const TombstoneRecorded = Schema.TaggedStruct('TombstoneRecorded', {
  ...EventEnvelopeFields,
  pageId: PageId,
  reason: Schema.Literal(
    'remote_trash',
    'moved_out',
    'moved_between_tracked_sources',
    'inaccessible',
    'unknown',
  ),
}).annotations({ identifier: 'NotionDatasourceSync.TombstoneRecorded' })
export type TombstoneRecorded = typeof TombstoneRecorded.Type

export const TombstoneCandidateObserved = Schema.TaggedStruct('TombstoneCandidateObserved', {
  ...EventEnvelopeFields,
  pageId: PageId,
  reason: Schema.Literal(
    'query_absence_unclassified',
    'filtered_absence_not_proof',
    'permission_ambiguous',
  ),
}).annotations({ identifier: 'NotionDatasourceSync.TombstoneCandidateObserved' })
export type TombstoneCandidateObserved = typeof TombstoneCandidateObserved.Type

export const DecodeDriftBlocked = Schema.TaggedStruct('DecodeDriftBlocked', {
  ...EventEnvelopeFields,
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
  RemoteWriteSettled,
  ConflictRaised,
  TombstoneRecorded,
  TombstoneCandidateObserved,
  DecodeDriftBlocked,
).annotations({ identifier: 'NotionDatasourceSync.SyncEvent' })
export type SyncEvent = typeof SyncEvent.Type
