import { evaluatePropertyWrite } from '@overeng/notion-property-write'

import type {
  BodyPushCommand,
  CreatePageCommand,
  PatchDatabaseMetadataCommand,
  PatchDataSourceMetadataCommand,
  PatchDataSourceSchemaCommand,
  PatchPagePropertiesCommand,
  RemoteWriteCommand,
  RestorePageCommand,
  TrashPageCommand,
} from '../core/commands.ts'
import type { ConflictPayload } from '../core/conflicts.ts'
import { classifyConflict, type ConflictSurface } from '../core/conflicts.ts'
import type {
  BodyPointer,
  CommandId,
  DatabaseId,
  DataSourceId,
  Hash,
  PageId,
  PropertyId,
} from '../core/domain.ts'
import type { IdempotencyKey, SurfaceKey, SyncEventId, SyncRootId } from '../core/events.ts'
import {
  guardApiCompatibility,
  guardBodySafety,
  guardCapabilityPreflight,
  guardPathClaimCollision,
  guardQueryAbsence,
  guardQueryCompleteness,
  guardSchemaIntentSafety,
  guardStaleSurfaceBase,
  guardTombstoneSafety,
  type ApiCompatibilitySnapshot,
  type BodySafetySnapshot,
  type CapabilityPreflightSnapshot,
  type GuardDecision,
  type GuardName,
  type PropertyAvailability,
  type PropertyWriteClass,
  type QueryAbsenceSnapshot,
  type QueryCompletenessSnapshot,
  type SafeDiagnostic,
  type SchemaIntentSafety,
} from '../core/guards.ts'
import { evaluateDesiredFileReferences, makeWorkspaceProof } from './property-proof.ts'

/** Planner-visible view of a single property column in the remote data source schema. */
export type SchemaPropertySurface = {
  readonly dataSourceId: DataSourceId
  readonly propertyId: PropertyId
  readonly schemaHash: Hash
  readonly configHash: Hash
  readonly writeClass: PropertyWriteClass
  /**
   * `false` when the remote data-source schema was not freshly observed for this
   * write; surfaces as `RemoteSchemaRequired`. Defaults to `true` (a present
   * schema surface is, by construction, an observation).
   */
  readonly remoteSchemaObserved?: boolean
  /**
   * `false` when the resolved display name maps ambiguously to more than one
   * property on the observed schema; surfaces as `PropertyIdentityAmbiguous`.
   * Defaults to `true`.
   */
  readonly displayNameUnambiguous?: boolean
  /**
   * The authored whole-schema identity hash to compare against the observed
   * {@link schemaHash}. When present and differing, surfaces as
   * `StaleRemoteSchema`. Omitted when no authored whole-schema oracle exists, so
   * the staleness check honestly skips.
   */
  readonly expectedSchemaHash?: Hash
}

/** Planner-visible data-source metadata surface, independent from property schema. */
export type DataSourceMetadataSurface = {
  readonly dataSourceId: DataSourceId
  readonly metadataHash: Hash
}

/** Planner-visible database/container metadata surface, verified through an owning data source. */
export type DatabaseMetadataSurface = {
  readonly databaseId: DatabaseId
  readonly dataSourceId: DataSourceId
  readonly metadataHash: Hash
}

/** Observed state of a single page property used by the planner to detect conflicts and stale intents. */
export type PropertySurfaceSnapshot = {
  readonly pageId: PageId
  readonly propertyId: PropertyId
  readonly baseHash: Hash
  readonly remoteHash: Hash
  readonly availability: PropertyAvailability
  readonly pendingLocal:
    | {
        readonly intentEventId: SyncEventId
        readonly targetHash: Hash
        /**
         * Outbox state of the unsettled prior write. The settlement gate fires
         * only for genuinely in-flight states ({@link PENDING_INTENT_IN_FLIGHT_STATES});
         * terminal/non-reclaimable refusals (`blocked` from a pre-write
         * `StaleSurfaceBase`/`CurrentSurfaceMissing`) never settle and must NOT
         * poison the cell as a misleading `ReadAfterWriteMismatch`.
         */
        readonly state: 'queued' | 'running' | 'retryable' | 'blocked' | 'ambiguous'
      }
    | undefined
  /*
   * The three fields below are threaded into the shared property-write proof
   * (see `makeWorkspaceProof`). All three are populated in production by
   * `withAuthorityMode`: `writeMode` from the manifest authority mode;
   * `localConvergence` from the Phase 4 shared-mode local convergence
   * (`buildPropertyConvergenceInputs` + `convergeLocalSurfaces` +
   * `applyConvergenceVerdicts` in the CLI push path); and `settlement` from real
   * outbox read-after-write state — `withAuthorityMode` maps a genuinely in-flight
   * prior write (`pendingLocal` present with an in-flight `state`, from
   * `#pendingPropertyIntents`) to `missing` in `shared` mode. So
   * `RemoteAuthoritativeDrift`, `LocalSurfaceDisagreement`, and
   * `ReadAfterWriteMismatch` all fire from real production state.
   */
  /**
   * Workspace entrypoint / page-authority signal threaded into the shared
   * property-write proof. `remote` marks a Notion-authoritative page, against
   * which the planner refuses a local property mutation as
   * `RemoteAuthoritativeDrift` BEFORE building a proof. Defaults to `shared`.
   */
  readonly writeMode?: 'local' | 'shared' | 'remote'
  /**
   * Whether the local SQLite `pages` projection agrees with the materialized
   * `.nmd` artifact for this page property. `disagrees` surfaces as
   * `LocalSurfaceDisagreement`. Defaults to `not-applicable`.
   *
   * In `shared` mode the Phase 4 local-convergence engine
   * (`convergeLocalSurfaces` + `applyConvergenceVerdicts`) computes this verdict
   * by comparing the drained SQLite data-file edits against the decoded `.nmd`
   * frontmatter desired facts per `(pageId, propertyId)`, wired into the CLI push
   * path. ACTIVE on production data (SM5d): pulls materialize the writable
   * frontmatter properties into the `.nmd`, so a real `disagrees` arises from an
   * actual divergence between a pulled page's `.nmd` and the SQLite projection.
   * `local`/`remote` mode is always `not-applicable` (single source mirrors the
   * other).
   */
  readonly localConvergence?: 'not-applicable' | 'converged' | 'disagrees'
  /**
   * Outbox read-after-write settlement context. In `shared` mode a `missing`
   * settlement surfaces as `ReadAfterWriteMismatch`. Populated by
   * `withAuthorityMode` from real outbox state: a genuinely in-flight prior write
   * for this `(pageId, propertyId)` (`pendingLocal` present with an in-flight
   * `state` — see {@link PENDING_INTENT_IN_FLIGHT_STATES}) is `missing`; otherwise
   * `present`. A terminal `blocked` refusal does NOT gate, since the write never
   * executed and never settles. `local`/`remote` mode carries no read-after-write
   * requirement and is `not-required`. When the surface omits it (no authority
   * mode / untracked store) the proof falls back to the non-blocking `present`
   * default.
   */
  readonly settlement?: 'not-required' | 'present' | 'missing'
}

