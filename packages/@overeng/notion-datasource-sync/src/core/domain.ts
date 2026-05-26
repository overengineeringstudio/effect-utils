import { Schema } from 'effect'

/** The single Notion API version this package is tested and certified against. */
export const SupportedNotionApiVersion = Schema.Literal('2026-03-11').annotations({
  identifier: 'NotionDatasourceSync.SupportedNotionApiVersion',
})
export type SupportedNotionApiVersion = typeof SupportedNotionApiVersion.Type

/** Branded version string identifying the datasource-sync client build. */
export const ClientVersion = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.ClientVersion'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.ClientVersion' }),
)
export type ClientVersion = typeof ClientVersion.Type

/** Branded Notion database ID used as the primary key for a synced data source. */
export const DataSourceId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.DataSourceId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.DataSourceId' }),
)
export type DataSourceId = typeof DataSourceId.Type

/** Branded Notion page ID, used throughout sync events, commands, and projections. */
export const PageId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.PageId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.PageId' }),
)
export type PageId = typeof PageId.Type

/** Branded Notion property ID (stable identifier within a database schema). */
export const PropertyId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.PropertyId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.PropertyId' }),
)
export type PropertyId = typeof PropertyId.Type

/** Branded human-readable Notion property name (mutable; distinct from the stable PropertyId). */
export const PropertyName = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.PropertyName'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.PropertyName' }),
)
export type PropertyName = typeof PropertyName.Type

/** Branded ID that uniquely identifies a remote-write command in the outbox. */
export const CommandId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.CommandId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.CommandId' }),
)
export type CommandId = typeof CommandId.Type

/** Branded opaque cursor returned by paginated Notion query endpoints. */
export const QueryCursor = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.QueryCursor'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.QueryCursor' }),
)
export type QueryCursor = typeof QueryCursor.Type

/** Branded request ID returned by the Notion API; used for idempotency tracking and audit trails. */
export const NotionRequestId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.NotionRequestId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.NotionRequestId' }),
)
export type NotionRequestId = typeof NotionRequestId.Type

/** SHA-256 content hash used as a stable identity for Notion objects and local artifacts (format: `sha256:<hex64>`). */
export const Hash = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/i),
  Schema.brand('NotionDatasourceSync.Hash'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.Hash' }),
)
export type Hash = typeof Hash.Type

/** Branded absolute filesystem path to the workspace root or a local artifact. */
export const AbsolutePath = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.AbsolutePath'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.AbsolutePath' }),
)
export type AbsolutePath = typeof AbsolutePath.Type

/** Branded path relative to the sync workspace root, used in path-claim and materialization operations. */
export const WorkspaceRelativePath = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.WorkspaceRelativePath'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.WorkspaceRelativePath' }),
)
export type WorkspaceRelativePath = typeof WorkspaceRelativePath.Type

/**
 * Token written alongside a materialized file that suppresses a spurious local-change event
 * when the sync engine itself is the author of the filesystem write.
 */
export const OwnWriteSuppressionToken = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.OwnWriteSuppressionToken'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.OwnWriteSuppressionToken' }),
)
export type OwnWriteSuppressionToken = typeof OwnWriteSuppressionToken.Type

/** Integer greater than zero; used for counts and sizes that must be at least 1. */
export const PositiveInt = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.annotations({ identifier: 'NotionDatasourceSync.PositiveInt' }),
)
export type PositiveInt = typeof PositiveInt.Type

/** Notion API pagination page size, constrained to the API-documented range [1, 100]. */
export const NotionPageSize = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, 100),
  Schema.annotations({ identifier: 'NotionDatasourceSync.NotionPageSize' }),
)
export type NotionPageSize = typeof NotionPageSize.Type

/** Named Notion API capability checked during preflight; governs which operations the sync engine may attempt. */
export const CapabilityName = Schema.Literal(
  'data_source_retrieve',
  'data_source_query',
  'page_retrieve',
  'page_property_paginate',
  'page_property_update',
  'schema_update',
  'page_trash',
  'page_restore',
).annotations({ identifier: 'NotionDatasourceSync.CapabilityName' })
export type CapabilityName = typeof CapabilityName.Type

