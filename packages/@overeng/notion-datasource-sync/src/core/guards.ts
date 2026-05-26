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

/** Exhaustive set of named safety guards; each guard represents a distinct safety check the sync engine may enforce. */
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

/** Tagged-union outcome of a guard evaluation: `allowed` means the operation may proceed; `blocked` carries the guard name and reason. */
export const GuardDecision = Schema.Union(
  Schema.TaggedStruct('allowed', {}),
  Schema.TaggedStruct('blocked', {
    guard: GuardName,
    message: Schema.String,
  }),
).annotations({ identifier: 'NotionDatasourceSync.GuardDecision' })
export type GuardDecision = typeof GuardDecision.Type

/** Structured diagnostic payload attached to a guard block; provides a human-readable summary and key/value evidence for debugging. */
export const SafeDiagnostic = Schema.TaggedStruct('SafeDiagnostic', {
  summary: Schema.NonEmptyTrimmedString,
  evidence: Schema.Record({ key: Schema.String, value: Schema.String }),
}).annotations({ identifier: 'NotionDatasourceSync.SafeDiagnostic' })
export type SafeDiagnostic = typeof SafeDiagnostic.Type

/** Input snapshot for the API compatibility guard: the configured version and whether a compatibility proof has been recorded. */
export type ApiCompatibilitySnapshot = {
  readonly configuredApiVersion: string
  readonly compatibilityProof: 'present' | 'missing'
}

/** Input snapshot for the capability-preflight guard: required vs. supported capabilities and whether the preflight passed. */
export type CapabilityPreflightSnapshot = {
  readonly required: ReadonlyArray<CapabilityName>
  readonly supported: ReadonlyArray<CapabilityName>
  readonly preflight: 'passed' | 'failed'
}

/** Classifies whether a property can be written: `writable` allows the write, `computed` and `unsupported` block it. */
export type PropertyWriteClass = 'writable' | 'computed' | 'unsupported'

/** Availability status of a property value; used by `guardPropertyAvailability` to block writes when data is incomplete or inaccessible. */
export type PropertyAvailability =
  | 'complete'
  | 'computed'
  | 'unsupported'
  | 'paginated-incomplete'
  | 'relation-target-inaccessible'
  | 'related-data-source-unshared'

/** Input snapshot for schema-intent safety guards; captures the three conditions that can each independently block a schema write. */
export type SchemaIntentSafety = {
  readonly affectsLocalIntent: boolean
  readonly destructiveMigrationRequired: boolean
  readonly optionDeletionLosesValues: boolean
}

/** Input snapshot for query-completeness guards; `terminal` must be true for absence proofs to be valid. */
export type QueryCompletenessSnapshot = {
  readonly terminal: boolean
  readonly cappedAtLimit: boolean
  readonly contractChanged: boolean
}

/**
 * Input snapshot for the query-absence guard, used to decide whether a page missing from query results can be tombstoned.
 *
 * The `directRetrieve` field records the result of a targeted page-retrieve call that disambiguates absence from membership-filter exclusion.
 */
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

/** Input snapshot for the tombstone-safety guard; captures the three conditions that can each independently block a tombstone from being applied. */
export type TombstoneSafetySnapshot = {
  readonly deleteVsEdit: boolean
  readonly moveOutNotDelete: boolean
  readonly permissionAmbiguous: boolean
}

/** Input snapshot for the expiring-file-URL guard; Notion-hosted files without a stable ref are blocked to prevent broken links after URL expiry. */
export type FileReferenceSnapshot = {
  readonly kind: 'external' | 'notion-hosted' | 'unsupported'
  readonly stableRef: string | undefined
  readonly expiresAt: Date | undefined
}

const allowed = (): GuardDecision => ({ _tag: 'allowed' })

/** Constructs a `blocked` `GuardDecision` with the given guard name and reason message. */
export const blocked = (guard: GuardName, message: string): GuardDecision => ({
  _tag: 'blocked',
  guard,
  message,
})

/** Type predicate: returns `true` if `version` is the single supported Notion API version string. */
export const isSupportedApiVersion = (version: string): version is SupportedNotionApiVersion =>
  version === '2026-03-11'

