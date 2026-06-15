/**
 * Datasource-workspace proof provider for property writes.
 *
 * The planner is the *shared* (workspace) entrypoint: it already observed the
 * remote data-source schema, the page property surface, and the local workspace
 * artifact when it built its {@link PlannerProjectionSnapshot}. Unlike the
 * standalone notion-md provider (which re-reads the live remote inside an
 * Effect), this provider is PURE: it projects the already-observed planner
 * surfaces into a {@link PropertyWriteProof} (hashes and verdicts only — never
 * live handles) and hands it, plus the {@link DesiredPropertyWrite}, to the pure
 * `evaluatePropertyWrite` core. The core, not this provider, decides allow/block.
 *
 * Because the planner is the workspace entrypoint, this provider fills the two
 * fields only it can prove:
 *
 * - `localConvergence` — whether the local SQLite `pages` projection agrees with
 *   the materialized `.nmd` artifact. A `disagrees` verdict means the workspace
 *   observed a local-surface divergence the write must not paper over, surfaced
 *   by the core as `LocalSurfaceDisagreement`.
 * - `settlement` — whether the outbox read-after-write settlement context is
 *   present. In `shared` mode a write is only safe once the settlement record is
 *   present; a `missing` settlement is surfaced as `ReadAfterWriteMismatch`.
 *
 * Mode is `shared` (settlement must be `present`) or `local`. A `remote` page is
 * Notion-authoritative: a local property mutation against it is drift, and the
 * planner refuses it as `RemoteAuthoritativeDrift` BEFORE building a proof, so no
 * `remote`-mode proof ever reaches the core.
 *
 * @module
 */

import { isNotionPropertyType } from '@overeng/notion-core'
import {
  type CanonicalPropertyValue,
  ConfigHash,
  type DataSourceId,
  type NotionPropertyType,
  type PropertyId,
  PropertyName,
  SchemaHash,
} from '@overeng/notion-effect-schema'
import type { DesiredPropertyWrite, PropertyWriteProof } from '@overeng/notion-property-write'

import type { Hash } from '../core/domain.ts'
import type { PropertyAvailability, PropertyWriteClass } from '../core/guards.ts'

/**
 * Project a planner {@link PropertyAvailability} onto the proof's
 * {@link PropertyWriteProof.baseCompleteness} and
 * {@link PropertyWriteProof.relationAvailability} surfaces, preserving the exact
 * blocking semantics of the legacy `guardPropertyAvailability`:
 *
 * - `complete`/`computed` → no block (`surfaceComplete: true`, relation `not-applicable`)
 * - `paginated-incomplete` → `surfaceComplete: false` → core check 7 (`PropertyValueIncomplete`)
 * - `relation-target-inaccessible` → relation `targets-unavailable` → core check 8 (`UnavailableRelationTarget`)
 * - `related-data-source-unshared` → relation `related-data-source-unshared` → core check 8 (`RelatedDataSourceUnshared`)
 * - `unsupported` → write class forced to `unsupported` so core check 4 blocks
 *   with `UnsupportedRemoteShape` UNCONDITIONALLY (matching the legacy
 *   `guardPropertyAvailability('unsupported')`, which blocked regardless of value).
 *   This must be value-independent: a clear-to-`empty` desired value is a normal
 *   op, and routing the block through the value tag-fit check (core check 6) would
 *   fail OPEN because `empty` fits any property type.
 */
const availabilityProjection = (
  availability: PropertyAvailability,
): {
  readonly surfaceComplete: boolean
  readonly relationStatus: PropertyWriteProof['relationAvailability']['status']
  readonly forceUnsupportedWriteClass: boolean
} => {
  switch (availability) {
    case 'complete':
    case 'computed':
      return {
        surfaceComplete: true,
        relationStatus: 'not-applicable',
        forceUnsupportedWriteClass: false,
      }
    case 'paginated-incomplete':
      return {
        surfaceComplete: false,
        relationStatus: 'not-applicable',
        forceUnsupportedWriteClass: false,
      }
    case 'relation-target-inaccessible':
      return {
        surfaceComplete: true,
        relationStatus: 'targets-unavailable',
        forceUnsupportedWriteClass: false,
      }
    case 'related-data-source-unshared':
      return {
        surfaceComplete: true,
        relationStatus: 'related-data-source-unshared',
        forceUnsupportedWriteClass: false,
      }
    case 'unsupported':
      return {
        surfaceComplete: true,
        relationStatus: 'not-applicable',
        forceUnsupportedWriteClass: true,
      }
  }
}

