import { Schema } from 'effect'

import {
  ContentDescriptor,
  ContentDigest,
  descriptorForUtf8,
  type ContentDigest as ContentDigestType,
} from '@overeng/content-address'
import { NOTION_API_VERSION } from '@overeng/notion-effect-client'
import {
  PageId as SchemaPageId,
  PropertyId as SchemaPropertyId,
  PropertyName as SchemaPropertyName,
} from '@overeng/notion-effect-schema'

/** The single Notion API version this package is tested and certified against. */
export const SupportedNotionApiVersion = Schema.Literal(NOTION_API_VERSION).annotations({
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

/** Branded Notion database/container ID; distinct from a v2 data-source ID. */
export const DatabaseId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.DatabaseId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.DatabaseId' }),
)
export type DatabaseId = typeof DatabaseId.Type

/**
 * Branded Notion page ID, used throughout sync events, commands, and projections.
 *
 * Owned by `@overeng/notion-effect-schema` (the canonical property-value union
 * carries it directly); aliased here so all datasource-sync call sites share the
 * one brand and the codec needs no re-brand mirror.
 */
export const PageId = SchemaPageId
export type PageId = typeof PageId.Type

/**
 * Branded Notion property ID (stable identifier within a database schema).
 * Owned by `@overeng/notion-effect-schema`; aliased here (see {@link PageId}).
 */
export const PropertyId = SchemaPropertyId
export type PropertyId = typeof PropertyId.Type

/** Branded Notion view ID, distinct from local generated SQLite projection views. */
export const ViewId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.ViewId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.ViewId' }),
)
export type ViewId = typeof ViewId.Type

/**
 * Branded human-readable Notion property name (mutable; distinct from the stable PropertyId).
 * Owned by `@overeng/notion-effect-schema`; aliased here (see {@link PageId}).
 */
