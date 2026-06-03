import { Schema } from 'effect'

import { sha256Hex } from '@overeng/utils'

import { QueryMembershipScope } from '../core/commands.ts'
import { BodySafetySnapshot, DataSourceId, Hash, PageId, PropertyId } from '../core/domain.ts'
import type { SyncEvent } from '../core/events.ts'
import { type PropertyAvailability, type PropertyWriteClass } from '../core/guards.ts'
import { PROJECTOR_VERSION } from './schema.ts'

/** All possible lifecycle states of an outbox command row. */
export const OutboxState = Schema.Literal(
  'queued',
  'running',
  'retryable',
  'blocked',
  'settled',
  'fenced',
  'ambiguous',
).annotations({ identifier: 'NotionDatasourceSync.OutboxState' })
export type OutboxState = typeof OutboxState.Type

/** Minimal event fields needed to compute a deterministic projection digest. */
export type ProjectionDigestInput = {
  readonly sequence: bigint
  readonly eventId: string
  readonly payloadHash: string
}

/** Compute a `sha256:`-prefixed `Hash` from an arbitrary UTF-8 string. */
export const hashStoreBytes = (value: string): Hash =>
  Schema.decodeSync(Hash)(`sha256:${sha256Hex(value)}`)

/** Stable hash encoding a page's trash state, used for stale-base detection on `trashPage` / `restorePage`. */
export const pageLifecycleHash = ({
  pageId,
  inTrash,
}: {
  readonly pageId: PageId
  readonly inTrash: boolean
}): Hash => hashStoreBytes(`page-lifecycle\t${pageId}\t${inTrash === true ? 'in-trash' : 'active'}`)

/** Compute a deterministic digest over a contiguous run of events, used to verify that a stored projection is still current. */
export const computeProjectionDigest = (events: ReadonlyArray<ProjectionDigestInput>): Hash => {
  const lines = events.map(
    (event) =>
      `${PROJECTOR_VERSION}\t${event.sequence.toString()}\t${event.eventId}\t${event.payloadHash}`,
  )

  return hashStoreBytes(`${lines.join('\n')}\n`)
}

/** Hash the canonical JSON payload of a `SyncEvent`, used for deduplication and projection digest computation. */
export const computePayloadHash = (event: SyncEvent): Hash =>
  hashStoreBytes(event.payload.canonicalJson)

/** Returns true when an outbox command in the given state must prevent compaction from proceeding. */
export const isCompactionBlockingOutboxState = (state: OutboxState): boolean =>
  state === 'queued' || state === 'running' || state === 'retryable' || state === 'ambiguous'

/** Schema-encoded write-class literal stored in `schema_property_projection`. */
export const ProjectionPropertyWriteClass = Schema.Literal(
  'writable',
  'computed',
  'unsupported',
).annotations({ identifier: 'NotionDatasourceSync.ProjectionPropertyWriteClass' })
/** TypeScript alias for `PropertyWriteClass` — re-exported alongside the Schema literal for symmetry. */
export type ProjectionPropertyWriteClass = PropertyWriteClass

/** Schema-encoded availability literal stored in `property_shadow_projection`. */
export const ProjectionPropertyAvailability = Schema.Literal(
  'complete',
  'computed',
  'unsupported',
  'paginated-incomplete',
  'relation-target-inaccessible',
  'related-data-source-unshared',
).annotations({ identifier: 'NotionDatasourceSync.ProjectionPropertyAvailability' })
/** TypeScript alias for `PropertyAvailability` — re-exported alongside the Schema literal for symmetry. */
export type ProjectionPropertyAvailability = PropertyAvailability

/** Schema-encoded direct-retrieve outcome stored in `query_absence_projection`. */
export const ProjectionDirectRetrieve = Schema.Literal(
  'not-run',
  'accessible',
  'in-trash',
  'moved-out',
  'permission-ambiguous',
  'inaccessible',
  'unknown',
).annotations({ identifier: 'NotionDatasourceSync.ProjectionDirectRetrieve' })
export type ProjectionDirectRetrieve = typeof ProjectionDirectRetrieve.Type