/** Observed state of a remote row used to check lifecycle guards (trash, move-out) before planning writes or deletes. */
export type RowSurfaceSnapshot = {
  readonly pageId: PageId
  readonly dataSourceId: DataSourceId
  readonly propertiesHash: Hash
  readonly inTrash: boolean
  readonly movedOut: boolean
  readonly localDeleteCandidate: boolean
}

/** Observed body pointer state for a page, including safety diagnostics and own-write suppression tokens. */
export type BodyPointerSurfaceSnapshot = {
  readonly pageId: PageId
  readonly path: string
  readonly baseHash: Hash
  readonly currentHash: Hash
  readonly pointer: BodyPointer
  readonly sidecarIdentityProven: boolean
  readonly ownWriteMaterializationIds: ReadonlyArray<string>
  readonly safety: BodySafetySnapshot
}

/** Planner-visible tombstone record; `state` tracks lifecycle classification from unclassified candidate through to a definitive absence reason. */
export type TombstoneSurfaceSnapshot = {
  readonly pageId: PageId
  readonly dataSourceId: DataSourceId | undefined
  readonly queryContractHash: Hash | undefined
  readonly state: 'none' | 'candidate' | 'remote-trash' | 'moved-out' | 'inaccessible' | 'unknown'
  readonly directRetrieve: QueryAbsenceSnapshot['directRetrieve']
}

/** Planner-visible state of a query scan checkpoint, combining completeness and page absence proofs needed for tombstone classification. */
export type QueryCheckpointSurfaceSnapshot = {
  readonly dataSourceId: DataSourceId
  readonly pageId: PageId
  readonly queryContractHash: Hash
  readonly completeness: QueryCompletenessSnapshot
  readonly absence: QueryAbsenceSnapshot
}

/** Active or released path claim; used to detect collisions when a new page intent tries to claim the same local file path. */
export type PathClaimSurfaceSnapshot = {
  readonly path: string
  readonly ownerPageId: PageId
  readonly released: boolean
}

/** Observed state of a page's local workspace artifact, used to distinguish intentional deletes from mass-deletion heuristics and own-write suppression. */
export type LocalWorkspaceSurfaceSnapshot = {
  readonly pageId: PageId
  readonly path: string
  readonly sidecarIdentityProven: boolean
  readonly deleted: boolean
  readonly branchLikeMassDeletion: boolean
  readonly materializationId: string | undefined
}

/** Full read-model snapshot fed into the planner; aggregates every surface the planner may inspect to make a `PlanDecision`. */
export type PlannerProjectionSnapshot = {
  readonly rootId: SyncRootId
  readonly api: ApiCompatibilitySnapshot
  readonly capabilities: CapabilityPreflightSnapshot
  readonly metadata: ReadonlyArray<DataSourceMetadataSurface>
  readonly databaseMetadata: ReadonlyArray<DatabaseMetadataSurface>
  readonly schema: ReadonlyArray<SchemaPropertySurface>
  readonly rows: ReadonlyArray<RowSurfaceSnapshot>
  readonly properties: ReadonlyArray<PropertySurfaceSnapshot>
  readonly bodies: ReadonlyArray<BodyPointerSurfaceSnapshot>
  readonly tombstones: ReadonlyArray<TombstoneSurfaceSnapshot>
  readonly queries: ReadonlyArray<QueryCheckpointSurfaceSnapshot>
  readonly pathClaims: ReadonlyArray<PathClaimSurfaceSnapshot>
  readonly localWorkspace: ReadonlyArray<LocalWorkspaceSurfaceSnapshot>
  readonly remoteChanges: ReadonlyArray<ConflictSurface>
}

/**
 * Overlays the workspace-wide authority mode (decisions 0003, 0010) onto every
 * property snapshot's `writeMode`, and derives each property's `settlement`
 * verdict from real outbox read-after-write state. This is the single chokepoint
 * applied wherever a `readPlannerProjectionSnapshot` result is handed to
 * `planIntent`: the manifest authority mode drives property-write authority, not
 * yet-to-be-built per-page observation. `remote` makes a local property edit drift
 * (`RemoteAuthoritativeDrift`); `local`/`shared` reach the property-write proof.
 * `undefined` leaves the snapshot untouched so the planner keeps its `shared`
 * default (behavior-preserving for standalone/untracked stores).
 *
 * Settlement wiring: a property's `pendingLocal` is populated by the store from
 * `#pendingPropertyIntents`, which selects exactly the outbox `PatchPageProperties`
 * commands for this `(pageId, propertyId)` that are still unsettled
 * (`settlement_event_id IS NULL` and state ∈ queued/running/retryable/blocked/
 * ambiguous) and carries the outbox `state`. The settlement gate fires only for a
 * GENUINELY IN-FLIGHT prior write — state ∈ {queued, running, retryable, ambiguous}
 * (see {@link PENDING_INTENT_IN_FLIGHT_STATES}): the write is still being driven
 * toward settlement, or its verification was ambiguous and will be re-driven, so a
 * new property write must be gated as `missing` and block via the core's
 * `ReadAfterWriteMismatch`. A `blocked` state is EXCLUDED: it is a pre-write
 * `StaleSurfaceBase`/`CurrentSurfaceMissing` refusal — the write never executed,
 * the claim query never reclaims it, and `settle()` never clears it, so it is a
 * permanent dead end that never represents a real read-after-write race. Gating on
 * it would falsely poison the cell; genuine remote drift is handled by the
 * remoteHash-drift branch below, and a stuck `StaleSurfaceBase` must surface as its
 * own cause. When no in-flight prior write is pending the prior surface is settled
 * (or there is nothing to settle), so `present` is the genuinely-safe verdict. The
 * core's settlement check is mode-blind, so mode-awareness lives HERE:
 * `local`/`remote` writes carry no read-after-write requirement and map to
 * `not-required`.
 *
 * Every code path that plans a local property write — `pushOneShotSync`, the
 * `conflicts resolve` command, and the CDC `conflict_resolution` path — MUST route
 * its snapshot through this helper, or a `remote`-mode workspace silently bypasses
 * the drift guard.
 */