/**
 * Inputs the planner has already resolved from its projection snapshot for one
 * datasource-scoped property write.
 *
 * `mode`, `localConvergence`, and `settlement` are the workspace-only signals
 * the planner derives from observed workspace state; they default to the
 * non-blocking verdicts so an ordinary shared-mode write with a settled outbox
 * and a converged local surface produces no new block.
 *
 * Production wiring: `writeMode` is populated from the manifest authority mode
 * (`withAuthorityMode`), so `RemoteAuthoritativeDrift` fires from real production
 * state. `localConvergence` is populated from the Phase 4 shared-mode local
 * convergence (`buildPropertyConvergenceInputs` + `convergeLocalSurfaces` +
 * `applyConvergenceVerdicts` in the CLI push path) and is ACTIVE on real data
 * (SM5d): pulls materialize the writable frontmatter properties into the `.nmd`, so
 * `LocalSurfaceDisagreement` fires on a genuine pulled-page divergence. `settlement`
 * remains WIRED-BUT-DORMANT — the outbox does not yet supply a real read-after-write
 * verdict, so it falls back to its non-blocking default and `ReadAfterWriteMismatch`
 * fires only from tests (`TODO(settlement-wiring)`).
 */
export interface WorkspaceProofInputs {
  readonly dataSourceId: DataSourceId
  readonly propertyId: PropertyId
  /** The desired canonical value, read from the patch command for this property. */
  readonly desiredValue: CanonicalPropertyValue
  /** Write class of the target column, from the observed remote schema surface. */
  readonly writeClass: PropertyWriteClass
  /** Whole-schema identity hash observed for the data source, when carried. */
  readonly observedSchemaHash: Hash
  /** The authored whole-schema identity hash to compare against, when carried. */
  readonly expectedSchemaHash?: Hash
  /** Per-property config identity observed on the remote schema surface. */
  readonly observedConfigHash: Hash
  /** The authored per-property config identity the intent expects. */
  readonly expectedConfigHash: Hash
  /** Observed availability of the page property value surface. */
  readonly availability: PropertyAvailability
  /**
   * `false` when the remote schema was not freshly observed for this write;
   * surfaces as `RemoteSchemaRequired`. Defaults to `true`.
   */
  readonly remoteSchemaObserved?: boolean
  /**
   * `false` when the resolved display name maps ambiguously to more than one
   * property on the observed schema. Defaults to `true` (unambiguous).
   */
  readonly displayNameUnambiguous?: boolean
  /** Workspace entrypoint mode; the planner never builds a `remote`-mode proof. */
  readonly mode?: 'local' | 'shared'
  /** Whether the local SQLite/`.nmd` surfaces agree. */
  readonly localConvergence?: PropertyWriteProof['localConvergence']['status']
  /** Read-after-write settlement context for the outbox. */
  readonly settlement?: PropertyWriteProof['settlement']['status']
}

/**
 * Build the `{ proof, desiredWrite }` pair for one datasource-scoped property
 * write from already-observed planner surfaces. Pure: no IO. The proof and the
 * desired write are built for the SAME `(dataSourceId, propertyId)` pair, so a
 * mismatch cannot slip through.
 *
 * The proof's `propertyType` is derived from the desired value's own canonical
 * tag, because the planner schema surface does not yet carry the property's real
 * Notion type. Every writable canonical tag is itself a `NotionPropertyType`, so
 * `tag === propertyType` and the core's tag-fit check (check 6) is a deliberate
 * NO-OP for an ordinary write — matching the legacy planner, which never enforced
 * tag-fit. This is intentional behavior preservation, not real tag-fit validation.
 *
 * TODO(r11-tag-fit): close the R11 tag-fit gap by threading the OBSERVED Notion
 * property type onto `SchemaPropertySurface` (from observation + fixtures) and
 * using it here instead of the value-derived placeholder. That is a separate
 * observation-layer change, out of scope for this routing refactor.
 *
 * The `unsupported`-availability block is routed through `writeClass:
 * 'unsupported'` (core check 4), NOT through a synthesized non-fitting type: core
 * check 4 blocks UNCONDITIONALLY, whereas a value-tag-fit block (check 6) would
 * fail OPEN for a clear-to-`empty` value (`empty` fits any property type). This
 * matches the legacy `guardPropertyAvailability('unsupported')`, which blocked
 * regardless of the desired value.
 */