export const PropertyName = SchemaPropertyName
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
export const Hash = ContentDigest.pipe(
  Schema.brand('NotionDatasourceSync.Hash'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.Hash' }),
)
export type Hash = typeof Hash.Type

/** Body-scoped evidence fingerprint derived from a full remote body observation envelope. */
export const BodyEvidenceFingerprint = ContentDigest.pipe(
  Schema.brand('NotionDatasourceSync.BodyEvidenceFingerprint'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.BodyEvidenceFingerprint' }),
)
export type BodyEvidenceFingerprint = typeof BodyEvidenceFingerprint.Type

/** Completeness classification carried by a remote body evidence-backed identity. */
export const BodyCompletenessEvidence = Schema.Literal('complete', 'lossy').annotations({
  identifier: 'NotionDatasourceSync.BodyCompletenessEvidence',
})
export type BodyCompletenessEvidence = typeof BodyCompletenessEvidence.Type

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
  'data_source_metadata_update',
  'view_list',
  'page_retrieve',
  'page_property_paginate',
  'page_property_update',
  'page_create',
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

/** Observed write behavior for a Notion data-source property. */
export const DataSourcePropertyWriteClass = Schema.Literal(
  'writable',
  'computed',
  'unsupported',
).annotations({ identifier: 'NotionDatasourceSync.DataSourcePropertyWriteClass' })
export type DataSourcePropertyWriteClass = typeof DataSourcePropertyWriteClass.Type

/** Ordered typed schema descriptor observed from Notion's data-source properties map. */
export const DataSourcePropertySnapshot = Schema.TaggedStruct('DataSourcePropertySnapshot', {
  propertyId: PropertyId,
  name: PropertyName,
  type: Schema.NonEmptyTrimmedString,
  configHash: Hash,
  writeClass: DataSourcePropertyWriteClass,
  ordinal: Schema.NonNegativeInt,
  configJson: Schema.optional(Schema.String),
}).annotations({ identifier: 'NotionDatasourceSync.DataSourcePropertySnapshot' })
export type DataSourcePropertySnapshot = typeof DataSourcePropertySnapshot.Type

/** Point-in-time observation of a Notion database: captures request metadata plus independent schema and metadata hashes. */
export const DataSourceSnapshot = Schema.TaggedStruct('DataSourceSnapshot', {
  dataSourceId: DataSourceId,
  parentDatabaseId: Schema.optional(DatabaseId),
  requestId: NotionRequestId,
  observedAt: Schema.DateTimeUtc,
  schemaHash: Hash,
  schemaProperties: Schema.optional(Schema.Array(DataSourcePropertySnapshot)),
  metadataHash: Schema.optional(Hash),
  metadataJson: Schema.optional(Schema.String),
  metadataTitlePlainText: Schema.optional(Schema.String),
  metadataDescriptionPlainText: Schema.optional(Schema.String),
}).annotations({ identifier: 'NotionDatasourceSync.DataSourceSnapshot' })
export type DataSourceSnapshot = typeof DataSourceSnapshot.Type

/** Point-in-time observation of a Notion UI view attached to a database/data source. */
export const DataSourceViewSnapshot = Schema.TaggedStruct('DataSourceViewSnapshot', {
  viewId: ViewId,
  databaseId: DatabaseId,
  dataSourceId: DataSourceId,
  requestId: NotionRequestId,
  observedAt: Schema.DateTimeUtc,
  name: Schema.String,
  viewType: Schema.NonEmptyTrimmedString,
  viewHash: Hash,
  viewJson: Schema.String,
}).annotations({ identifier: 'NotionDatasourceSync.DataSourceViewSnapshot' })
export type DataSourceViewSnapshot = typeof DataSourceViewSnapshot.Type

/** Point-in-time observation of a Notion page: captures properties hash, trash state, and request metadata. */
export const PageSnapshot = Schema.TaggedStruct('PageSnapshot', {
  pageId: PageId,
  dataSourceId: Schema.optional(DataSourceId),
  requestId: NotionRequestId,
  observedAt: Schema.DateTimeUtc,
  propertiesHash: Hash,
  propertyValuesJson: Schema.optional(Schema.Record({ key: PropertyId, value: Schema.String })),
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

/** Body identity derived only from rendered Markdown bytes. */
export const RenderedBodyIdentity = Schema.TaggedStruct('RenderedBodyIdentity', {
  rendered: ContentDescriptor,
}).annotations({ identifier: 'NotionDatasourceSync.RenderedBodyIdentity' })
export type RenderedBodyIdentity = typeof RenderedBodyIdentity.Type

/** Body identity derived from a full remote observation evidence envelope. */
export const EvidenceBackedBodyIdentity = Schema.TaggedStruct('EvidenceBackedBodyIdentity', {
  evidenceFingerprint: BodyEvidenceFingerprint,
  rendered: ContentDescriptor,
  completeness: BodyCompletenessEvidence,
}).annotations({ identifier: 'NotionDatasourceSync.EvidenceBackedBodyIdentity' })
export type EvidenceBackedBodyIdentity = typeof EvidenceBackedBodyIdentity.Type

/** Typed page-body identity used for body stale-base guards, settlement, replay, and telemetry. */
export const BodyIdentity = Schema.Union(
  RenderedBodyIdentity,
  EvidenceBackedBodyIdentity,
).annotations({
  identifier: 'NotionDatasourceSync.BodyIdentity',
})
export type BodyIdentity = typeof BodyIdentity.Type

/** Stable reference to a body observation: page ID + typed identity + observation time + safety assessment. */
export const BodyPointer = Schema.TaggedStruct('BodyPointer', {
  pageId: PageId,
  identity: BodyIdentity,
  observedAt: Schema.DateTimeUtc,
  safety: BodySafetySnapshot,
}).annotations({ identifier: 'NotionDatasourceSync.BodyPointer' })
export type BodyPointer = typeof BodyPointer.Type

const decodeHash = Schema.decodeUnknownSync(Hash)
const decodeBodyEvidenceFingerprint = Schema.decodeUnknownSync(BodyEvidenceFingerprint)
const decodeContentDescriptor = Schema.decodeUnknownSync(ContentDescriptor)

export const hashFromContentDigest = (digest: ContentDigestType | string): Hash =>
  decodeHash(digest)

export const bodyEvidenceFingerprintFromContentDigest = (
  digest: ContentDigestType | string,
): BodyEvidenceFingerprint => decodeBodyEvidenceFingerprint(digest)

export const bodyDescriptorForMarkdown = (markdown: string): typeof ContentDescriptor.Type =>
  descriptorForUtf8({
    value: markdown,
    mediaType: 'text/markdown; charset=utf-8',
    codec: 'notion-enhanced-markdown',
    schemaVersion: 1,
  })

export const bodyDescriptorForDigest = (digest: Hash): typeof ContentDescriptor.Type =>
  decodeContentDescriptor({
    _tag: 'ContentDescriptor',
    digest,
    byteLength: 0,
    mediaType: 'text/markdown; charset=utf-8',
    codec: 'notion-enhanced-markdown',
    schemaVersion: 1,
  })

export const renderedBodyIdentity = (descriptor: typeof ContentDescriptor.Type): BodyIdentity =>
  RenderedBodyIdentity.make({
    _tag: 'RenderedBodyIdentity',
    rendered: descriptor,
  })

export const evidenceBackedBodyIdentity = (opts: {
  readonly rendered: typeof ContentDescriptor.Type
  readonly evidenceFingerprint: BodyEvidenceFingerprint
  readonly completeness: BodyCompletenessEvidence
}): BodyIdentity =>
  EvidenceBackedBodyIdentity.make({
    _tag: 'EvidenceBackedBodyIdentity',
    rendered: opts.rendered,
    evidenceFingerprint: opts.evidenceFingerprint,
    completeness: opts.completeness,
  })

export const bodyIdentityDigest = (identity: BodyIdentity): Hash =>
  identity._tag === 'EvidenceBackedBodyIdentity'
    ? hashFromContentDigest(identity.evidenceFingerprint)
    : hashFromContentDigest(identity.rendered.digest)

export const renderedBodyDigest = (identity: BodyIdentity): Hash =>
  hashFromContentDigest(identity.rendered.digest)

export const bodyIdentityEquals = (left: BodyIdentity, right: BodyIdentity): boolean =>
  bodyIdentityDigest(left) === bodyIdentityDigest(right)

export const bodyPointerIdentityDigest = (pointer: BodyPointer): Hash =>
  bodyIdentityDigest(pointer.identity)

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
  valueJson: Schema.optional(Schema.String),
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
  bodyContent: Schema.optional(Schema.String),
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
