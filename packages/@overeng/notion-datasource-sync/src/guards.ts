import { Schema } from 'effect'

import type { QueryRowsPage } from './commands.ts'
import type { CapabilityName, SupportedNotionApiVersion } from './domain.ts'

export const GuardName = Schema.Literal(
  'ApiVersionUnsupported',
  'ApiVersionCompatibilityMissing',
  'DecodeDriftUnsupported',
  'CapabilityPreflightFailed',
  'UnsupportedRemoteShape',
  'ComputedPropertyWrite',
  'PropertyValueIncomplete',
  'RelatedDataSourceUnshared',
  'StaleSurfaceBase',
  'PageTimestampWakeupOnly',
  'SchemaDriftAffectsIntent',
  'DestructiveSchemaMigrationRequired',
  'OptionDeletionLosesValues',
  'BodyLossyRemote',
  'MarkdownUnknownBlocksAmbiguous',
  'MarkdownSelectionAmbiguous',
  'MarkdownWouldDeleteChildren',
  'MarkdownSyncedPageUnsupported',
  'BodyAdapterConflict',
  'PathClaimCollision',
  'QueryAbsenceUnclassified',
  'PaginationIncomplete',
  'QueryContractChanged',
  'QueryResultCapExceeded',
  'FilteredAbsenceNotProof',
  'LinkedDataSourceUnsupported',
  'PermissionAmbiguous',
  'DeleteVsEdit',
  'MoveOutNotDelete',
  'UnavailableRelationTarget',
  'ExpiringFileUrl',
  'ReadAfterWriteMismatch',
  'AmbiguousCommandOutcome',
  'PendingIntentShadowViolation',
  'BodyAdapterNonBodyMutation',
  'FilesystemDeleteAutoTrashBlocked',
  'CursorSameBucketIncomplete',
  'OwnMaterializationWriteSuppressed',
  'CompactionUnsafe',
  'PathEscapesRoot',
  'LeaseFenceMismatch',
  'OutboxFirstSettlementWins',
  'CheckpointDigestMismatch',
  'StoreMigrationBlocked',
  'QueueBackpressureExceeded',
  'RawPayloadRetentionUnsafe',
).annotations({ identifier: 'NotionDatasourceSync.GuardName' })
export type GuardName = typeof GuardName.Type

export const GuardDecision = Schema.Union(
  Schema.TaggedStruct('allowed', {}),
  Schema.TaggedStruct('blocked', {
    guard: GuardName,
    message: Schema.String,
  }),
).annotations({ identifier: 'NotionDatasourceSync.GuardDecision' })
export type GuardDecision = typeof GuardDecision.Type

export const isSupportedApiVersion = (version: string): version is SupportedNotionApiVersion =>
  version === '2026-03-11'

export const guardApiVersion = (version: string): GuardDecision =>
  isSupportedApiVersion(version)
    ? { _tag: 'allowed' }
    : {
        _tag: 'blocked',
        guard: 'ApiVersionUnsupported',
        message: `Unsupported Notion API version: ${version}`,
      }

export const guardCapabilities = ({
  required,
  supported,
}: {
  readonly required: ReadonlyArray<CapabilityName>
  readonly supported: ReadonlyArray<CapabilityName>
}): GuardDecision => {
  const supportedSet = new Set(supported)
  const missing = required.find((capability) => supportedSet.has(capability) === false)

  return missing === undefined
    ? { _tag: 'allowed' }
    : {
        _tag: 'blocked',
        guard: 'CapabilityPreflightFailed',
        message: `Missing Notion capability: ${missing}`,
      }
}

export const isTerminalQueryRowsPage = (page: QueryRowsPage): boolean =>
  page.hasMore === false && page.nextCursor === null

export const shouldAdvanceQueryCheckpoint = (page: QueryRowsPage): GuardDecision => {
  if (page.cappedAtLimit === true) {
    return {
      _tag: 'blocked',
      guard: 'QueryResultCapExceeded',
      message: 'Query page hit the configured cap before a complete scan finished',
    }
  }

  return isTerminalQueryRowsPage(page)
    ? { _tag: 'allowed' }
    : {
        _tag: 'blocked',
        guard: 'PaginationIncomplete',
        message: 'Query checkpoint can advance only after the terminal page',
      }
}