const isFutureApiVersion = (version: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(version) && version > '2026-03-11'

/** Allows the supported API version and future unverified versions (as `ApiVersionUnverified`); blocks all other versions as `ApiVersionUnsupported`. */
export const guardApiVersion = (version: string): GuardDecision =>
  isSupportedApiVersion(version) === true
    ? allowed()
    : isFutureApiVersion(version) === true
      ? blocked('ApiVersionUnverified', `Unverified future Notion API version: ${version}`)
      : blocked('ApiVersionUnsupported', `Unsupported Notion API version: ${version}`)

/** Composes `guardApiVersion` with a check that a compatibility proof has been recorded for the configured version. */
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

/** Blocks sync when the decoded surface shape has drifted beyond what the current codec supports. */
export const guardDecodeDrift = ({ supported }: { readonly supported: boolean }): GuardDecision =>
  supported === true
    ? allowed()
    : blocked('DecodeDriftUnsupported', 'Unsupported decoded surface drift')

/** Blocks the operation if any of the required capabilities are absent from the supported set. */
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

/** Delegates to `guardCapabilities` only if the preflight step itself passed; otherwise blocks immediately. */
export const guardCapabilityPreflight = (snapshot: CapabilityPreflightSnapshot): GuardDecision =>
  snapshot.preflight === 'passed'
    ? guardCapabilities(snapshot)
    : blocked('CapabilityPreflightFailed', 'Notion capability preflight failed')

/** Blocks writes to computed or unsupported Notion property types. */
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

/** Blocks writes when a property value is incomplete, inaccessible, or the relation target is unavailable. */
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

/** Blocks a write if the command's base hash no longer matches the current surface hash, indicating a concurrent remote change. */
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

/** Blocks schema writes that would affect a pending local intent, require an explicit destructive migration, or delete option values still in use. */
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

/**
 * Evaluates all body-safety conditions in priority order and returns the first blocking decision.
 *
 * Checks (in order): non-body adapter mutations, truncation, unknown blocks, ambiguous selection, child deletion, synced-page, and adapter conflict.
 */
export const guardBodySafety = (snapshot: BodySafetySnapshot): GuardDecision => {
  if (snapshot.adapterMutationSurfaces.some((surface) => surface !== 'body') === true) {
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

/** Blocks a path claim when the requested path is already owned by a different page. */
export const guardPathClaimCollision = ({
  collides,
}: {
  readonly collides: boolean
}): GuardDecision =>
  collides === true
    ? blocked('PathClaimCollision', 'Path is already claimed by another page')
    : allowed()

/** Blocks checkpoint advancement if the query hit a result cap, the contract changed, or pagination is still in progress. */
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

/**
 * Determines whether a page missing from query results can be treated as a tombstone candidate.
 *
 * Filter-based exclusion is not proof of deletion unless the query uses `explicit-filter` scope. A direct
 * page retrieve result is required to disambiguate; `accessible` always allows, all other classified states allow when `classified` is true.
 */
export const guardQueryAbsence = (snapshot: QueryAbsenceSnapshot): GuardDecision => {
  if (snapshot.filtered === true && snapshot.membershipScope !== 'explicit-filter') {
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

/** Blocks a tombstone from being applied if it conflicts with a local edit, if the page was moved rather than deleted, or if page lifecycle is permission-ambiguous. */
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

/** Blocks writes that reference a relation target page that is not currently accessible. */
export const guardUnavailableRelationTarget = ({
  available,
}: {
  readonly available: boolean
}): GuardDecision =>
  available === true
    ? allowed()
    : blocked('UnavailableRelationTarget', 'Relation target is unavailable')

/** Blocks writes containing a Notion-hosted file URL that has no stable durable reference, preventing broken file links. */
export const guardExpiringFileUrl = (snapshot: FileReferenceSnapshot): GuardDecision =>
  snapshot.kind === 'notion-hosted' && snapshot.stableRef === undefined
    ? blocked('ExpiringFileUrl', 'Notion-hosted file URL is not durable identity')
    : allowed()

/** Blocks a command if the body adapter touched any surface outside `'body'`, enforcing the adapter's mutation boundary contract. */
export const guardBodyAdapterBoundary = ({
  mutationSurfaces,
}: {
  readonly mutationSurfaces: ReadonlyArray<BodyAdapterMutationSurface>
}): GuardDecision =>
  mutationSurfaces.some((surface) => surface !== 'body') === true
    ? blocked('BodyAdapterNonBodyMutation', 'Body adapter attempted a non-body mutation')
    : allowed()

/** Returns `true` when a query page has no further pages; used to determine whether pagination has reached completion. */
export const isTerminalQueryRowsPage = (page: QueryRowsPage): boolean =>
  page.hasMore === false && page.nextCursor === null

/** Allows a query checkpoint to advance only when the terminal page has been received and the result cap was not hit. */
export const shouldAdvanceQueryCheckpoint = (page: QueryRowsPage): GuardDecision => {
  if (page.cappedAtLimit === true) {
    return blocked(
      'QueryResultCapExceeded',
      'Query page hit the configured cap before a complete scan finished',
    )
  }

  return isTerminalQueryRowsPage(page) === true
    ? allowed()
    : blocked('PaginationIncomplete', 'Query checkpoint can advance only after the terminal page')
}
