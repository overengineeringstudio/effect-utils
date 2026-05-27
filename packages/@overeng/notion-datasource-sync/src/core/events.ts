import { Schema } from 'effect'

import {
  AbsolutePath,
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

/** Branded unique identifier for a single event in the sync event log. */
export const SyncEventId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.SyncEventId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.SyncEventId' }),
)
export type SyncEventId = typeof SyncEventId.Type

/** Branded identifier for a sync root (a single data-source ↔ workspace binding); partitions the event log. */
export const SyncRootId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.SyncRootId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.SyncRootId' }),
)
export type SyncRootId = typeof SyncRootId.Type

/** Schema version of the event envelope codec; bumped when the envelope shape changes in a breaking way. */
export const EventCodecVersion = Schema.Literal('v1').annotations({
  identifier: 'NotionDatasourceSync.EventCodecVersion',
})
export type EventCodecVersion = typeof EventCodecVersion.Type

/** High-level classification of a sync event; used for filtering and projection without needing to decode the full payload. */
export const EventFamily = Schema.Literal(
  'RemoteObserved',
  'SyncRootBound',
  'CompatibilityChecked',
  'QueryScanRecorded',
  'LocalIntentAccepted',
  'CommandEnqueued',
  'CommandAttempted',
  'CommandSettled',
  'ConflictDetected',
  'ConflictResolved',
  'TombstoneClassified',
  'GuardBlocked',
  'RepairObserved',
  'StorageMigrated',
).annotations({ identifier: 'NotionDatasourceSync.EventFamily' })
export type EventFamily = typeof EventFamily.Type

/** Branded key that ensures a command or event is applied at most once even if retried. */
export const IdempotencyKey = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.IdempotencyKey'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.IdempotencyKey' }),
)
export type IdempotencyKey = typeof IdempotencyKey.Type

/** Branded composite key identifying the sync surface an event or conflict applies to (e.g. `page:<id>:body`). */
export const SurfaceKey = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.SurfaceKey'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.SurfaceKey' }),
)
export type SurfaceKey = typeof SurfaceKey.Type

/** Codec-versioned JSON payload stored inside each event envelope, enabling forward-compatible payload decoding. */
export const VersionedJson = Schema.TaggedStruct('VersionedJson', {
  codecVersion: EventCodecVersion,
  canonicalJson: Schema.String,
}).annotations({ identifier: 'NotionDatasourceSync.VersionedJson' })
export type VersionedJson = typeof VersionedJson.Type

/** Returns the common envelope field schemas shared by every sync event; spread into each concrete event struct. */
export const eventEnvelopeFields = <TFamily extends EventFamily, TEventType extends string>({
  family,
  eventType,
}: {
  readonly family: TFamily
  readonly eventType: TEventType
}) =>
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

/** Records that a data source has been bound to a local workspace root; anchors all subsequent events for this sync root. */
export const SyncBindingRecorded = Schema.TaggedStruct('SyncBindingRecorded', {
  ...eventEnvelopeFields({ family: 'SyncRootBound', eventType: 'SyncBindingRecorded' }),
  dataSourceId: DataSourceId,
  workspaceRoot: AbsolutePath,
  storeIdentity: Schema.NonEmptyTrimmedString,
}).annotations({ identifier: 'NotionDatasourceSync.SyncBindingRecorded' })
export type SyncBindingRecorded = typeof SyncBindingRecorded.Type

/** Records the Notion API contract (version + capabilities) observed at a sync checkpoint; drives compatibility guards. */
export const ApiContractObserved = Schema.TaggedStruct('ApiContractObserved', {
  ...eventEnvelopeFields({ family: 'CompatibilityChecked', eventType: 'ApiContractObserved' }),
  apiContract: NotionApiContract,
}).annotations({ identifier: 'NotionDatasourceSync.ApiContractObserved' })
export type ApiContractObserved = typeof ApiContractObserved.Type