/**
 * Outbox states whose pending property write is genuinely in-flight — the write
 * is still being driven toward settlement (or its verification was ambiguous and
 * will be re-driven). Only these gate a new shared-mode write as `missing`.
 *
 * `blocked` is deliberately excluded: it is a pre-write refusal recorded for a
 * `StaleSurfaceBase`/`CurrentSurfaceMissing` guard — the write never executed,
 * the claim query never reclaims it, and `settle()` never clears it, so it is a
 * permanent dead end. Gating on it would poison the cell with a misleading
 * `ReadAfterWriteMismatch` for a write that never raced anything; genuine drift
 * is surfaced by the remoteHash-drift branch in {@link planIntent} and a stuck
 * `StaleSurfaceBase` must surface as its own cause. (`fenced` is likewise
 * terminal and already excluded upstream by `#pendingPropertyIntents`.)
 */
const PENDING_INTENT_IN_FLIGHT_STATES: ReadonlySet<
  'queued' | 'running' | 'retryable' | 'ambiguous'
> = new Set(['queued', 'running', 'retryable', 'ambiguous'])

export const withAuthorityMode = ({
  snapshot,
  authorityMode,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly authorityMode: 'local' | 'shared' | 'remote' | undefined
}): PlannerProjectionSnapshot =>
  authorityMode === undefined
    ? snapshot
    : {
        ...snapshot,
        properties: snapshot.properties.map((property) => ({
          ...property,
          writeMode: authorityMode,
          settlement:
            authorityMode === 'shared'
              ? property.pendingLocal !== undefined &&
                (PENDING_INTENT_IN_FLIGHT_STATES as ReadonlySet<string>).has(
                  property.pendingLocal.state,
                ) === true
                ? 'missing'
                : 'present'
              : 'not-required',
        })),
      }

/** Wrapper that pairs a `RemoteWriteCommand` with its sync metadata (surface key, intent event id, preflight guards) for safe outbox enqueuing. */
export type OutboxCommandEnvelope = {
  readonly commandId: CommandId
  readonly commandKey: IdempotencyKey
  readonly rootId: SyncRootId
  readonly intentEventId: SyncEventId
  readonly surface: SurfaceKey
  readonly command: RemoteWriteCommand
  readonly baseHash: Hash
  readonly desiredHash: Hash
  readonly preflight: ReadonlyArray<GuardName>
}

/** Side-effect-free event emitted by the planner when it accepts an observation (path claim, tombstone classification, etc.) without needing a remote write. */
export type PlannerEvent =
  | {
      readonly _tag: 'LocalDeleteCandidateAccepted'
      readonly pageId: PageId
      readonly surface: SurfaceKey
      readonly reason: 'filesystem-delete-candidate' | 'workspace-repair-candidate'
    }
  | {
      readonly _tag: 'TombstoneCandidateObserved'
      readonly pageId: PageId
      readonly surface: SurfaceKey
      readonly reason: 'query-absence-unclassified' | 'filtered-absence-not-proof'
    }
  | {
      readonly _tag: 'TombstoneClassified'
      readonly pageId: PageId
      readonly surface: SurfaceKey
      readonly reason: 'remote-trash' | 'moved-out' | 'inaccessible' | 'unknown'
    }
  | {
      readonly _tag: 'RemoteObservationAccepted'
      readonly surface: SurfaceKey
      readonly observedHash: Hash
    }
  | {
      readonly _tag: 'PathClaimAccepted'
      readonly pageId: PageId
      readonly surface: SurfaceKey
      readonly path: string
    }

/**
 * Tagged union returned by `planIntent` describing what the planner decided.
 *
 * - `AppendEvents` — intent resolved locally; emit these planner events to the store.
 * - `EnqueueCommands` — intent requires a remote write; enqueue these outbox commands.
 * - `OpenConflict` — a conflicting remote change was detected; raise a conflict record.
 * - `BlockedByGuard` — a guard condition prevents planning; record a guard-blocked event.
 */
export type PlanDecision =
  | { readonly _tag: 'AppendEvents'; readonly events: ReadonlyArray<PlannerEvent> }
  | { readonly _tag: 'EnqueueCommands'; readonly commands: ReadonlyArray<OutboxCommandEnvelope> }
  | { readonly _tag: 'OpenConflict'; readonly conflict: ConflictPayload }
  | {
      readonly _tag: 'BlockedByGuard'
      readonly guard: GuardName
      readonly surface: SurfaceKey
      readonly detail: SafeDiagnostic
    }

/** Intent to patch a single page property value on the remote data source. */
export type PropertyEditIntent = {
  readonly _tag: 'property-edit'
  readonly intentEventId: SyncEventId
  readonly commandKey: IdempotencyKey
  readonly surface: SurfaceKey
  readonly pageId: PageId
  readonly propertyId: PropertyId
  readonly command: PatchPagePropertiesCommand
  readonly baseHash: Hash
  readonly desiredHash: Hash
  readonly expectedPropertyConfigHash: Hash
}

/** Intent to push a local body change to the remote page. */
export type BodyEditIntent = {
  readonly _tag: 'body-edit'
  readonly intentEventId: SyncEventId
  readonly commandKey: IdempotencyKey
  readonly surface: SurfaceKey
  readonly pageId: PageId
  readonly command: BodyPushCommand
  readonly baseHash: Hash
  readonly desiredHash: Hash
}

/** Intent to update the remote data source schema — e.g. rename a property or add/remove select options. */
export type SchemaMigrationIntent = {
  readonly _tag: 'schema-migration'
  readonly intentEventId: SyncEventId
  readonly commandKey: IdempotencyKey
  readonly surface: SurfaceKey
  readonly dataSourceId: DataSourceId
  readonly affectedPropertyIds: ReadonlyArray<PropertyId>
  readonly command: PatchDataSourceSchemaCommand
  readonly baseHash: Hash
  readonly desiredHash: Hash
  readonly safety: SchemaIntentSafety
}

