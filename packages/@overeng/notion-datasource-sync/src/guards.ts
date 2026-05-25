import { Schema } from 'effect'

import type { QueryRowsPage } from './commands.ts'
import type {
  BodyAdapterMutationSurface,
  BodySafetySnapshot,
  CapabilityName,
  Hash,
  SupportedNotionApiVersion,
} from './domain.ts'
export type { BodyAdapterMutationSurface, BodySafetySnapshot } from './domain.ts'

export const GuardName = Schema.Literal(
  'ApiVersionUnsupported',
  'ApiVersionUnverified',
  'ApiVersionCompatibilityMissing',
  'DecodeDriftUnsupported',
  'CapabilityPreflightFailed',
  'UnsupportedRemoteShape',
  'ComputedPropertyWrite',
  'PropertyValueIncomplete',
  'RelatedDataSourceUnshared',
  'StaleSurfaceBase',
  'CurrentSurfaceMissing',
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

export const SafeDiagnostic = Schema.TaggedStruct('SafeDiagnostic', {
  summary: Schema.NonEmptyTrimmedString,
  evidence: Schema.Record({ key: Schema.String, value: Schema.String }),
}).annotations({ identifier: 'NotionDatasourceSync.SafeDiagnostic' })
export type SafeDiagnostic = typeof SafeDiagnostic.Type

export type ApiCompatibilitySnapshot = {
  readonly configuredApiVersion: string
  readonly compatibilityProof: 'present' | 'missing'
}

export type CapabilityPreflightSnapshot = {
  readonly required: ReadonlyArray<CapabilityName>
  readonly supported: ReadonlyArray<CapabilityName>
  readonly preflight: 'passed' | 'failed'
}

export type PropertyWriteClass = 'writable' | 'computed' | 'unsupported'

export type PropertyAvailability =
  | 'complete'
  | 'computed'
  | 'unsupported'
  | 'paginated-incomplete'
  | 'relation-target-inaccessible'
  | 'related-data-source-unshared'

export type SchemaIntentSafety = {
  readonly affectsLocalIntent: boolean
  readonly destructiveMigrationRequired: boolean
  readonly optionDeletionLosesValues: boolean
}

export type QueryCompletenessSnapshot = {
  readonly terminal: boolean
  readonly cappedAtLimit: boolean
  readonly contractChanged: boolean
}

export type QueryAbsenceSnapshot = {
  readonly classified: boolean
  readonly membershipScope: 'all-data-source-rows' | 'explicit-filter'
  readonly filtered: boolean
  readonly directRetrieve:
    | 'not-run'
    | 'accessible'
    | 'in-trash'
    | 'moved-out'
    | 'permission-ambiguous'
    | 'inaccessible'
    | 'unknown'
}

export type TombstoneSafetySnapshot = {
  readonly deleteVsEdit: boolean
  readonly moveOutNotDelete: boolean
  readonly permissionAmbiguous: boolean
}

export type FileReferenceSnapshot = {
  readonly kind: 'external' | 'notion-hosted' | 'unsupported'
  readonly stableRef: string | undefined
  readonly expiresAt: Date | undefined
}

const allowed = (): GuardDecision => ({ _tag: 'allowed' })

export const blocked = (guard: GuardName, message: string): GuardDecision => ({
  _tag: 'blocked',
  guard,
  message,
})

export const isSupportedApiVersion = (version: string): version is SupportedNotionApiVersion =>
  version === '2026-03-11'

const isFutureApiVersion = (version: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(version) && version > '2026-03-11'

export const guardApiVersion = (version: string): GuardDecision =>
  isSupportedApiVersion(version)
    ? allowed()
    : isFutureApiVersion(version)
      ? blocked('ApiVersionUnverified', `Unverified future Notion API version: ${version}`)
      : blocked('ApiVersionUnsupported', `Unsupported Notion API version: ${version}`)

export const guardApiCompatibility = (snapshot: ApiCompatibilitySnapshot): GuardDecision => {
  const versionGuard = guardApiVersion(snapshot.configuredApiVersion)
  if (versionGuard._tag === 'blocked') {
    return versionGuard
  }

  return snapshot.compatibilityProof === 'present'
    ? allowed()
    : blocked(
        'ApiVersionCompatibilityMissing',
        'Supported Notion API version is missing compatibility proof',
      )
}

export const guardDecodeDrift = ({ supported }: { readonly supported: boolean }): GuardDecision =>
  supported ? allowed() : blocked('DecodeDriftUnsupported', 'Unsupported decoded surface drift')

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
    ? allowed()
    : blocked('CapabilityPreflightFailed', `Missing Notion capability: ${missing}`)
}

export const guardCapabilityPreflight = (snapshot: CapabilityPreflightSnapshot): GuardDecision =>
  snapshot.preflight === 'passed'
    ? guardCapabilities(snapshot)
    : blocked('CapabilityPreflightFailed', 'Notion capability preflight failed')

export const guardPropertyWriteClass = ({
  writeClass,
}: {
  readonly writeClass: PropertyWriteClass
}): GuardDecision => {
  if (writeClass === 'computed') {
    return blocked('ComputedPropertyWrite', 'Computed Notion properties cannot be written')
  }

  return writeClass === 'unsupported'
    ? blocked('UnsupportedRemoteShape', 'Unsupported property shape cannot be written')
    : allowed()
}

export const guardPropertyAvailability = ({
  availability,
}: {
  readonly availability: PropertyAvailability
}): GuardDecision => {
  switch (availability) {
    case 'complete':
    case 'computed':
      return allowed()
    case 'paginated-incomplete':
      return blocked('PropertyValueIncomplete', 'Property value pagination is incomplete')
    case 'relation-target-inaccessible':
      return blocked('UnavailableRelationTarget', 'Relation target is unavailable')
    case 'related-data-source-unshared':
      return blocked('RelatedDataSourceUnshared', 'Related data source is not shared')
    case 'unsupported':
      return blocked('UnsupportedRemoteShape', 'Unsupported property value shape')
  }
}

export const guardStaleSurfaceBase = ({
  baseHash,
  currentHash,
}: {
  readonly baseHash: Hash
  readonly currentHash: Hash
}): GuardDecision =>
  baseHash === currentHash
    ? allowed()
    : blocked('StaleSurfaceBase', 'Local intent base hash is stale for the current surface')

export const guardSchemaIntentSafety = (snapshot: SchemaIntentSafety): GuardDecision => {
  if (snapshot.affectsLocalIntent === true) {
    return blocked('SchemaDriftAffectsIntent', 'Schema drift affects a pending local intent')
  }

  if (snapshot.destructiveMigrationRequired === true) {
    return blocked(
      'DestructiveSchemaMigrationRequired',
      'Schema change requires an explicit destructive migration',
    )
  }

  return snapshot.optionDeletionLosesValues === true
    ? blocked('OptionDeletionLosesValues', 'Deleting this option would lose row values')
    : allowed()
}

export const guardBodySafety = (snapshot: BodySafetySnapshot): GuardDecision => {
  if (snapshot.adapterMutationSurfaces.some((surface) => surface !== 'body')) {
    return blocked('BodyAdapterNonBodyMutation', 'Body adapter attempted a non-body mutation')
  }

  if (snapshot.truncated === true || snapshot.unknownBlockCause === 'truncation') {
    return blocked('BodyLossyRemote', 'Remote markdown body is truncated')
  }

  if (snapshot.unknownBlockCause !== undefined) {
    return blocked(
      'MarkdownUnknownBlocksAmbiguous',
      'Unknown markdown blocks have ambiguous preservation semantics',
    )
  }

  if (snapshot.selection === 'ambiguous') {
    return blocked('MarkdownSelectionAmbiguous', 'Markdown update selection is ambiguous')
  }

  if (snapshot.wouldDeleteChildren === true) {
    return blocked(
      'MarkdownWouldDeleteChildren',
      'Markdown update would delete child pages or databases',
    )
  }

  if (snapshot.syncedPageUnsupported === true) {
    return blocked('MarkdownSyncedPageUnsupported', 'Synced page body update is unsupported')
  }

  return snapshot.adapterConflict === true
    ? blocked('BodyAdapterConflict', 'Body adapter reported a delegated conflict')
    : allowed()
}

export const guardPathClaimCollision = ({
  collides,
}: {
  readonly collides: boolean
}): GuardDecision =>
  collides ? blocked('PathClaimCollision', 'Path is already claimed by another page') : allowed()

export const guardQueryCompleteness = (snapshot: QueryCompletenessSnapshot): GuardDecision => {
  if (snapshot.cappedAtLimit === true) {
    return blocked(
      'QueryResultCapExceeded',
      'Query reached the result cap before proving completeness',
    )
  }

  if (snapshot.contractChanged === true) {
    return blocked('QueryContractChanged', 'Query contract changed; old absence proof is invalid')
  }

  return snapshot.terminal === true
    ? allowed()
    : blocked('PaginationIncomplete', 'Query pagination did not reach a terminal page')
}

export const guardQueryAbsence = (snapshot: QueryAbsenceSnapshot): GuardDecision => {
  if (snapshot.filtered === true) {
    return blocked('FilteredAbsenceNotProof', 'Filtered query absence is not tombstone proof')
  }

  if (snapshot.directRetrieve === 'permission-ambiguous') {
    return blocked('PermissionAmbiguous', 'Direct page retrieval is permission ambiguous')
  }

  if (snapshot.directRetrieve === 'accessible') {
    return allowed()
  }

  if (
    snapshot.classified === true &&
    (snapshot.directRetrieve === 'in-trash' ||
      snapshot.directRetrieve === 'moved-out' ||
      snapshot.directRetrieve === 'inaccessible' ||
      snapshot.directRetrieve === 'unknown')
  ) {
    return allowed()
  }

  return blocked('QueryAbsenceUnclassified', 'Query absence must be directly classified first')
}

export const guardTombstoneSafety = (snapshot: TombstoneSafetySnapshot): GuardDecision => {
  if (snapshot.deleteVsEdit === true) {
    return blocked('DeleteVsEdit', 'Delete/trash conflicts with a local edit')
  }

  if (snapshot.moveOutNotDelete === true) {
    return blocked('MoveOutNotDelete', 'Moved-out page is not a remote delete')
  }

  return snapshot.permissionAmbiguous === true
    ? blocked('PermissionAmbiguous', 'Page lifecycle is permission ambiguous')
    : allowed()
}

export const guardUnavailableRelationTarget = ({
  available,
}: {
  readonly available: boolean
}): GuardDecision =>
  available ? allowed() : blocked('UnavailableRelationTarget', 'Relation target is unavailable')

export const guardExpiringFileUrl = (snapshot: FileReferenceSnapshot): GuardDecision =>
  snapshot.kind === 'notion-hosted' && snapshot.stableRef === undefined
    ? blocked('ExpiringFileUrl', 'Notion-hosted file URL is not durable identity')
    : allowed()

export const guardBodyAdapterBoundary = ({
  mutationSurfaces,
}: {
  readonly mutationSurfaces: ReadonlyArray<BodyAdapterMutationSurface>
}): GuardDecision =>
  mutationSurfaces.some((surface) => surface !== 'body')
    ? blocked('BodyAdapterNonBodyMutation', 'Body adapter attempted a non-body mutation')
    : allowed()

export const isTerminalQueryRowsPage = (page: QueryRowsPage): boolean =>
  page.hasMore === false && page.nextCursor === null

export const shouldAdvanceQueryCheckpoint = (page: QueryRowsPage): GuardDecision => {
  if (page.cappedAtLimit === true) {
    return blocked(
      'QueryResultCapExceeded',
      'Query page hit the configured cap before a complete scan finished',
    )
  }

  return isTerminalQueryRowsPage(page)
    ? allowed()
    : blocked('PaginationIncomplete', 'Query checkpoint can advance only after the terminal page')
}