/** Records the observation of a Notion database's schema hash during a remote scan. */
export const DataSourceObserved = Schema.TaggedStruct('DataSourceObserved', {
  ...eventEnvelopeFields({ family: 'RemoteObserved', eventType: 'DataSourceObserved' }),
  dataSourceId: DataSourceId,
  requestId: NotionRequestId,
  schemaHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.DataSourceObserved' })
export type DataSourceObserved = typeof DataSourceObserved.Type

/** Records the observation of Notion data-source presentation metadata independently from schema. */
export const DataSourceMetadataObserved = Schema.TaggedStruct('DataSourceMetadataObserved', {
  ...eventEnvelopeFields({ family: 'RemoteObserved', eventType: 'DataSourceMetadataObserved' }),
  dataSourceId: DataSourceId,
  requestId: NotionRequestId,
  metadataHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.DataSourceMetadataObserved' })
export type DataSourceMetadataObserved = typeof DataSourceMetadataObserved.Type

/** Records the observation of a single Notion database row (page) during a query scan, including its properties hash and trash state. */
export const RowObserved = Schema.TaggedStruct('RowObserved', {
  ...eventEnvelopeFields({ family: 'RemoteObserved', eventType: 'RowObserved' }),
  dataSourceId: DataSourceId,
  pageId: PageId,
  propertiesHash: Hash,
  bodyPointer: Schema.optional(BodyPointer),
  inTrash: Schema.Boolean,
}).annotations({ identifier: 'NotionDatasourceSync.RowObserved' })
export type RowObserved = typeof RowObserved.Type

/** Records that a local user intent (e.g. property edit or body change) has passed guards and been accepted into the sync pipeline. */
export const LocalIntentAccepted = Schema.TaggedStruct('LocalIntentAccepted', {
  ...eventEnvelopeFields({ family: 'LocalIntentAccepted', eventType: 'LocalIntentAccepted' }),
  commandId: CommandId,
  pageId: Schema.optional(PageId),
  dataSourceId: Schema.optional(DataSourceId),
  intentHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.LocalIntentAccepted' })
export type LocalIntentAccepted = typeof LocalIntentAccepted.Type

/** Records the enqueuing of a remote write command, including its desired state hash and the list of guards that must pass before execution. */
export const RemoteWritePlanned = Schema.TaggedStruct('RemoteWritePlanned', {
  ...eventEnvelopeFields({ family: 'CommandEnqueued', eventType: 'RemoteWritePlanned' }),
  commandId: CommandId,
  commandKey: IdempotencyKey,
  intentEventId: SyncEventId,
  commandTag: Schema.String,
  baseHash: Schema.optional(Hash),
  desiredHash: Hash,
  preflight: Schema.Array(GuardName),
}).annotations({ identifier: 'NotionDatasourceSync.RemoteWritePlanned' })
export type RemoteWritePlanned = typeof RemoteWritePlanned.Type

/** Records each execution attempt of a remote write command, including attempt state and any blocking guard. */
export const RemoteWriteAttempted = Schema.TaggedStruct('RemoteWriteAttempted', {
  ...eventEnvelopeFields({ family: 'CommandAttempted', eventType: 'RemoteWriteAttempted' }),
  commandId: CommandId,
  attempt: Schema.NonNegativeInt,
  attemptState: Schema.Literal('running', 'retryable', 'blocked', 'fenced', 'ambiguous'),
  leaseToken: Schema.optional(Schema.NonEmptyTrimmedString),
  guard: Schema.optional(GuardName),
}).annotations({ identifier: 'NotionDatasourceSync.RemoteWriteAttempted' })
export type RemoteWriteAttempted = typeof RemoteWriteAttempted.Type

/** Records the successful settlement of a remote write: the observed post-write hash was verified to match the desired hash. */
export const RemoteWriteSettled = Schema.TaggedStruct('RemoteWriteSettled', {
  ...eventEnvelopeFields({ family: 'CommandSettled', eventType: 'RemoteWriteSettled' }),
  commandId: CommandId,
  commandTag: Schema.String,
  requestId: NotionRequestId,
  desiredHash: Hash,
  observedHash: Hash,
  settlementKind: Schema.Literal('verified-success', 'verified-no-op'),
}).annotations({ identifier: 'NotionDatasourceSync.RemoteWriteSettled' })
export type RemoteWriteSettled = typeof RemoteWriteSettled.Type

/** Records a detected three-way conflict (local change vs. remote change against the same base hash) requiring resolution before the command can proceed. */
export const ConflictRaised = Schema.TaggedStruct('ConflictRaised', {
  ...eventEnvelopeFields({ family: 'ConflictDetected', eventType: 'ConflictRaised' }),
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

/** Records the resolution of a previously raised conflict, capturing the chosen resolution strategy and any follow-up command. */
export const ConflictResolved = Schema.TaggedStruct('ConflictResolved', {
  ...eventEnvelopeFields({ family: 'ConflictResolved', eventType: 'ConflictResolved' }),
  conflictId: SyncEventId,
  pageId: PageId,
  propertyId: Schema.optional(PropertyId),
  resolutionChoice: Schema.Literal('keep-local', 'keep-remote', 'manual'),
  followupCommandId: Schema.optional(CommandId),
}).annotations({ identifier: 'NotionDatasourceSync.ConflictResolved' })
export type ConflictResolved = typeof ConflictResolved.Type

/** Records that a page has been definitively classified as removed from the sync scope (trashed, moved out, or inaccessible). */
export const TombstoneRecorded = Schema.TaggedStruct('TombstoneRecorded', {
  ...eventEnvelopeFields({ family: 'TombstoneClassified', eventType: 'TombstoneRecorded' }),
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

/** Records a page absence that is not yet fully classified; triggers a follow-up probe to determine whether a tombstone is warranted. */
export const TombstoneCandidateObserved = Schema.TaggedStruct('TombstoneCandidateObserved', {
  ...eventEnvelopeFields({ family: 'RemoteObserved', eventType: 'TombstoneCandidateObserved' }),
  pageId: PageId,
  reason: Schema.Literal(
    'query_absence_unclassified',
    'filtered_absence_not_proof',
    'permission_ambiguous',
    'local_file_delete_candidate',
  ),
}).annotations({ identifier: 'NotionDatasourceSync.TombstoneCandidateObserved' })
export type TombstoneCandidateObserved = typeof TombstoneCandidateObserved.Type

/** Records the result of checking whether a specific Notion capability is available on the connected workspace. */
export const CapabilityPreflightChecked = Schema.TaggedStruct('CapabilityPreflightChecked', {
  ...eventEnvelopeFields({
    family: 'CompatibilityChecked',
    eventType: 'CapabilityPreflightChecked',
  }),
  dataSourceId: DataSourceId,
  capability: CapabilityName,
  supported: Schema.Boolean,
  requestId: Schema.optional(NotionRequestId),
}).annotations({ identifier: 'NotionDatasourceSync.CapabilityPreflightChecked' })
export type CapabilityPreflightChecked = typeof CapabilityPreflightChecked.Type

/** Records a pagination checkpoint in a query scan; `complete` signals that the terminal page was reached and absence proofs are valid. */
export const QueryScanCheckpointRecorded = Schema.TaggedStruct('QueryScanCheckpointRecorded', {
  ...eventEnvelopeFields({ family: 'QueryScanRecorded', eventType: 'QueryScanCheckpointRecorded' }),
  dataSourceId: DataSourceId,
  queryContractHash: Hash,
  nextCursor: Schema.NullOr(QueryCursor),
  complete: Schema.Boolean,
  highWatermark: Schema.NullOr(Schema.DateTimeUtc),
}).annotations({ identifier: 'NotionDatasourceSync.QueryScanCheckpointRecorded' })
export type QueryScanCheckpointRecorded = typeof QueryScanCheckpointRecorded.Type

/** Records a pagination checkpoint while retrieving a paginated property value for a specific page. */
export const PagePropertyCheckpointRecorded = Schema.TaggedStruct(
  'PagePropertyCheckpointRecorded',
  {
    ...eventEnvelopeFields({
      family: 'QueryScanRecorded',
      eventType: 'PagePropertyCheckpointRecorded',
    }),
    pageId: PageId,
    propertyId: PropertyId,
    nextCursor: Schema.NullOr(QueryCursor),
    complete: Schema.Boolean,
    valueHash: Schema.optional(Hash),
  },
).annotations({ identifier: 'NotionDatasourceSync.PagePropertyCheckpointRecorded' })
export type PagePropertyCheckpointRecorded = typeof PagePropertyCheckpointRecorded.Type

/** Records the claim of a workspace-relative path for a page; `claimState` tracks whether the claim is active, released, or in conflict. */
export const PathClaimed = Schema.TaggedStruct('PathClaimed', {
  ...eventEnvelopeFields({ family: 'LocalIntentAccepted', eventType: 'PathClaimed' }),
  pageId: PageId,
  relativePath: Schema.NonEmptyTrimmedString,
  claimState: Schema.Literal('active', 'released', 'conflict'),
}).annotations({ identifier: 'NotionDatasourceSync.PathClaimed' })
export type PathClaimed = typeof PathClaimed.Type

/** Records that the user has explicitly requested to forget a row from the sync state. */
export const RowForgotten = Schema.TaggedStruct('RowForgotten', {
  ...eventEnvelopeFields({ family: 'LocalIntentAccepted', eventType: 'RowForgotten' }),
  pageId: PageId,
  reason: Schema.Literal('user-forget'),
}).annotations({ identifier: 'NotionDatasourceSync.RowForgotten' })
export type RowForgotten = typeof RowForgotten.Type

/** Records that schema decode drift was detected and the sync surface was blocked from proceeding until the codec is updated. */
export const DecodeDriftBlocked = Schema.TaggedStruct('DecodeDriftBlocked', {
  ...eventEnvelopeFields({ family: 'CompatibilityChecked', eventType: 'DecodeDriftBlocked' }),
  apiVersion: SupportedNotionApiVersion,
  surface: Schema.String,
  message: Schema.String,
}).annotations({ identifier: 'NotionDatasourceSync.DecodeDriftBlocked' })
export type DecodeDriftBlocked = typeof DecodeDriftBlocked.Type

/** Records that a named guard blocked the sync engine from proceeding; provides the guard name and human-readable message for diagnostics. */
export const GuardBlocked = Schema.TaggedStruct('GuardBlocked', {
  ...eventEnvelopeFields({ family: 'GuardBlocked', eventType: 'GuardBlocked' }),
  guard: GuardName,
  message: Schema.NonEmptyTrimmedString,
}).annotations({ identifier: 'NotionDatasourceSync.GuardBlocked' })
export type GuardBlocked = typeof GuardBlocked.Type

/** Discriminated union of all events persisted to the sync event log; the `_tag` field is the event type discriminator. */
export const SyncEvent = Schema.Union(
  SyncBindingRecorded,
  ApiContractObserved,
  DataSourceObserved,
  DataSourceMetadataObserved,
  RowObserved,
  LocalIntentAccepted,
  RemoteWritePlanned,
  RemoteWriteAttempted,
  RemoteWriteSettled,
  ConflictRaised,
  ConflictResolved,
  TombstoneRecorded,
  TombstoneCandidateObserved,
  CapabilityPreflightChecked,
  QueryScanCheckpointRecorded,
  PagePropertyCheckpointRecorded,
  PathClaimed,
  RowForgotten,
  DecodeDriftBlocked,
  GuardBlocked,
).annotations({ identifier: 'NotionDatasourceSync.SyncEvent' })
export type SyncEvent = typeof SyncEvent.Type