/** Intent to update remote data-source presentation metadata — currently title and description. */
export type DataSourceMetadataEditIntent = {
  readonly _tag: 'data-source-metadata-edit'
  readonly intentEventId: SyncEventId
  readonly commandKey: IdempotencyKey
  readonly surface: SurfaceKey
  readonly dataSourceId: DataSourceId
  readonly command: PatchDataSourceMetadataCommand
  readonly baseHash: Hash
  readonly desiredHash: Hash
}

/** Intent to update remote database/container metadata through the public SQLite database authority surface. */
export type DatabaseMetadataEditIntent = {
  readonly _tag: 'database-metadata-edit'
  readonly intentEventId: SyncEventId
  readonly commandKey: IdempotencyKey
  readonly surface: SurfaceKey
  readonly databaseId: DatabaseId
  readonly dataSourceId: DataSourceId
  readonly command: PatchDatabaseMetadataCommand
  readonly baseHash: Hash
  readonly desiredHash: Hash
}

/** Intent to create a new row/page in a data source. */
export type RowCreateIntent = {
  readonly _tag: 'row-create'
  readonly intentEventId: SyncEventId
  readonly commandKey: IdempotencyKey
  readonly surface: SurfaceKey
  readonly dataSourceId: DataSourceId
  readonly command: CreatePageCommand
  readonly baseHash: Hash
  readonly desiredHash: Hash
}

/** Intent to change a page lifecycle state on the remote, triggered by a local workspace/replica lifecycle edit; `policy` and `explicitDestructiveIntent` control whether the planner escalates to a real remote write or treats it as a candidate. */
export type LocalDeleteIntent = {
  readonly _tag: 'local-delete'
  readonly intentEventId: SyncEventId
  readonly commandKey: IdempotencyKey
  readonly surface: SurfaceKey
  readonly pageId: PageId
  readonly command: TrashPageCommand | RestorePageCommand
  readonly baseHash: Hash
  readonly desiredHash: Hash
  readonly explicitDestructiveIntent: boolean
  readonly policy: 'candidateOnly' | 'trustedRemoteTrash'
  readonly directRetrieve: QueryAbsenceSnapshot['directRetrieve']
}

/** Intent to record a page's ownership of a local filesystem path; blocked if another page already holds the same path. */
export type PathClaimIntent = {
  readonly _tag: 'path-claim'
  readonly surface: SurfaceKey
  readonly pageId: PageId
  readonly path: string
}

/** Intent to classify why a previously-known page no longer appears in a query result; resolves to a tombstone event or a block if proof is insufficient. */
export type QueryAbsenceIntent = {
  readonly _tag: 'query-absence'
  readonly surface: SurfaceKey
  readonly dataSourceId: DataSourceId
  readonly pageId: PageId
  readonly queryContractHash: Hash
}

/** Intent that records the outcome of a body adapter safety check; blocked if the adapter reports lossy or non-body mutations. */
export type BodyAdapterResultIntent = {
  readonly _tag: 'body-adapter-result'
  readonly surface: SurfaceKey
  readonly pageId: PageId
  readonly safety: BodySafetySnapshot
}

/** Discriminated union of all intents the planner can process; dispatch via `planIntent`. */
export type PlannerIntent =
  | PropertyEditIntent
  | BodyEditIntent
  | SchemaMigrationIntent
  | DataSourceMetadataEditIntent
  | DatabaseMetadataEditIntent
  | RowCreateIntent
  | LocalDeleteIntent
  | PathClaimIntent
  | QueryAbsenceIntent
  | BodyAdapterResultIntent

const diagnostic = ({
  summary,
  evidence = {},
}: {
  readonly summary: string
  readonly evidence?: Record<string, string>
}): SafeDiagnostic => ({
  _tag: 'SafeDiagnostic',
  summary,
  evidence,
})

const blockDecision = ({
  guard,
  surface,
  summary,
  evidence = {},
}: {
  readonly guard: GuardName
  readonly surface: SurfaceKey
  readonly summary: string
  readonly evidence?: Record<string, string>
}): PlanDecision => ({
  _tag: 'BlockedByGuard',
  guard,
  surface,
  detail: diagnostic({ summary, evidence }),
})

const fromGuard = ({
  decision,
  surface,
}: {
  readonly decision: GuardDecision
  readonly surface: SurfaceKey
}): PlanDecision | undefined =>
  decision._tag === 'blocked'
    ? blockDecision({ guard: decision.guard, surface, summary: decision.message })
    : undefined

const findSchemaProperty = ({
  snapshot,
  dataSourceId,
  propertyId,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly dataSourceId: DataSourceId
  readonly propertyId: PropertyId
}): SchemaPropertySurface | undefined =>
  snapshot.schema.find(
    (property) => property.dataSourceId === dataSourceId && property.propertyId === propertyId,
  )

const findMetadataSurface = ({
  snapshot,
  dataSourceId,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly dataSourceId: DataSourceId
}): DataSourceMetadataSurface | undefined =>
  snapshot.metadata.find((metadata) => metadata.dataSourceId === dataSourceId)

const findDatabaseMetadataSurface = ({
  snapshot,
  databaseId,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly databaseId: DatabaseId
}): DatabaseMetadataSurface | undefined =>
  snapshot.databaseMetadata.find((metadata) => metadata.databaseId === databaseId)

const findPropertySurface = ({
  snapshot,
  pageId,
  propertyId,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly pageId: PageId
  readonly propertyId: PropertyId
}): PropertySurfaceSnapshot | undefined =>
  snapshot.properties.find(
    (property) => property.pageId === pageId && property.propertyId === propertyId,
  )

const findBodySurface = ({
  snapshot,
  pageId,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly pageId: PageId
}): BodyPointerSurfaceSnapshot | undefined => snapshot.bodies.find((body) => body.pageId === pageId)

const findRowSurface = ({
  snapshot,
  pageId,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly pageId: PageId
}): RowSurfaceSnapshot | undefined => snapshot.rows.find((row) => row.pageId === pageId)

