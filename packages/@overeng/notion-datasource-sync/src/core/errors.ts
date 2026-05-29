import { Schema } from 'effect'

import { CommandId, DataSourceId, PageId, SupportedNotionApiVersion } from './domain.ts'
import { GuardName } from './guards.ts'

/** Raised when the Notion API version is nominally supported but no compatibility proof has been recorded yet for this client version. */
export class ApiVersionCompatibilityMissing extends Schema.TaggedError<ApiVersionCompatibilityMissing>()(
  'ApiVersionCompatibilityMissing',
  {
    requestedVersion: Schema.String,
    supportedVersion: SupportedNotionApiVersion,
    message: Schema.String,
  },
) {}

/** Raised when the Notion workspace does not support a capability required by the planned operation. */
export class UnsupportedCapabilityError extends Schema.TaggedError<UnsupportedCapabilityError>()(
  'UnsupportedCapabilityError',
  {
    dataSourceId: DataSourceId,
    capability: Schema.String,
    message: Schema.String,
  },
) {}

/** Transport or semantic error returned by the Notion API gateway; includes operation context and optional guard annotation. */
export class NotionGatewayError extends Schema.TaggedError<NotionGatewayError>()(
  'NotionGatewayError',
  {
    operation: Schema.String,
    dataSourceId: Schema.optional(DataSourceId),
    pageId: Schema.optional(PageId),
    requestId: Schema.optional(Schema.String),
    guard: Schema.optional(GuardName),
    retryAfterMillis: Schema.optional(Schema.NonNegativeInt),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** I/O or integrity error from the local event store or projection storage. */
export class LocalStoreError extends Schema.TaggedError<LocalStoreError>()('LocalStoreError', {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Alias for `LocalStoreError`; used in port signatures that deal with filesystem-level storage. */
export type LocalStorageError = LocalStoreError

/** Error from the body-sync port (observe, push, or repair) for a specific page. */
export class BodySyncError extends Schema.TaggedError<BodySyncError>()('BodySyncError', {
  operation: Schema.String,
  pageId: PageId,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Raised when a sync guard blocks an operation that would normally be a defect; carries the guard name and optional command context. */
export class SyncGuardError extends Schema.TaggedError<SyncGuardError>()('SyncGuardError', {
  guard: GuardName,
  commandId: Schema.optional(CommandId),
  message: Schema.String,
}) {}

/** Union of all typed errors that the sync engine can raise in its Effect channel. */
export type NotionDatasourceSyncError =
  | ApiVersionCompatibilityMissing
  | UnsupportedCapabilityError
  | NotionGatewayError
  | LocalStoreError
  | BodySyncError
  | SyncGuardError
