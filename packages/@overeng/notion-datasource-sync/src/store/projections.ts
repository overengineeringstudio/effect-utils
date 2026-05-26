import { createHash } from 'node:crypto'

import { Schema } from 'effect'

import { QueryMembershipScope } from '../core/commands.ts'
import { BodySafetySnapshot, DataSourceId, Hash, PageId, PropertyId } from '../core/domain.ts'
import type { SyncEvent } from '../core/events.ts'
import { type PropertyAvailability, type PropertyWriteClass } from '../core/guards.ts'
import { PROJECTOR_VERSION } from './schema.ts'

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

export type ProjectionDigestInput = {
  readonly sequence: bigint
  readonly eventId: string
  readonly payloadHash: string
}

export const hashStoreBytes = (value: string): Hash =>
  Schema.decodeSync(Hash)(`sha256:${createHash('sha256').update(value).digest('hex')}`)

export const pageLifecycleHash = (pageId: PageId, inTrash: boolean): Hash =>
  hashStoreBytes(`page-lifecycle\t${pageId}\t${inTrash ? 'in-trash' : 'active'}`)

export const computeProjectionDigest = (events: ReadonlyArray<ProjectionDigestInput>): Hash => {
  const lines = events.map(
    (event) =>
      `${PROJECTOR_VERSION}\t${event.sequence.toString()}\t${event.eventId}\t${event.payloadHash}`,
  )

  return hashStoreBytes(`${lines.join('\n')}\n`)
}

export const computePayloadHash = (event: SyncEvent): Hash =>
  hashStoreBytes(event.payload.canonicalJson)

export const isCompactionBlockingOutboxState = (state: OutboxState): boolean =>
  state === 'queued' || state === 'running' || state === 'retryable' || state === 'ambiguous'

export const ProjectionPropertyWriteClass = Schema.Literal(
  'writable',
  'computed',
  'unsupported',
).annotations({ identifier: 'NotionDatasourceSync.ProjectionPropertyWriteClass' })
export type ProjectionPropertyWriteClass = PropertyWriteClass

export const ProjectionPropertyAvailability = Schema.Literal(
  'complete',
  'computed',
  'unsupported',
  'paginated-incomplete',
  'relation-target-inaccessible',
  'related-data-source-unshared',
).annotations({ identifier: 'NotionDatasourceSync.ProjectionPropertyAvailability' })
export type ProjectionPropertyAvailability = PropertyAvailability

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

export const DataSourceProjectionPayload = Schema.Struct({
  schemaProperties: Schema.optional(
    Schema.Array(
      Schema.Struct({
        propertyId: PropertyId,
        configHash: Hash,
        writeClass: ProjectionPropertyWriteClass,
      }),
    ),
  ),
}).annotations({ identifier: 'NotionDatasourceSync.DataSourceProjectionPayload' })
export type DataSourceProjectionPayload = typeof DataSourceProjectionPayload.Type

export const RowProjectionPayload = Schema.Struct({
  movedOut: Schema.optional(Schema.Boolean),
  localDeleteCandidate: Schema.optional(Schema.Boolean),
  bodyPath: Schema.optional(Schema.NonEmptyTrimmedString),
  sidecarIdentityProven: Schema.optional(Schema.Boolean),
  ownWriteMaterializationIds: Schema.optional(Schema.Array(Schema.NonEmptyTrimmedString)),
}).annotations({ identifier: 'NotionDatasourceSync.RowProjectionPayload' })
export type RowProjectionPayload = typeof RowProjectionPayload.Type

export const PropertyCheckpointProjectionPayload = Schema.Struct({
  baseHash: Schema.optional(Hash),
  availability: Schema.optional(ProjectionPropertyAvailability),
}).annotations({ identifier: 'NotionDatasourceSync.PropertyCheckpointProjectionPayload' })
export type PropertyCheckpointProjectionPayload = typeof PropertyCheckpointProjectionPayload.Type

export const QueryCheckpointProjectionPayload = Schema.Struct({
  cappedAtLimit: Schema.optional(Schema.Boolean),
  contractChanged: Schema.optional(Schema.Boolean),
}).annotations({ identifier: 'NotionDatasourceSync.QueryCheckpointProjectionPayload' })
export type QueryCheckpointProjectionPayload = typeof QueryCheckpointProjectionPayload.Type

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

export const BodyProjectionSafetyPayload = Schema.Struct({
  safety: Schema.optional(BodySafetySnapshot),
}).annotations({ identifier: 'NotionDatasourceSync.BodyProjectionSafetyPayload' })
export type BodyProjectionSafetyPayload = typeof BodyProjectionSafetyPayload.Type