const findQuerySurface = ({
  snapshot,
  dataSourceId,
  pageId,
  queryContractHash,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly dataSourceId: DataSourceId
  readonly pageId: PageId
  readonly queryContractHash: Hash
}): QueryCheckpointSurfaceSnapshot | undefined =>
  snapshot.queries.find(
    (query) =>
      query.dataSourceId === dataSourceId &&
      query.pageId === pageId &&
      query.queryContractHash === queryContractHash,
  )

const firstBlocked = ({
  surface,
  guards,
}: {
  readonly surface: SurfaceKey
  readonly guards: ReadonlyArray<GuardDecision>
}): PlanDecision | undefined => {
  for (const guard of guards) {
    const blockedDecision = fromGuard({ decision: guard, surface })
    if (blockedDecision !== undefined) {
      return blockedDecision
    }
  }

  return undefined
}

const commandEnvelope = ({
  snapshot,
  intent,
  command,
  baseHash,
  desiredHash,
  preflight,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly intent: Extract<
    PlannerIntent,
    | PropertyEditIntent
    | BodyEditIntent
    | SchemaMigrationIntent
    | DataSourceMetadataEditIntent
    | DatabaseMetadataEditIntent
    | RowCreateIntent
    | LocalDeleteIntent
  >
  readonly command: RemoteWriteCommand
  readonly baseHash: Hash
  readonly desiredHash: Hash
  readonly preflight: ReadonlyArray<GuardName>
}): OutboxCommandEnvelope => ({
  commandId: command.commandId,
  commandKey: intent.commandKey,
  rootId: snapshot.rootId,
  intentEventId: intent.intentEventId,
  surface: intent.surface,
  command,
  baseHash,
  desiredHash,
  preflight,
})

const matchingRemoteConflict = ({
  intentSurface,
  snapshot,
}: {
  readonly intentSurface: ConflictSurface
  readonly snapshot: PlannerProjectionSnapshot
}): ConflictPayload | undefined => {
  for (const remoteChange of snapshot.remoteChanges) {
    const classification = classifyConflict({ local: intentSurface, remote: remoteChange })
    if (classification._tag === 'conflict') {
      return classification.conflict
    }
  }

  return undefined
}

const planPropertyEdit = ({
  snapshot,
  intent,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly intent: PropertyEditIntent
}): PlanDecision => {
  const row = findRowSurface({ snapshot, pageId: intent.pageId })
  if (row === undefined) {
    return blockDecision({
      guard: 'CurrentSurfaceMissing',
      surface: intent.surface,
      summary:
        'Current row projection is missing; observe the row before planning a property write',
    })
  }

  const schemaProperty = findSchemaProperty({
    snapshot,
    dataSourceId: row.dataSourceId,
    propertyId: intent.propertyId,
  })
  const propertySurface = findPropertySurface({
    snapshot,
    pageId: intent.pageId,
    propertyId: intent.propertyId,
  })

  const baseGuards: GuardDecision[] = [
    guardApiCompatibility(snapshot.api),
    guardCapabilityPreflight(snapshot.capabilities),
  ]

  if (schemaProperty === undefined) {
    return blockDecision({
      guard: 'CurrentSurfaceMissing',
      surface: intent.surface,
      summary:
        'Current schema property projection is missing; observe the data source schema before planning a property write',
      evidence: {
        dataSourceId: row.dataSourceId,
        propertyId: intent.propertyId,
      },
    })
  }

  if (propertySurface === undefined) {
    return blockDecision({
      guard: 'CurrentSurfaceMissing',
      surface: intent.surface,
      summary:
        'Current property projection is missing; observe the property before planning a write',
    })
  }

  /*
   * A `remote`-authority page is Notion-authoritative: a local property mutation
   * against it is drift. Refuse it as `RemoteAuthoritativeDrift` BEFORE building a
   * proof, so no `remote`-mode proof ever reaches the pure core.
   */
  if (propertySurface.writeMode === 'remote') {
    return blockDecision({
      guard: 'RemoteAuthoritativeDrift',
      surface: intent.surface,
      summary:
        'Refusing local property write: page is remote-authoritative; a local mutation would be drift',
    })
  }

  /*
   * Route the property-write safety invariants (write class, config-drift intent
   * safety, base completeness, relation availability, local convergence,
   * settlement) through the shared PropertyWriteCore via the workspace proof
   * provider, instead of calling the legacy inline guards. The provider projects
   * the already-observed schema and property surfaces into a proof; the core's
   * decision is structurally a `GuardDecision`, so it is pushed straight into
   * `baseGuards` and evaluated by `firstBlocked` below in the same order the
   * inline guards used to run.
   *
   * `expectedSchemaHash` is deliberately omitted (the planner carries no authored
   * whole-schema oracle, only the observed `schemaHash`), so the core's
   * StaleRemoteSchema check honestly skips — preserving the legacy behavior, which
   * never enforced whole-schema staleness here. `mode`/`localConvergence`/
   * `settlement` default to the non-blocking verdicts when the surface omits them,
   * so an ordinary shared-mode write produces no new block.
   */
  const { proof, desiredWrite } = makeWorkspaceProof({
    dataSourceId: row.dataSourceId,
    propertyId: intent.propertyId,
    desiredValue: intent.command.propertyPatch[intent.propertyId] ?? { _tag: 'empty' },
    writeClass: schemaProperty.writeClass,
    observedSchemaHash: schemaProperty.schemaHash,
    observedConfigHash: schemaProperty.configHash,
    expectedConfigHash: intent.expectedPropertyConfigHash,
    availability: propertySurface.availability,
    ...(schemaProperty.remoteSchemaObserved !== undefined
      ? { remoteSchemaObserved: schemaProperty.remoteSchemaObserved }
      : {}),
    ...(schemaProperty.displayNameUnambiguous !== undefined
      ? { displayNameUnambiguous: schemaProperty.displayNameUnambiguous }
      : {}),
    ...(schemaProperty.expectedSchemaHash !== undefined
      ? { expectedSchemaHash: schemaProperty.expectedSchemaHash }
      : {}),
    ...(propertySurface.writeMode !== undefined ? { mode: propertySurface.writeMode } : {}),
    ...(propertySurface.localConvergence !== undefined
      ? { localConvergence: propertySurface.localConvergence }
      : {}),
    ...(propertySurface.settlement !== undefined ? { settlement: propertySurface.settlement } : {}),
  })
  baseGuards.push(evaluatePropertyWrite(proof, desiredWrite))

  /*
   * Fail closed on a `files` write that would store a Notion-hosted signed/expiring
   * URL as durable identity (proposed decision 0016 part 2). The property-write core
   * allows a `files` value into a `files` column (tag-fit is a no-op), so the
   * `ExpiringFileUrl` guard is dispatched HERE from the desired file references; an
   * external durable `externalUrl` proceeds. `firstBlocked` surfaces it in order.
   */
  baseGuards.push(evaluateDesiredFileReferences(desiredWrite.value))

  if (propertySurface.remoteHash !== intent.baseHash) {
    if (
      propertySurface.availability === 'complete' &&
      propertySurface.pendingLocal?.targetHash === intent.desiredHash &&
      propertySurface.remoteHash === intent.desiredHash
    ) {
      return { _tag: 'AppendEvents', events: [] }
    }
    const localSurface: ConflictSurface = {
      _tag: 'property',
      pageId: intent.pageId,
      propertyId: intent.propertyId,
      baseHash: intent.baseHash,
      nextHash: intent.desiredHash,
      surface: intent.surface,
    }
    const remoteSurface: ConflictSurface = {
      _tag: 'property',
      pageId: intent.pageId,
      propertyId: intent.propertyId,
      baseHash: propertySurface.baseHash,
      nextHash: propertySurface.remoteHash,
      surface: intent.surface,
    }
    const classification = classifyConflict({ local: localSurface, remote: remoteSurface })
    return classification._tag === 'conflict'
      ? { _tag: 'OpenConflict', conflict: classification.conflict }
      : blockDecision({
          guard: 'StaleSurfaceBase',
          surface: intent.surface,
          summary: 'Local intent base hash is stale for the current surface',
        })
  }

  const blockedDecision = firstBlocked({ surface: intent.surface, guards: baseGuards })
  if (blockedDecision !== undefined) {
    return blockedDecision
  }

  const localSurface: ConflictSurface = {
    _tag: 'property',
    pageId: intent.pageId,
    propertyId: intent.propertyId,
    baseHash: intent.baseHash,
    nextHash: intent.desiredHash,
    surface: intent.surface,
  }
  const conflict = matchingRemoteConflict({ intentSurface: localSurface, snapshot })
  if (conflict !== undefined) {
    return { _tag: 'OpenConflict', conflict }
  }

  return {
    _tag: 'EnqueueCommands',
    commands: [
      commandEnvelope({
        snapshot,
        intent,
        command: intent.command,
        baseHash: intent.baseHash,
        desiredHash: intent.desiredHash,
        preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase', 'SchemaDriftAffectsIntent'],
      }),
    ],
  }
}