/** Observed Notion API contract: the version reported by the gateway and the set of capabilities it declared as supported. */
export const NotionApiContract = Schema.TaggedStruct('NotionApiContract', {
  apiVersion: SupportedNotionApiVersion,
  clientVersion: ClientVersion,
  supportedCapabilities: Schema.Array(CapabilityName),
}).annotations({ identifier: 'NotionDatasourceSync.NotionApiContract' })
export type NotionApiContract = typeof NotionApiContract.Type

/** Input to a capability preflight check: identifies the data source and the capabilities required for the planned operation. */
export const CapabilityPreflightInput = Schema.TaggedStruct('CapabilityPreflightInput', {
  dataSourceId: DataSourceId,
  requiredCapabilities: Schema.Array(CapabilityName),
}).annotations({ identifier: 'NotionDatasourceSync.CapabilityPreflightInput' })
export type CapabilityPreflightInput = typeof CapabilityPreflightInput.Type

/** Result of a capability preflight check; exposes which capabilities were present and which were missing. */
export const CapabilityPreflightResult = Schema.TaggedStruct('CapabilityPreflightResult', {
  dataSourceId: DataSourceId,
  apiContract: NotionApiContract,
  supportedCapabilities: Schema.Array(CapabilityName),
  missingCapabilities: Schema.Array(CapabilityName),
}).annotations({ identifier: 'NotionDatasourceSync.CapabilityPreflightResult' })
export type CapabilityPreflightResult = typeof CapabilityPreflightResult.Type

