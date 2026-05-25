import { Schema } from 'effect'

import {
  BodyPointer,
  CommandId,
  DataSourceId,
  Hash,
  NotionPageSize,
  NotionRequestId,
  PageId,
  PagePropertyItem,
  PropertyId,
  PropertyName,
  QueryCursor,
  SupportedNotionApiVersion,
} from './domain.ts'

export const QueryMembershipScope = Schema.Literal(
  'all-data-source-rows',
  'explicit-filter',
).annotations({ identifier: 'NotionDatasourceSync.QueryMembershipScope' })
export type QueryMembershipScope = typeof QueryMembershipScope.Type

export const CanonicalNotionSort = Schema.TaggedStruct('CanonicalNotionSort', {
  propertyId: PropertyId,
  direction: Schema.Literal('ascending', 'descending'),
}).annotations({ identifier: 'NotionDatasourceSync.CanonicalNotionSort' })
export type CanonicalNotionSort = typeof CanonicalNotionSort.Type

export const CanonicalOptionValue = Schema.TaggedStruct('CanonicalOptionValue', {
  id: Schema.optional(PropertyId),
  name: PropertyName,
  color: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations({ identifier: 'NotionDatasourceSync.CanonicalOptionValue' })
export type CanonicalOptionValue = typeof CanonicalOptionValue.Type

export const CanonicalFileValue = Schema.TaggedStruct('CanonicalFileValue', {
  name: Schema.NonEmptyTrimmedString,
  identityHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.CanonicalFileValue' })
export type CanonicalFileValue = typeof CanonicalFileValue.Type

export const CanonicalPropertyValue = Schema.Union(
  Schema.TaggedStruct('empty', {}),
  Schema.TaggedStruct('title', {
    plainText: Schema.String,
  }),
  Schema.TaggedStruct('rich_text', {
    plainText: Schema.String,
  }),
  Schema.TaggedStruct('number', {
    value: Schema.Number,
  }),
  Schema.TaggedStruct('checkbox', {
    checked: Schema.Boolean,
  }),
  Schema.TaggedStruct('date', {
    start: Schema.DateTimeUtc,
    end: Schema.NullOr(Schema.DateTimeUtc),
  }),
  Schema.TaggedStruct('select', {
    option: Schema.NullOr(CanonicalOptionValue),
  }),
  Schema.TaggedStruct('multi_select', {
    options: Schema.Array(CanonicalOptionValue),
  }),
  Schema.TaggedStruct('status', {
    option: Schema.NullOr(CanonicalOptionValue),
  }),
  Schema.TaggedStruct('relation', {
    pageIds: Schema.Array(PageId),
  }),
  Schema.TaggedStruct('people', {
    userIds: Schema.Array(Schema.NonEmptyTrimmedString),
  }),
  Schema.TaggedStruct('files', {
    files: Schema.Array(CanonicalFileValue),
  }),
  Schema.TaggedStruct('email', {
    value: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct('url', {
    value: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct('phone_number', {
    value: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct('computed', {
    valueHash: Hash,
  }),
).annotations({ identifier: 'NotionDatasourceSync.CanonicalPropertyValue' })
export type CanonicalPropertyValue = typeof CanonicalPropertyValue.Type

export const CanonicalDataSourceProperty = Schema.TaggedStruct('CanonicalDataSourceProperty', {
  propertyId: PropertyId,
  name: PropertyName,
  type: Schema.Literal(
    'title',
    'rich_text',
    'number',
    'checkbox',
    'date',
    'select',
    'multi_select',
    'status',
    'relation',
    'people',
    'files',
    'email',
    'url',
    'phone_number',
    'formula',
    'rollup',
    'created_time',
    'created_by',
    'last_edited_time',
    'last_edited_by',
  ),
  configHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.CanonicalDataSourceProperty' })
export type CanonicalDataSourceProperty = typeof CanonicalDataSourceProperty.Type

export const CanonicalNotionFilter = Schema.Union(
  Schema.TaggedStruct('none', {}),
  Schema.TaggedStruct('property_value', {
    propertyId: PropertyId,
    operator: Schema.Literal(
      'equals',
      'does_not_equal',
      'contains',
      'does_not_contain',
      'starts_with',
      'ends_with',
      'is_empty',
      'is_not_empty',
      'greater_than',
      'less_than',
      'on_or_before',
      'on_or_after',
    ),
    value: Schema.NullOr(CanonicalPropertyValue),
  }),
  Schema.TaggedStruct('compound_hash', {
    kind: Schema.Literal('and', 'or'),
    expressionHash: Hash,
  }),
).annotations({ identifier: 'NotionDatasourceSync.CanonicalNotionFilter' })
export type CanonicalNotionFilter = typeof CanonicalNotionFilter.Type

export const QueryContract = Schema.TaggedStruct('QueryContract', {
  apiVersion: SupportedNotionApiVersion,
  filter: Schema.NullOr(CanonicalNotionFilter),
  sorts: Schema.Array(CanonicalNotionSort),
  pageSize: NotionPageSize,
  highWatermark: Schema.NullOr(Schema.DateTimeUtc),
  membershipScope: QueryMembershipScope,
}).annotations({ identifier: 'NotionDatasourceSync.QueryContract' })
export type QueryContract = typeof QueryContract.Type

export const QueryRowsInput = Schema.TaggedStruct('QueryRowsInput', {
  dataSourceId: DataSourceId,
  queryContract: QueryContract,
  startCursor: Schema.NullOr(QueryCursor),
}).annotations({ identifier: 'NotionDatasourceSync.QueryRowsInput' })
export type QueryRowsInput = typeof QueryRowsInput.Type

export const QueryRowsPage = Schema.TaggedStruct('QueryRowsPage', {
  apiVersion: SupportedNotionApiVersion,
  requestId: NotionRequestId,
  queryContractHash: Hash,
  rows: Schema.Array(
    Schema.TaggedStruct('QueriedRow', {
      pageId: PageId,
      propertiesHash: Hash,
      lastEditedTime: Schema.DateTimeUtc,
      inTrash: Schema.Boolean,
    }),
  ),
  nextCursor: Schema.NullOr(QueryCursor),
  hasMore: Schema.Boolean,
  cappedAtLimit: Schema.Boolean,
}).annotations({ identifier: 'NotionDatasourceSync.QueryRowsPage' })
export type QueryRowsPage = typeof QueryRowsPage.Type

export const RetrievePagePropertyInput = Schema.TaggedStruct('RetrievePagePropertyInput', {
  pageId: PageId,
  propertyId: PropertyId,
  startCursor: Schema.NullOr(QueryCursor),
}).annotations({ identifier: 'NotionDatasourceSync.RetrievePagePropertyInput' })
export type RetrievePagePropertyInput = typeof RetrievePagePropertyInput.Type

export const PagePropertyItemPage = Schema.TaggedStruct('PagePropertyItemPage', {
  apiVersion: SupportedNotionApiVersion,
  requestId: NotionRequestId,
  pageId: PageId,
  propertyId: PropertyId,
  items: Schema.Array(PagePropertyItem),
  nextCursor: Schema.NullOr(QueryCursor),
  hasMore: Schema.Boolean,
}).annotations({ identifier: 'NotionDatasourceSync.PagePropertyItemPage' })
export type PagePropertyItemPage = typeof PagePropertyItemPage.Type

export const PatchPagePropertiesCommand = Schema.TaggedStruct('PatchPagePropertiesCommand', {
  commandId: CommandId,
  pageId: PageId,
  basePropertiesHash: Hash,
  propertyPatch: Schema.Record({ key: PropertyId, value: CanonicalPropertyValue }),
}).annotations({ identifier: 'NotionDatasourceSync.PatchPagePropertiesCommand' })
export type PatchPagePropertiesCommand = typeof PatchPagePropertiesCommand.Type

export const PatchDataSourceSchemaCommand = Schema.TaggedStruct('PatchDataSourceSchemaCommand', {
  commandId: CommandId,
  dataSourceId: DataSourceId,
  baseSchemaHash: Hash,
  schemaPatch: Schema.Record({ key: PropertyId, value: CanonicalDataSourceProperty }),
}).annotations({ identifier: 'NotionDatasourceSync.PatchDataSourceSchemaCommand' })
export type PatchDataSourceSchemaCommand = typeof PatchDataSourceSchemaCommand.Type

export const TrashPageCommand = Schema.TaggedStruct('TrashPageCommand', {
  commandId: CommandId,
  pageId: PageId,
  basePropertiesHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.TrashPageCommand' })
export type TrashPageCommand = typeof TrashPageCommand.Type

export const RestorePageCommand = Schema.TaggedStruct('RestorePageCommand', {
  commandId: CommandId,
  pageId: PageId,
  basePropertiesHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.RestorePageCommand' })
export type RestorePageCommand = typeof RestorePageCommand.Type

export const ObserveBodyInput = Schema.TaggedStruct('ObserveBodyInput', {
  pageId: PageId,
}).annotations({ identifier: 'NotionDatasourceSync.ObserveBodyInput' })
export type ObserveBodyInput = typeof ObserveBodyInput.Type

export const BodyLocalChangeInput = Schema.TaggedStruct('BodyLocalChangeInput', {
  pageId: PageId,
  baseBodyPointer: BodyPointer,
  localBodyHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.BodyLocalChangeInput' })
export type BodyLocalChangeInput = typeof BodyLocalChangeInput.Type

export const BodyIntent = Schema.TaggedStruct('BodyIntent', {
  pageId: PageId,
  baseBodyPointer: BodyPointer,
  nextBodyHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.BodyIntent' })
export type BodyIntent = typeof BodyIntent.Type

export const BodyConflictReason = Schema.Literal(
  'StaleSurfaceBase',
  'BodyLossyRemote',
  'MarkdownUnknownBlocksAmbiguous',
  'MarkdownSelectionAmbiguous',
  'MarkdownWouldDeleteChildren',
  'MarkdownSyncedPageUnsupported',
  'BodyAdapterConflict',
  'BodyAdapterNonBodyMutation',
).annotations({ identifier: 'NotionDatasourceSync.BodyConflictReason' })
export type BodyConflictReason = typeof BodyConflictReason.Type

export const BodyConflict = Schema.TaggedStruct('BodyConflict', {
  pageId: PageId,
  baseBodyPointer: BodyPointer,
  localBodyHash: Hash,
  remoteBodyHash: Hash,
  reason: Schema.optional(BodyConflictReason),
  message: Schema.optional(Schema.String),
}).annotations({ identifier: 'NotionDatasourceSync.BodyConflict' })
export type BodyConflict = typeof BodyConflict.Type

export const BodyPushCommand = Schema.TaggedStruct('BodyPushCommand', {
  commandId: CommandId,
  pageId: PageId,
  baseBodyPointer: BodyPointer,
  nextBodyHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.BodyPushCommand' })
export type BodyPushCommand = typeof BodyPushCommand.Type

export const BodyPushResult = Schema.TaggedStruct('BodyPushResult', {
  pageId: PageId,
  requestId: NotionRequestId,
  bodyPointer: BodyPointer,
}).annotations({ identifier: 'NotionDatasourceSync.BodyPushResult' })
export type BodyPushResult = typeof BodyPushResult.Type

export const BodyRepairInput = Schema.TaggedStruct('BodyRepairInput', {
  pageId: PageId,
  currentBodyPointer: BodyPointer,
}).annotations({ identifier: 'NotionDatasourceSync.BodyRepairInput' })
export type BodyRepairInput = typeof BodyRepairInput.Type

export const RemoteWriteCommand = Schema.Union(
  PatchPagePropertiesCommand,
  PatchDataSourceSchemaCommand,
  TrashPageCommand,
  RestorePageCommand,
  BodyPushCommand,
).annotations({ identifier: 'NotionDatasourceSync.RemoteWriteCommand' })
export type RemoteWriteCommand = typeof RemoteWriteCommand.Type

export const RemoteWritePlanPayload = Schema.Struct({
  command: RemoteWriteCommand,
}).annotations({ identifier: 'NotionDatasourceSync.RemoteWritePlanPayload' })
export type RemoteWritePlanPayload = typeof RemoteWritePlanPayload.Type