const planBodyEdit = ({
  snapshot,
  intent,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly intent: BodyEditIntent
}): PlanDecision => {
  const bodySurface = findBodySurface({ snapshot, pageId: intent.pageId })
  if (bodySurface === undefined) {
    return blockDecision({
      guard: 'CurrentSurfaceMissing',
      surface: intent.surface,
      summary: 'Current body projection is missing; observe the body before planning a write',
    })
  }

  const bodyGuard = bodySurface === undefined ? undefined : guardBodySafety(bodySurface.safety)
  const blockedDecision = firstBlocked({
    surface: intent.surface,
    guards: [
      guardApiCompatibility(snapshot.api),
      guardCapabilityPreflight(snapshot.capabilities),
      ...(bodyGuard === undefined ? [] : [bodyGuard]),
      ...(bodySurface === undefined
        ? []
        : [
            guardStaleSurfaceBase({
              baseHash: intent.baseHash,
              currentHash: bodySurface.currentHash,
            }),
          ]),
    ],
  })
  if (blockedDecision !== undefined) {
    return blockedDecision
  }

  const localSurface: ConflictSurface = {
    _tag: 'body',
    pageId: intent.pageId,
    baseHash: intent.baseHash,
    nextHash: intent.desiredHash,
    lossy: false,
    surface: intent.surface,
  }
  const conflict = matchingRemoteConflict({ intentSurface: localSurface, snapshot })
  if (conflict !== undefined) {
    return { _tag: 'OpenConflict', conflict }
  }

  return {
    _tag: 'EnqueueCommands',
    commands: [
      commandEnvelope({
        snapshot,
        intent,
        command: intent.command,
        baseHash: intent.baseHash,
        desiredHash: intent.desiredHash,
        preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase', 'BodyAdapterConflict'],
      }),
    ],
  }
}

const planSchemaMigration = ({
  snapshot,
  intent,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly intent: SchemaMigrationIntent
}): PlanDecision => {
  const blockedDecision = firstBlocked({
    surface: intent.surface,
    guards: [
      guardApiCompatibility(snapshot.api),
      guardCapabilityPreflight(snapshot.capabilities),
      guardSchemaIntentSafety(intent.safety),
    ],
  })
  if (blockedDecision !== undefined) {
    return blockedDecision
  }

  const localSurface: ConflictSurface = {
    _tag: 'schema',
    affectedPropertyIds: intent.affectedPropertyIds,
    surface: intent.surface,
  }
  const conflict = matchingRemoteConflict({ intentSurface: localSurface, snapshot })
  if (conflict !== undefined) {
    return { _tag: 'OpenConflict', conflict }
  }

  return {
    _tag: 'EnqueueCommands',
    commands: [
      commandEnvelope({
        snapshot,
        intent,
        command: intent.command,
        baseHash: intent.baseHash,
        desiredHash: intent.desiredHash,
        preflight: [
          'CapabilityPreflightFailed',
          'StaleSurfaceBase',
          'DestructiveSchemaMigrationRequired',
          'OptionDeletionLosesValues',
        ],
      }),
    ],
  }
}