/** Auxiliary JSON payload stored alongside `data_source_projection` rows (schema property list). */
export const DataSourceProjectionPayload = Schema.Struct({
  schemaProperties: Schema.optional(
    Schema.Array(
      Schema.Struct({
        _tag: Schema.optional(Schema.Literal('DataSourcePropertySnapshot')),
        propertyId: PropertyId,
        name: Schema.optional(Schema.NonEmptyTrimmedString),
        type: Schema.optional(Schema.NonEmptyTrimmedString),
        configHash: Hash,
        writeClass: ProjectionPropertyWriteClass,
        ordinal: Schema.optional(Schema.NonNegativeInt),
        configJson: Schema.optional(Schema.String),
      }),
    ),
  ),
}).annotations({ identifier: 'NotionDatasourceSync.DataSourceProjectionPayload' })
export type DataSourceProjectionPayload = typeof DataSourceProjectionPayload.Type

/** Auxiliary JSON payload stored alongside `row_projection` rows (body path, move status, sidecar identity). */
export const RowProjectionPayload = Schema.Struct({
  movedOut: Schema.optional(Schema.Boolean),
  localDeleteCandidate: Schema.optional(Schema.Boolean),
  bodyPath: Schema.optional(Schema.NonEmptyTrimmedString),
  sidecarIdentityProven: Schema.optional(Schema.Boolean),
  ownWriteMaterializationIds: Schema.optional(Schema.Array(Schema.NonEmptyTrimmedString)),
}).annotations({ identifier: 'NotionDatasourceSync.RowProjectionPayload' })
export type RowProjectionPayload = typeof RowProjectionPayload.Type

/** Auxiliary JSON payload stored alongside `page_property_checkpoint` rows (base hash, availability). */
export const PropertyCheckpointProjectionPayload = Schema.Struct({
  baseHash: Schema.optional(Hash),
  availability: Schema.optional(ProjectionPropertyAvailability),
  valueJson: Schema.optional(Schema.String),
}).annotations({ identifier: 'NotionDatasourceSync.PropertyCheckpointProjectionPayload' })
export type PropertyCheckpointProjectionPayload = typeof PropertyCheckpointProjectionPayload.Type

/** Auxiliary JSON payload stored alongside `query_scan_checkpoint` rows (cap/contract-change flags). */
export const QueryCheckpointProjectionPayload = Schema.Struct({
  cappedAtLimit: Schema.optional(Schema.Boolean),
  contractChanged: Schema.optional(Schema.Boolean),
}).annotations({ identifier: 'NotionDatasourceSync.QueryCheckpointProjectionPayload' })
export type QueryCheckpointProjectionPayload = typeof QueryCheckpointProjectionPayload.Type

/** Auxiliary JSON payload stored alongside `query_absence_projection` rows (absence classification details). */
export const QueryAbsenceProjectionPayload = Schema.Struct({
  dataSourceId: Schema.optional(DataSourceId),
  pageId: Schema.optional(PageId),
  queryContractHash: Schema.optional(Hash),
  classified: Schema.optional(Schema.Boolean),
  membershipScope: Schema.optional(QueryMembershipScope),
  filtered: Schema.optional(Schema.Boolean),
  directRetrieve: Schema.optional(ProjectionDirectRetrieve),
}).annotations({ identifier: 'NotionDatasourceSync.QueryAbsenceProjectionPayload' })
export type QueryAbsenceProjectionPayload = typeof QueryAbsenceProjectionPayload.Type

/** Auxiliary JSON payload stored alongside `body_pointer_projection` rows (safety snapshot used for conflict detection). */
export const BodyProjectionSafetyPayload = Schema.Struct({
  safety: Schema.optional(BodySafetySnapshot),
}).annotations({ identifier: 'NotionDatasourceSync.BodyProjectionSafetyPayload' })
export type BodyProjectionSafetyPayload = typeof BodyProjectionSafetyPayload.Type
