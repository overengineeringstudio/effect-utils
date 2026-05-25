import { Schema } from 'effect'

import { CommandId, DataSourceId, PageId, SupportedNotionApiVersion } from './domain.ts'

export class ApiVersionCompatibilityMissing extends Schema.TaggedError<ApiVersionCompatibilityMissing>()(
  'ApiVersionCompatibilityMissing',
  {
    requestedVersion: Schema.String,
    supportedVersion: SupportedNotionApiVersion,
    message: Schema.String,
  },
) {}

export class UnsupportedCapabilityError extends Schema.TaggedError<UnsupportedCapabilityError>()(
  'UnsupportedCapabilityError',
  {
    dataSourceId: DataSourceId,
    capability: Schema.String,
    message: Schema.String,
  },
) {}

export class NotionGatewayError extends Schema.TaggedError<NotionGatewayError>()(
  'NotionGatewayError',
  {
    operation: Schema.String,
    dataSourceId: Schema.optional(DataSourceId),
    pageId: Schema.optional(PageId),
    requestId: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class LocalStoreError extends Schema.TaggedError<LocalStoreError>()('LocalStoreError', {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class BodySyncError extends Schema.TaggedError<BodySyncError>()('BodySyncError', {
  operation: Schema.String,
  pageId: PageId,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class SyncGuardError extends Schema.TaggedError<SyncGuardError>()('SyncGuardError', {
  guard: Schema.String,
  commandId: Schema.optional(CommandId),
  message: Schema.String,
}) {}

export type NotionDatasourceSyncError =
  | ApiVersionCompatibilityMissing
  | UnsupportedCapabilityError
  | NotionGatewayError
  | LocalStoreError
  | BodySyncError
  | SyncGuardError