const planDataSourceMetadataEdit = ({
  snapshot,
  intent,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly intent: DataSourceMetadataEditIntent
}): PlanDecision => {
  const metadata = findMetadataSurface({ snapshot, dataSourceId: intent.dataSourceId })
  if (metadata === undefined) {
    return blockDecision({
      guard: 'CurrentSurfaceMissing',
      surface: intent.surface,
      summary:
        'Current data-source metadata projection is missing; observe the data source before planning a metadata write',
    })
  }

  const blockedDecision = firstBlocked({
    surface: intent.surface,
    guards: [
      guardApiCompatibility(snapshot.api),
      guardCapabilityPreflight(snapshot.capabilities),
      guardStaleSurfaceBase({
        baseHash: intent.baseHash,
        currentHash: metadata.metadataHash,
      }),
    ],
  })
  if (blockedDecision !== undefined) {
    return blockedDecision
  }

  return {
    _tag: 'EnqueueCommands',
    commands: [
      commandEnvelope({
        snapshot,
        intent,
        command: intent.command,
        baseHash: intent.baseHash,
        desiredHash: intent.desiredHash,
        preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase'],
      }),
    ],
  }
}

const planDatabaseMetadataEdit = ({
  snapshot,
  intent,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly intent: DatabaseMetadataEditIntent
}): PlanDecision => {
  const metadata = findDatabaseMetadataSurface({ snapshot, databaseId: intent.databaseId })
  if (metadata === undefined) {
    return blockDecision({
      guard: 'CurrentSurfaceMissing',
      surface: intent.surface,
      summary:
        'Current database metadata projection is missing; observe the owning database before planning a metadata write',
    })
  }

  const blockedDecision = firstBlocked({
    surface: intent.surface,
    guards: [
      guardApiCompatibility(snapshot.api),
      guardCapabilityPreflight(snapshot.capabilities),
      guardStaleSurfaceBase({
        baseHash: intent.baseHash,
        currentHash: metadata.metadataHash,
      }),
    ],
  })
  if (blockedDecision !== undefined) {
    return blockedDecision
  }

  return {
    _tag: 'EnqueueCommands',
    commands: [
      commandEnvelope({
        snapshot,
        intent,
        command: intent.command,
        baseHash: intent.baseHash,
        desiredHash: intent.desiredHash,
        preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase'],
      }),
    ],
  }
}

const planLocalDelete = ({
  snapshot,
  intent,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly intent: LocalDeleteIntent
}): PlanDecision => {
  const row = findRowSurface({ snapshot, pageId: intent.pageId })
  const body = findBodySurface({ snapshot, pageId: intent.pageId })
  const workspace = snapshot.localWorkspace.find((surface) => surface.pageId === intent.pageId)

  if (
    workspace?.materializationId !== undefined &&
    body?.ownWriteMaterializationIds.includes(workspace.materializationId) === true
  ) {
    return blockDecision({
      guard: 'OwnMaterializationWriteSuppressed',
      surface: intent.surface,
      summary: 'Local delete observation came from this sync materialization',
    })
  }

  if (workspace?.branchLikeMassDeletion === true) {
    return {
      _tag: 'AppendEvents',
      events: [
        {
          _tag: 'LocalDeleteCandidateAccepted',
          pageId: intent.pageId,
          surface: intent.surface,
          reason: 'workspace-repair-candidate',
        },
      ],
    }
  }

  if (intent.command._tag === 'TrashPageCommand') {
    const blockedTombstone = fromGuard({
      decision: guardTombstoneSafety({
        deleteVsEdit: snapshot.remoteChanges.some(
          (change) =>
            change._tag !== 'delete' && 'pageId' in change && change.pageId === intent.pageId,
        ),
        moveOutNotDelete: row?.movedOut === true,
        permissionAmbiguous: snapshot.tombstones.some(
          (tombstone) =>
            tombstone.pageId === intent.pageId &&
            tombstone.directRetrieve === 'permission-ambiguous',
        ),
      }),
      surface: intent.surface,
    })
    if (blockedTombstone !== undefined) {
      return blockedTombstone
    }
  }

  // A restore must be guarded symmetrically with a trash: restoring a page that
  // moved out of the tracked source (rather than being genuinely trashed) is not a
  // legitimate restore and is blocked as `MoveOutNotDelete`. A genuinely-trashed
  // page (reason `remote_trash`) carries no `movedOut` flag, so it proceeds. The
  // delete-vs-edit / permission-ambiguous arms do not apply to a restore: the row
  // is not currently in the query window, so it carries no concurrent remote
  // edit, and permission ambiguity is a trash-classification concern.
  if (intent.command._tag === 'RestorePageCommand' && row?.movedOut === true) {
    return blockDecision({
      guard: 'MoveOutNotDelete',
      surface: intent.surface,
      summary: 'Moved-out page is not a restorable trash',
    })
  }

  if (
    intent.command._tag === 'TrashPageCommand' &&
    (intent.explicitDestructiveIntent === false ||
      intent.policy === 'candidateOnly' ||
      (body?.sidecarIdentityProven !== true && intent.directRetrieve !== 'accessible'))
  ) {
    return {
      _tag: 'AppendEvents',
      events: [
        {
          _tag: 'LocalDeleteCandidateAccepted',
          pageId: intent.pageId,
          surface: intent.surface,
          reason: 'filesystem-delete-candidate',
        },
      ],
    }
  }

  if (row === undefined) {
    return blockDecision({
      guard: 'CurrentSurfaceMissing',
      surface: intent.surface,
      summary: 'Current row projection is missing; observe the row before planning remote trash',
    })
  }

  const blockedDecision = firstBlocked({
    surface: intent.surface,
    guards: [
      guardApiCompatibility(snapshot.api),
      guardCapabilityPreflight(snapshot.capabilities),
      guardStaleSurfaceBase({
        baseHash: intent.baseHash,
        currentHash: row.propertiesHash,
      }),
    ],
  })
  if (blockedDecision !== undefined) {
    return blockedDecision
  }

  return {
    _tag: 'EnqueueCommands',
    commands: [
      commandEnvelope({
        snapshot,
        intent,
        command: intent.command,
        baseHash: intent.baseHash,
        desiredHash: intent.desiredHash,
        preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase', 'DeleteVsEdit'],
      }),
    ],
  }
}

