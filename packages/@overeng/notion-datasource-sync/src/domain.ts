import { Schema } from 'effect'

export const SupportedNotionApiVersion = Schema.Literal('2026-03-11').annotations({
  identifier: 'NotionDatasourceSync.SupportedNotionApiVersion',
})
export type SupportedNotionApiVersion = typeof SupportedNotionApiVersion.Type

export const ClientVersion = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.ClientVersion'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.ClientVersion' }),
)
export type ClientVersion = typeof ClientVersion.Type

export const DataSourceId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.DataSourceId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.DataSourceId' }),
)
export type DataSourceId = typeof DataSourceId.Type

export const PageId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.PageId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.PageId' }),
)
export type PageId = typeof PageId.Type

export const PropertyId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.PropertyId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.PropertyId' }),
)
export type PropertyId = typeof PropertyId.Type

export const PropertyName = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.PropertyName'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.PropertyName' }),
)
export type PropertyName = typeof PropertyName.Type

export const CommandId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.CommandId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.CommandId' }),
)
export type CommandId = typeof CommandId.Type

export const QueryCursor = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.QueryCursor'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.QueryCursor' }),
)
export type QueryCursor = typeof QueryCursor.Type

export const NotionRequestId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.NotionRequestId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.NotionRequestId' }),
)
export type NotionRequestId = typeof NotionRequestId.Type

export const Hash = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/i),
  Schema.brand('NotionDatasourceSync.Hash'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.Hash' }),
)
export type Hash = typeof Hash.Type

export const AbsolutePath = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.AbsolutePath'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.AbsolutePath' }),
)
export type AbsolutePath = typeof AbsolutePath.Type

export const WorkspaceRelativePath = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.WorkspaceRelativePath'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.WorkspaceRelativePath' }),
)
export type WorkspaceRelativePath = typeof WorkspaceRelativePath.Type

export const OwnWriteSuppressionToken = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.OwnWriteSuppressionToken'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.OwnWriteSuppressionToken' }),
)
export type OwnWriteSuppressionToken = typeof OwnWriteSuppressionToken.Type

export const PositiveInt = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.annotations({ identifier: 'NotionDatasourceSync.PositiveInt' }),
)
export type PositiveInt = typeof PositiveInt.Type

export const NotionPageSize = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, 100),
  Schema.annotations({ identifier: 'NotionDatasourceSync.NotionPageSize' }),
)
export type NotionPageSize = typeof NotionPageSize.Type

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

export const NotionApiContract = Schema.TaggedStruct('NotionApiContract', {
  apiVersion: SupportedNotionApiVersion,
  clientVersion: ClientVersion,
  supportedCapabilities: Schema.Array(CapabilityName),
}).annotations({ identifier: 'NotionDatasourceSync.NotionApiContract' })
export type NotionApiContract = typeof NotionApiContract.Type

export const CapabilityPreflightInput = Schema.TaggedStruct('CapabilityPreflightInput', {
  dataSourceId: DataSourceId,
  requiredCapabilities: Schema.Array(CapabilityName),
}).annotations({ identifier: 'NotionDatasourceSync.CapabilityPreflightInput' })
export type CapabilityPreflightInput = typeof CapabilityPreflightInput.Type

export const CapabilityPreflightResult = Schema.TaggedStruct('CapabilityPreflightResult', {
  dataSourceId: DataSourceId,
  apiContract: NotionApiContract,
  supportedCapabilities: Schema.Array(CapabilityName),
  missingCapabilities: Schema.Array(CapabilityName),
}).annotations({ identifier: 'NotionDatasourceSync.CapabilityPreflightResult' })
export type CapabilityPreflightResult = typeof CapabilityPreflightResult.Type

export const DataSourceSnapshot = Schema.TaggedStruct('DataSourceSnapshot', {
  dataSourceId: DataSourceId,
  requestId: NotionRequestId,
  observedAt: Schema.DateTimeUtc,
  schemaHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.DataSourceSnapshot' })
export type DataSourceSnapshot = typeof DataSourceSnapshot.Type

export const PageSnapshot = Schema.TaggedStruct('PageSnapshot', {
  pageId: PageId,
  dataSourceId: Schema.optional(DataSourceId),
  requestId: NotionRequestId,
  observedAt: Schema.DateTimeUtc,
  propertiesHash: Hash,
  inTrash: Schema.Boolean,
}).annotations({ identifier: 'NotionDatasourceSync.PageSnapshot' })
export type PageSnapshot = typeof PageSnapshot.Type

export const BodyPointer = Schema.TaggedStruct('BodyPointer', {
  pageId: PageId,
  bodyHash: Hash,
  observedAt: Schema.DateTimeUtc,
}).annotations({ identifier: 'NotionDatasourceSync.BodyPointer' })
export type BodyPointer = typeof BodyPointer.Type

export const RowPageSnapshot = Schema.TaggedStruct('RowPageSnapshot', {
  pageId: PageId,
  propertiesHash: Hash,
  lastEditedTime: Schema.DateTimeUtc,
  inTrash: Schema.Boolean,
}).annotations({ identifier: 'NotionDatasourceSync.RowPageSnapshot' })
export type RowPageSnapshot = typeof RowPageSnapshot.Type

export const PagePropertyItem = Schema.TaggedStruct('PagePropertyItem', {
  pageId: PageId,
  propertyId: PropertyId,
  itemHash: Hash,
  valueHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.PagePropertyItem' })
export type PagePropertyItem = typeof PagePropertyItem.Type

export const LocalArtifactObservation = Schema.TaggedStruct('LocalArtifactObservation', {
  pageId: PageId,
  path: WorkspaceRelativePath,
  contentHash: Hash,
  observedAt: Schema.DateTimeUtc,
  state: Schema.Literal('present', 'delete-candidate'),
  ownWriteSuppressionToken: Schema.optional(OwnWriteSuppressionToken),
}).annotations({ identifier: 'NotionDatasourceSync.LocalArtifactObservation' })
export type LocalArtifactObservation = typeof LocalArtifactObservation.Type

export const PathClaimPlan = Schema.TaggedStruct('PathClaimPlan', {
  pageId: PageId,
  path: WorkspaceRelativePath,
}).annotations({ identifier: 'NotionDatasourceSync.PathClaimPlan' })
export type PathClaimPlan = typeof PathClaimPlan.Type

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

export const MaterializePlan = Schema.TaggedStruct('MaterializePlan', {
  pageId: PageId,
  path: WorkspaceRelativePath,
  bodyPointer: BodyPointer,
}).annotations({ identifier: 'NotionDatasourceSync.MaterializePlan' })
export type MaterializePlan = typeof MaterializePlan.Type

export const MaterializeResult = Schema.TaggedStruct('MaterializeResult', {
  pageId: PageId,
  path: WorkspaceRelativePath,
  bodyHash: Hash,
  ownWriteSuppressionToken: OwnWriteSuppressionToken,
}).annotations({ identifier: 'NotionDatasourceSync.MaterializeResult' })
export type MaterializeResult = typeof MaterializeResult.Type