export const makeWorkspaceProof = (
  inputs: WorkspaceProofInputs,
): { readonly proof: PropertyWriteProof; readonly desiredWrite: DesiredPropertyWrite } => {
  const availability = availabilityProjection(inputs.availability)

  /* See the doc comment: value-derived type → tag-fit is a legacy-preserving no-op (R11 pending). */
  const propertyType: NotionPropertyType =
    isNotionPropertyType(inputs.desiredValue._tag) === true ? inputs.desiredValue._tag : 'rich_text'

  /*
   * `unsupported` availability forces `writeClass: 'unsupported'` so the core
   * blocks unconditionally at check 4, independent of the desired value.
   */
  const writeClass: PropertyWriteClass =
    availability.forceUnsupportedWriteClass === true ? 'unsupported' : inputs.writeClass

  const proof: PropertyWriteProof = {
    mode: inputs.mode ?? 'shared',
    dataSourceId: inputs.dataSourceId,
    identity: {
      propertyId: inputs.propertyId,
      /*
       * The planner snapshot resolves writes by stable `propertyId`, not by
       * display name, so no separate display name is observed here. `resolvedName`
       * carries the `propertyId` as a stable, non-empty placeholder: the core only
       * reads `displayNameUnambiguous`, never `resolvedName`, and the proof is
       * ephemeral (built per-evaluation, never persisted or surfaced).
       */
      resolvedName: PropertyName.make(inputs.propertyId),
      evidenceSource: { _tag: 'workspace_state' },
      displayNameUnambiguous: inputs.displayNameUnambiguous ?? true,
    },
    schemaConsistency: {
      remoteSchemaObserved: inputs.remoteSchemaObserved ?? true,
      observedSchemaHash: SchemaHash.make(inputs.observedSchemaHash),
      ...(inputs.expectedSchemaHash !== undefined
        ? { expectedSchemaHash: SchemaHash.make(inputs.expectedSchemaHash) }
        : {}),
      observedConfigHash: ConfigHash.make(inputs.observedConfigHash),
      expectedConfigHash: ConfigHash.make(inputs.expectedConfigHash),
      propertyType,
      writeClass,
    },
    baseCompleteness: { surfaceComplete: availability.surfaceComplete },
    relationAvailability: { status: availability.relationStatus },
    /*
     * In `shared` mode the Phase 4 local-convergence engine
     * (`planner/local-convergence.ts`) compares the local SQLite `pages` surface
     * against the `.nmd` frontmatter per `(page_id, property_id)` and produces a
     * `converged`/`disagrees` verdict that `applyConvergenceVerdicts` overlays onto
     * `PropertySurfaceSnapshot.localConvergence`; a `disagrees` is surfaced here as
     * `LocalSurfaceDisagreement`. `local`/`remote` mode (and untracked stores) keep
     * the `not-applicable` default (single-source mirror).
     */
    localConvergence: { status: inputs.localConvergence ?? 'not-applicable' },
    /*
     * TODO(settlement-wiring): defaulted to `present` until the outbox supplies a
     * real read-after-write settlement verdict. See the WIRED-BUT-DORMANT note.
     */
    settlement: { status: inputs.settlement ?? 'present' },
  }

  const desiredWrite: DesiredPropertyWrite = {
    propertyId: inputs.propertyId,
    dataSourceId: inputs.dataSourceId,
    value: inputs.desiredValue,
  }

  return { proof, desiredWrite }
}