const planPathClaim = ({
  snapshot,
  intent,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly intent: PathClaimIntent
}): PlanDecision => {
  const existingClaim = snapshot.pathClaims.find(
    (claim) => claim.path === intent.path && claim.released === false,
  )
  const collides = existingClaim !== undefined && existingClaim.ownerPageId !== intent.pageId
  const blockedDecision = fromGuard({
    decision: guardPathClaimCollision({ collides }),
    surface: intent.surface,
  })
  if (blockedDecision !== undefined) {
    const localSurface: ConflictSurface = {
      _tag: 'path',
      path: intent.path,
      pageId: intent.pageId,
      existingPageId: existingClaim?.ownerPageId,
      surface: intent.surface,
    }
    const remoteSurface: ConflictSurface = {
      _tag: 'path',
      path: intent.path,
      pageId: intent.pageId,
      existingPageId: existingClaim?.ownerPageId,
      surface: intent.surface,
    }
    const classification = classifyConflict({ local: localSurface, remote: remoteSurface })
    return classification._tag === 'conflict'
      ? { _tag: 'OpenConflict', conflict: classification.conflict }
      : blockedDecision
  }

  return {
    _tag: 'AppendEvents',
    events: [
      {
        _tag: 'PathClaimAccepted',
        pageId: intent.pageId,
        surface: intent.surface,
        path: intent.path,
      },
    ],
  }
}

const planRowCreate = ({
  snapshot,
  intent,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly intent: RowCreateIntent
}): PlanDecision => {
  const currentDataSource = snapshot.schema.find(
    (property) => property.dataSourceId === intent.dataSourceId,
  )
  if (currentDataSource === undefined) {
    return blockDecision({
      guard: 'CurrentSurfaceMissing',
      surface: intent.surface,
      summary:
        'Current data-source schema projection is missing; observe the schema before creating a row',
    })
  }

  const blockedDecision = firstBlocked({
    surface: intent.surface,
    guards: [
      guardApiCompatibility(snapshot.api),
      guardCapabilityPreflight(snapshot.capabilities),
      guardStaleSurfaceBase({
        baseHash: intent.baseHash,
        currentHash: currentDataSource.schemaHash,
      }),
    ],
  })
  if (blockedDecision !== undefined) return blockedDecision

  return {
    _tag: 'EnqueueCommands',
    commands: [
      commandEnvelope({
        snapshot,
        intent,
        command: intent.command,
        baseHash: intent.baseHash,
        desiredHash: intent.desiredHash,
        preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase'],
      }),
    ],
  }
}

const planQueryAbsence = ({
  snapshot,
  intent,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly intent: QueryAbsenceIntent
}): PlanDecision => {
  const query = findQuerySurface({
    snapshot,
    dataSourceId: intent.dataSourceId,
    pageId: intent.pageId,
    queryContractHash: intent.queryContractHash,
  })
  if (query === undefined) {
    return blockDecision({
      guard: 'QueryAbsenceUnclassified',
      surface: intent.surface,
      summary: 'No query checkpoint exists for absence classification',
    })
  }

  const blockedDecision = firstBlocked({
    surface: intent.surface,
    guards: [guardQueryCompleteness(query.completeness), guardQueryAbsence(query.absence)],
  })
  if (blockedDecision !== undefined) {
    return blockedDecision
  }

  switch (query.absence.directRetrieve) {
    case 'accessible':
      return { _tag: 'AppendEvents', events: [] }
    case 'in-trash':
      return {
        _tag: 'AppendEvents',
        events: [
          {
            _tag: 'TombstoneClassified',
            pageId: intent.pageId,
            surface: intent.surface,
            reason: 'remote-trash',
          },
        ],
      }
    case 'moved-out':
      return {
        _tag: 'AppendEvents',
        events: [
          {
            _tag: 'TombstoneClassified',
            pageId: intent.pageId,
            surface: intent.surface,
            reason: 'moved-out',
          },
        ],
      }
    case 'inaccessible':
      return {
        _tag: 'AppendEvents',
        events: [
          {
            _tag: 'TombstoneClassified',
            pageId: intent.pageId,
            surface: intent.surface,
            reason: 'inaccessible',
          },
        ],
      }
    case 'unknown':
      return {
        _tag: 'AppendEvents',
        events: [
          {
            _tag: 'TombstoneClassified',
            pageId: intent.pageId,
            surface: intent.surface,
            reason: 'unknown',
          },
        ],
      }
    case 'not-run':
    case 'permission-ambiguous':
      return blockDecision({
        guard: 'QueryAbsenceUnclassified',
        surface: intent.surface,
        summary: 'Query absence must be directly classified before recording a tombstone candidate',
      })
  }
}

const planBodyAdapterResult = (intent: BodyAdapterResultIntent): PlanDecision => {
  const guard = guardBodySafety(intent.safety)
  const blockedDecision = fromGuard({ decision: guard, surface: intent.surface })
  if (blockedDecision !== undefined) {
    return blockedDecision
  }

  return {
    _tag: 'AppendEvents',
    events: [],
  }
}

/** Dispatch a `PlannerIntent` against the current projection snapshot and return the appropriate `PlanDecision`. Pure function — no side effects; all store mutations are the caller's responsibility. */
export const planIntent = ({
  snapshot,
  intent,
}: {
  readonly snapshot: PlannerProjectionSnapshot
  readonly intent: PlannerIntent
}): PlanDecision => {
  switch (intent._tag) {
    case 'property-edit':
      return planPropertyEdit({ snapshot, intent })
    case 'body-edit':
      return planBodyEdit({ snapshot, intent })
    case 'schema-migration':
      return planSchemaMigration({ snapshot, intent })
    case 'data-source-metadata-edit':
      return planDataSourceMetadataEdit({ snapshot, intent })
    case 'database-metadata-edit':
      return planDatabaseMetadataEdit({ snapshot, intent })
    case 'row-create':
      return planRowCreate({ snapshot, intent })
    case 'local-delete':
      return planLocalDelete({ snapshot, intent })
    case 'path-claim':
      return planPathClaim({ snapshot, intent })
    case 'query-absence':
      return planQueryAbsence({ snapshot, intent })
    case 'body-adapter-result':
      return planBodyAdapterResult(intent)
  }
}

/** Construct a `BlockedByGuard` `PlanDecision` directly — useful for callers outside the planner that need to synthesise a guard block (e.g. user-command paths). */
export const blockedByGuard = ({
  guard,
  surface,
  summary,
}: {
  readonly guard: GuardName
  readonly surface: SurfaceKey
  readonly summary: string
}): PlanDecision => blockDecision({ guard, surface, summary })