/** Point-in-time observation of a Notion database: captures request metadata and a hash of the database schema. */
export const DataSourceSnapshot = Schema.TaggedStruct('DataSourceSnapshot', {
  dataSourceId: DataSourceId,
  requestId: NotionRequestId,
  observedAt: Schema.DateTimeUtc,
  schemaHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.DataSourceSnapshot' })
export type DataSourceSnapshot = typeof DataSourceSnapshot.Type

/** Point-in-time observation of a Notion page: captures properties hash, trash state, and request metadata. */
export const PageSnapshot = Schema.TaggedStruct('PageSnapshot', {
  pageId: PageId,
  dataSourceId: Schema.optional(DataSourceId),
  requestId: NotionRequestId,
  observedAt: Schema.DateTimeUtc,
  propertiesHash: Hash,
  inTrash: Schema.Boolean,
}).annotations({ identifier: 'NotionDatasourceSync.PageSnapshot' })
export type PageSnapshot = typeof PageSnapshot.Type

/** Reason why a body block could not be fully represented during observation; drives body-safety guard decisions. */
export const BodyUnknownBlockCause = Schema.Literal(
  'truncation',
  'permission',
  'unsupported',
  'unknown',
).annotations({ identifier: 'NotionDatasourceSync.BodyUnknownBlockCause' })
export type BodyUnknownBlockCause = typeof BodyUnknownBlockCause.Type

/**
 * Surface types that a body adapter is allowed to mutate.
 *
 * The `guardBodySafety` and `guardBodyAdapterBoundary` guards reject commands whose adapter
 * touched any surface other than `'body'`.
 */
export const BodyAdapterMutationSurface = Schema.Literal(
  'body',
  'row-property',
  'schema',
  'title',
  'trash',
  'icon',
  'cover',
  'page-metadata',
  'membership',
).annotations({ identifier: 'NotionDatasourceSync.BodyAdapterMutationSurface' })
export type BodyAdapterMutationSurface = typeof BodyAdapterMutationSurface.Type

/** Safety assessment of a page body at the time it was observed; the `guardBodySafety` guard consumes this to decide whether a push is safe. */
export const BodySafetySnapshot = Schema.Struct({
  truncated: Schema.Boolean,
  unknownBlockCause: Schema.optional(BodyUnknownBlockCause),
  selection: Schema.Literal('safe', 'ambiguous'),
  wouldDeleteChildren: Schema.Boolean,
  syncedPageUnsupported: Schema.Boolean,
  adapterConflict: Schema.Boolean,
  adapterMutationSurfaces: Schema.Array(BodyAdapterMutationSurface),
}).annotations({ identifier: 'NotionDatasourceSync.BodySafetySnapshot' })
export type BodySafetySnapshot = typeof BodySafetySnapshot.Type

/** Stable reference to a body observation: page ID + content hash + observation time + optional safety assessment. */
export const BodyPointer = Schema.TaggedStruct('BodyPointer', {
  pageId: PageId,
  bodyHash: Hash,
  observedAt: Schema.DateTimeUtc,
  safety: Schema.optional(BodySafetySnapshot),
}).annotations({ identifier: 'NotionDatasourceSync.BodyPointer' })
export type BodyPointer = typeof BodyPointer.Type

/** Lightweight per-row snapshot returned within a query page; contains identity and change-detection fields without full property values. */
export const RowPageSnapshot = Schema.TaggedStruct('RowPageSnapshot', {
  pageId: PageId,
  propertiesHash: Hash,
  lastEditedTime: Schema.DateTimeUtc,
  inTrash: Schema.Boolean,
}).annotations({ identifier: 'NotionDatasourceSync.RowPageSnapshot' })
export type RowPageSnapshot = typeof RowPageSnapshot.Type

/** A single item from a paginated property value retrieval; carries stable hash identifiers for change detection. */
export const PagePropertyItem = Schema.TaggedStruct('PagePropertyItem', {
  pageId: PageId,
  propertyId: PropertyId,
  itemHash: Hash,
  valueHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.PagePropertyItem' })
export type PagePropertyItem = typeof PagePropertyItem.Type

/**
 * Observation of a local file that corresponds to a synced Notion page.
 *
 * The `ownWriteSuppressionToken` field, when present, indicates the file was written by the sync
 * engine itself and the resulting filesystem event should be suppressed.
 */
export const LocalArtifactObservation = Schema.TaggedStruct('LocalArtifactObservation', {
  pageId: PageId,
  path: WorkspaceRelativePath,
  contentHash: Hash,
  observedAt: Schema.DateTimeUtc,
  state: Schema.Literal('present', 'delete-candidate'),
  ownWriteSuppressionToken: Schema.optional(OwnWriteSuppressionToken),
}).annotations({ identifier: 'NotionDatasourceSync.LocalArtifactObservation' })
export type LocalArtifactObservation = typeof LocalArtifactObservation.Type

/** Intent to claim a workspace-relative path for a given page; submitted to `LocalWorkspacePort.claimPath`. */
export const PathClaimPlan = Schema.TaggedStruct('PathClaimPlan', {
  pageId: PageId,
  path: WorkspaceRelativePath,
}).annotations({ identifier: 'NotionDatasourceSync.PathClaimPlan' })
export type PathClaimPlan = typeof PathClaimPlan.Type

/** Outcome of a path-claim attempt — either `'claimed'` (path is now owned by this page) or `'conflict'` (path already held by another page). */
export const PathClaimResult = Schema.Union(
  Schema.TaggedStruct('claimed', {
    pageId: PageId,
    path: WorkspaceRelativePath,
  }),
  Schema.TaggedStruct('conflict', {
    pageId: PageId,
    requestedPath: WorkspaceRelativePath,
    existingPageId: PageId,
  }),
).annotations({ identifier: 'NotionDatasourceSync.PathClaimResult' })
export type PathClaimResult = typeof PathClaimResult.Type

/** Plan for materializing a Notion page body as a local file at the specified path. */
export const MaterializePlan = Schema.TaggedStruct('MaterializePlan', {
  pageId: PageId,
  path: WorkspaceRelativePath,
  bodyPointer: BodyPointer,
}).annotations({ identifier: 'NotionDatasourceSync.MaterializePlan' })
export type MaterializePlan = typeof MaterializePlan.Type

/** Result of a successful materialization; includes the body hash and own-write suppression token for the written file. */
export const MaterializeResult = Schema.TaggedStruct('MaterializeResult', {
  pageId: PageId,
  path: WorkspaceRelativePath,
  bodyHash: Hash,
  ownWriteSuppressionToken: OwnWriteSuppressionToken,
}).annotations({ identifier: 'NotionDatasourceSync.MaterializeResult' })
export type MaterializeResult = typeof MaterializeResult.Type
