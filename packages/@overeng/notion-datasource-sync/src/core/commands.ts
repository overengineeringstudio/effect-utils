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
  WorkspaceRelativePath,
} from './domain.ts'

/** Defines how row membership is determined: `all-data-source-rows` treats any absence as potential removal; `explicit-filter` limits absence proofs to the filter scope. */
export const QueryMembershipScope = Schema.Literal(
  'all-data-source-rows',
  'explicit-filter',
).annotations({ identifier: 'NotionDatasourceSync.QueryMembershipScope' })
export type QueryMembershipScope = typeof QueryMembershipScope.Type

/** Canonical sort specification for a Notion query: property-based with an explicit direction. */
export const CanonicalNotionSort = Schema.TaggedStruct('CanonicalNotionSort', {
  propertyId: PropertyId,
  direction: Schema.Literal('ascending', 'descending'),
}).annotations({ identifier: 'NotionDatasourceSync.CanonicalNotionSort' })
export type CanonicalNotionSort = typeof CanonicalNotionSort.Type

/** Canonical representation of a select/multi-select/status option, normalized for stable hash comparison. */
export const CanonicalOptionValue = Schema.TaggedStruct('CanonicalOptionValue', {
  id: Schema.optional(PropertyId),
  name: PropertyName,
  color: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations({ identifier: 'NotionDatasourceSync.CanonicalOptionValue' })
export type CanonicalOptionValue = typeof CanonicalOptionValue.Type

/** Canonical file attachment value: name plus a stable identity hash used for change detection. */
export const CanonicalFileValue = Schema.TaggedStruct('CanonicalFileValue', {
  name: Schema.NonEmptyTrimmedString,
  identityHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.CanonicalFileValue' })
export type CanonicalFileValue = typeof CanonicalFileValue.Type

/** Normalized representation of any Notion property value type; the `_tag` discriminates the variant. Computed properties carry only their hash. */
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

/** Canonical schema descriptor for a single Notion database property; `configHash` covers all type-configuration details not in the `type` discriminator. */
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

/** Canonical filter expression for a Notion query; complex filters are represented as a hash to keep the contract stable. */
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

/** Immutable contract describing how rows are queried; any change invalidates prior absence proofs and query checkpoints. */
export const QueryContract = Schema.TaggedStruct('QueryContract', {
  apiVersion: SupportedNotionApiVersion,
  filter: Schema.NullOr(CanonicalNotionFilter),
  sorts: Schema.Array(CanonicalNotionSort),
  pageSize: NotionPageSize,
  highWatermark: Schema.NullOr(Schema.DateTimeUtc),
  membershipScope: QueryMembershipScope,
}).annotations({ identifier: 'NotionDatasourceSync.QueryContract' })
export type QueryContract = typeof QueryContract.Type

/** Input to a paginated row query: identifies the data source, the query contract, and the optional resume cursor. */
export const QueryRowsInput = Schema.TaggedStruct('QueryRowsInput', {
  dataSourceId: DataSourceId,
  queryContract: QueryContract,
  startCursor: Schema.NullOr(QueryCursor),
}).annotations({ identifier: 'NotionDatasourceSync.QueryRowsInput' })
export type QueryRowsInput = typeof QueryRowsInput.Type

/** A single page of query results; `hasMore` and `nextCursor` drive pagination, `cappedAtLimit` indicates a result-cap was hit. */
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

/** Input to a paginated property-value retrieval for a specific page + property combination. */
export const RetrievePagePropertyInput = Schema.TaggedStruct('RetrievePagePropertyInput', {
  pageId: PageId,
  propertyId: PropertyId,
  startCursor: Schema.NullOr(QueryCursor),
}).annotations({ identifier: 'NotionDatasourceSync.RetrievePagePropertyInput' })
export type RetrievePagePropertyInput = typeof RetrievePagePropertyInput.Type

/** A single page of property items returned by a paginated property retrieval. */
export const PagePropertyItemPage = Schema.TaggedStruct('PagePropertyItemPage', {
  apiVersion: SupportedNotionApiVersion,
  requestId: NotionRequestId,
  pageId: PageId,
  propertyId: PropertyId,
  items: Schema.Array(PagePropertyItem),
  listMetadataHash: Schema.optional(Hash),
  nextCursor: Schema.NullOr(QueryCursor),
  hasMore: Schema.Boolean,
}).annotations({ identifier: 'NotionDatasourceSync.PagePropertyItemPage' })
export type PagePropertyItemPage = typeof PagePropertyItemPage.Type

/** Remote write command: applies a partial property patch to a Notion page, gated on the base properties hash matching. */
export const PatchPagePropertiesCommand = Schema.TaggedStruct('PatchPagePropertiesCommand', {
  commandId: CommandId,
  pageId: PageId,
  basePropertiesHash: Hash,
  propertyPatch: Schema.Record({ key: PropertyId, value: CanonicalPropertyValue }),
}).annotations({ identifier: 'NotionDatasourceSync.PatchPagePropertiesCommand' })
export type PatchPagePropertiesCommand = typeof PatchPagePropertiesCommand.Type

/**
 * Typed property definition for `AddProperty` schema operations.
 *
 * Limited to the conservative subset of Notion property types where the
 * adapter can build a fully specified remote payload without inferring
 * additional configuration. `title` is intentionally excluded because every
 * data source already has exactly one title property. `status` is excluded
 * because the Notion `Update a data source` endpoint documents status among
 * the properties that cannot be updated via the API; advertising it here
 * would suggest behavior the adapter cannot actually deliver.
 */
export const AddPropertyDefinition = Schema.Union(
  Schema.TaggedStruct('rich_text', {}),
  Schema.TaggedStruct('number', {}),
  Schema.TaggedStruct('checkbox', {}),
  Schema.TaggedStruct('date', {}),
  Schema.TaggedStruct('url', {}),
  Schema.TaggedStruct('email', {}),
  Schema.TaggedStruct('phone_number', {}),
  Schema.TaggedStruct('people', {}),
  Schema.TaggedStruct('select', { options: Schema.Array(CanonicalOptionValue) }),
  Schema.TaggedStruct('multi_select', { options: Schema.Array(CanonicalOptionValue) }),
).annotations({ identifier: 'NotionDatasourceSync.AddPropertyDefinition' })
export type AddPropertyDefinition = typeof AddPropertyDefinition.Type

/**
 * Single conservative schema patch operation.
 *
 * - `AddProperty` introduces a new property by name with a fully specified type.
 * - `RenameProperty` changes the human-readable name of an existing property.
 * - `AddSelectOptions` extends the option list of an existing
 *   `select`/`multi_select` property by appending `newOptions` after the
 *   explicit `existingOptions` snapshot the caller observed. The adapter
 *   sends the full `existingOptions ++ newOptions` list to Notion so omitted
 *   options are not silently removed by the `update_data_source` endpoint.
 *   `status` is intentionally unsupported: Notion documents status as a
 *   property type that cannot be updated via the API.
 *
 * Destructive operations (delete, change-type, remove-option, set/replace
 * options) are deliberately absent so unsupported intents fail closed at the
 * planner/adapter boundary.
 */
export const SchemaPatchOperation = Schema.Union(
  Schema.TaggedStruct('AddProperty', {
    name: PropertyName,
    definition: AddPropertyDefinition,
  }),
  Schema.TaggedStruct('RenameProperty', {
    propertyId: PropertyId,
    newName: PropertyName,
  }),
  Schema.TaggedStruct('AddSelectOptions', {
    propertyId: PropertyId,
    propertyType: Schema.Literal('select', 'multi_select'),
    existingOptions: Schema.Array(CanonicalOptionValue),
    newOptions: Schema.Array(CanonicalOptionValue),
  }),
).annotations({ identifier: 'NotionDatasourceSync.SchemaPatchOperation' })
export type SchemaPatchOperation = typeof SchemaPatchOperation.Type

/**
 * Remote write command: applies a partial schema patch to a Notion database,
 * gated on the base schema hash matching.
 *
 * The legacy `schemaPatch` record carries opaque per-property identity for
 * planner accounting; the newer `operations` list carries the typed
 * conservative subset that the adapter can actually translate to a Notion
 * `update_data_source` payload. Absent or empty `operations` keeps the
 * adapter on the fail-closed path.
 */
export const PatchDataSourceSchemaCommand = Schema.TaggedStruct('PatchDataSourceSchemaCommand', {
  commandId: CommandId,
  dataSourceId: DataSourceId,
  baseSchemaHash: Hash,
  schemaPatch: Schema.Record({ key: PropertyId, value: CanonicalDataSourceProperty }),
  operations: Schema.optionalWith(Schema.Array(SchemaPatchOperation), {
    default: () => [] as ReadonlyArray<SchemaPatchOperation>,
  }),
}).annotations({ identifier: 'NotionDatasourceSync.PatchDataSourceSchemaCommand' })
export type PatchDataSourceSchemaCommand = typeof PatchDataSourceSchemaCommand.Type

/** Remote write command: moves a Notion page to the trash, gated on the base properties hash. */
export const TrashPageCommand = Schema.TaggedStruct('TrashPageCommand', {
  commandId: CommandId,
  pageId: PageId,
  basePropertiesHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.TrashPageCommand' })
export type TrashPageCommand = typeof TrashPageCommand.Type

/** Remote write command: restores a trashed Notion page, gated on the base properties hash. */
export const RestorePageCommand = Schema.TaggedStruct('RestorePageCommand', {
  commandId: CommandId,
  pageId: PageId,
  basePropertiesHash: Hash,
}).annotations({ identifier: 'NotionDatasourceSync.RestorePageCommand' })
export type RestorePageCommand = typeof RestorePageCommand.Type

/** Input to `PageBodySyncPort.observe`: fetches the current body state and returns a `BodyPointer`. */
export const ObserveBodyInput = Schema.TaggedStruct('ObserveBodyInput', {
  pageId: PageId,
}).annotations({ identifier: 'NotionDatasourceSync.ObserveBodyInput' })
export type ObserveBodyInput = typeof ObserveBodyInput.Type

/** Input to `PageBodySyncPort.planLocalChange`: describes the local body modification to be evaluated for conflicts or intent promotion. */
export const BodyLocalChangeInput = Schema.TaggedStruct('BodyLocalChangeInput', {
  pageId: PageId,
  baseBodyPointer: BodyPointer,
  localBodyHash: Hash,
  localBodyPath: Schema.optional(WorkspaceRelativePath),
  localBodyContent: Schema.optional(Schema.String),
}).annotations({ identifier: 'NotionDatasourceSync.BodyLocalChangeInput' })
export type BodyLocalChangeInput = typeof BodyLocalChangeInput.Type

/** A confirmed local body intent: the desired next body hash relative to a known base pointer, ready to become a `BodyPushCommand`. */
export const BodyIntent = Schema.TaggedStruct('BodyIntent', {
  pageId: PageId,
  baseBodyPointer: BodyPointer,
  nextBodyHash: Hash,
  localBodyPath: Schema.optional(WorkspaceRelativePath),
  localBodyContent: Schema.optional(Schema.String),
}).annotations({ identifier: 'NotionDatasourceSync.BodyIntent' })
export type BodyIntent = typeof BodyIntent.Type

/** Named reason for a body conflict; maps directly to the `GuardName` values that can block a body push. */
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

/** Conflict detected by the body adapter between local and remote body states; prevents the push from proceeding without resolution. */
export const BodyConflict = Schema.TaggedStruct('BodyConflict', {
  pageId: PageId,
  baseBodyPointer: BodyPointer,
  localBodyHash: Hash,
  remoteBodyHash: Hash,
  reason: Schema.optional(BodyConflictReason),
  message: Schema.optional(Schema.String),
}).annotations({ identifier: 'NotionDatasourceSync.BodyConflict' })
export type BodyConflict = typeof BodyConflict.Type

/** Remote write command: pushes the next body hash to Notion, gated on the base body pointer. */
export const BodyPushCommand = Schema.TaggedStruct('BodyPushCommand', {
  commandId: CommandId,
  pageId: PageId,
  baseBodyPointer: BodyPointer,
  nextBodyHash: Hash,
  localBodyPath: Schema.optional(WorkspaceRelativePath),
  localBodyContent: Schema.optional(Schema.String),
}).annotations({ identifier: 'NotionDatasourceSync.BodyPushCommand' })
export type BodyPushCommand = typeof BodyPushCommand.Type

/** Result of a successful body push; carries the updated `BodyPointer` for post-write verification. */
export const BodyPushResult = Schema.TaggedStruct('BodyPushResult', {
  pageId: PageId,
  requestId: NotionRequestId,
  bodyPointer: BodyPointer,
}).annotations({ identifier: 'NotionDatasourceSync.BodyPushResult' })
export type BodyPushResult = typeof BodyPushResult.Type

/** Input to `PageBodySyncPort.repair`: re-reads the current body state to reconcile a prior desynchronization. */
export const BodyRepairInput = Schema.TaggedStruct('BodyRepairInput', {
  pageId: PageId,
  currentBodyPointer: BodyPointer,
}).annotations({ identifier: 'NotionDatasourceSync.BodyRepairInput' })
export type BodyRepairInput = typeof BodyRepairInput.Type

/** Discriminated union of all commands that cause a remote write to Notion; the `_tag` selects the operation kind. */
export const RemoteWriteCommand = Schema.Union(
  PatchPagePropertiesCommand,
  PatchDataSourceSchemaCommand,
  TrashPageCommand,
  RestorePageCommand,
  BodyPushCommand,
).annotations({ identifier: 'NotionDatasourceSync.RemoteWriteCommand' })
export type RemoteWriteCommand = typeof RemoteWriteCommand.Type

/** Payload stored in the outbox for a planned remote write; wraps the command so the outbox projection can decode it without knowing the concrete type. */
export const RemoteWritePlanPayload = Schema.Struct({
  command: RemoteWriteCommand,
}).annotations({ identifier: 'NotionDatasourceSync.RemoteWritePlanPayload' })
export type RemoteWritePlanPayload = typeof RemoteWritePlanPayload.Type
