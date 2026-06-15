/**
 * Local-surface convergence engine (Phase 4, SM5).
 *
 * A workspace tracked in `shared` authority mode exposes ONE logical local truth
 * per surface (R06) through two physical surfaces: the SQLite `pages` data file
 * (`data/v1/<source>.sqlite`) and the per-page `.nmd` artifacts
 * (`pages/v1/<source>/*.nmd`). A user may edit either. Before the planner builds
 * any remote write intent, the two surfaces must be reconciled into a single
 * local truth, so a divergence between them is caught HERE and never papered over
 * by a remote mutation.
 *
 * This module is the pure reconciliation core. Given:
 *
 * - the drained SQLite data-file edits ({@link DataFileLocalEdit}), the CDC inbox
 *   the planner already consumes via `readPendingReplicaChanges`, projected to
 *   their stable identity + desired-state hash, and
 * - the decoded `.nmd` desired facts ({@link NmdDesiredFact}) scanned from the
 *   page directory (decoded by the caller via the notion-md `.nmd` envelope —
 *   this engine never reads the filesystem),
 *
 * it groups both surfaces by a stable {@link LocalIdentity} and, per identity,
 * returns one {@link ConvergenceOutcome}:
 *
 * - both surfaces present and AGREE (same desired hash) → `coalesced`: a single
 *   local intent, deduplicated so the remote planner sees one edit, not two.
 * - both surfaces present and DIVERGE → `local-conflict`: the engine RETURNS a
 *   {@link ConflictPayload} for the caller to raise into the read-only `conflicts`
 *   surface (via the normal `ConflictRaised` event → `_nds_replica_conflicts`
 *   projection — NEVER a page-adjacent `*.conflict.*` file, per decision 0005),
 *   and reports the identity as BLOCKED from remote mutation. This engine emits
 *   no events itself; routing the payload onto the conflict rail is the caller's
 *   job (production wiring pending — see the `applyConvergenceVerdicts` note).
 * - exactly ONE surface present → `single-surface`: that surface's intent.
 *
 * Identity is content-stable, never path- or title-derived (R06):
 *
 * - page lifecycle → `(pageId, lifecycle)` keyed by the Notion `page_id`.
 * - property → `(pageId, propertyId)` keyed by the stable `property_id`.
 * - body → `(pageId, body)` keyed by the rendered body digest (`renderedBodyDigest`).
 *
 * Only the PROPERTY identity has a `localConvergence` verdict on the
 * property-write proof: a property divergence sets
 * `PropertySurfaceSnapshot.localConvergence = 'disagrees'`, which the shared
 * PropertyWriteCore surfaces as `LocalSurfaceDisagreement`. Body and lifecycle
 * divergences have no proof field — they surface ONLY as conflicts.
 *
 * Convergence runs in `shared` mode ONLY. In `local`/`remote` mode a single
 * source mirrors the other, so there is nothing to converge and the verdict is
 * `not-applicable` (see {@link convergeLocalSurfaces}).
 *
 * @module
 */

import { bodySurfaceKey, pageSurfaceKey, propertySurfaceKey } from '../core/canonical.ts'
import type { ConflictPayload } from '../core/conflicts.ts'
import { classifyConflict } from '../core/conflicts.ts'
import type { Hash, PageId, PropertyId } from '../core/domain.ts'

/**
 * Stable, content-addressed identity for one logical local surface. Never
 * path- or title-derived (R06): a page is its Notion `page_id`, a property its
 * stable `property_id`, a body its rendered digest, a lifecycle its `page_id`.
 */
export type LocalIdentity =
  | { readonly kind: 'property'; readonly pageId: PageId; readonly propertyId: PropertyId }
  | { readonly kind: 'body'; readonly pageId: PageId }
  | { readonly kind: 'lifecycle'; readonly pageId: PageId }

/** Lifecycle transition expressed by a local edit. */
export type LifecycleAction = 'create' | 'trash' | 'restore'

/**
 * One drained SQLite data-file edit, projected to its stable identity and the
 * desired-state hash it would converge the surface to. This is the planner-facing
 * shape of a `ReplicaLocalChange` row; the caller derives `desiredHash` from the
 * row's value/body hash so this engine stays free of SQLite decoding.
 */
export type DataFileLocalEdit = {
  readonly identity: LocalIdentity
  /** Hash of the desired state this edit converges the surface to. */
  readonly desiredHash: Hash
  /** Hash of the base state the edit was authored against, when carried. */
  readonly baseHash?: Hash
  /** Lifecycle transition, for `lifecycle` identities. */
  readonly lifecycleAction?: LifecycleAction
}

/**
 * One decoded `.nmd` desired fact, projected to its stable identity and the
 * desired-state hash the `.nmd` artifact asserts. The caller decodes the `.nmd`
 * envelope (frontmatter property values, rendered body digest, lifecycle state);
 * this engine compares hashes only.
 */
export type NmdDesiredFact = {
  readonly identity: LocalIdentity
  readonly desiredHash: Hash
  readonly baseHash?: Hash
  readonly lifecycleAction?: LifecycleAction
}

/** Which physical surface authored a single-surface intent. */
export type ConvergenceSurface = 'sqlite' | 'nmd'

/**
 * Per-identity reconciliation outcome.
 *
 * - `coalesced` — both surfaces agree; emit ONE local intent.
 * - `single-surface` — exactly one surface edited; emit its intent.
 * - `local-conflict` — surfaces diverge; raise a conflict and block the identity
 *   from remote mutation.
 */
export type ConvergenceOutcome =
  | {
      readonly _tag: 'coalesced'
      readonly identity: LocalIdentity
      readonly desiredHash: Hash
      readonly baseHash: Hash | undefined
      readonly lifecycleAction: LifecycleAction | undefined
    }
  | {
      readonly _tag: 'single-surface'
      readonly identity: LocalIdentity
      readonly surface: ConvergenceSurface
      readonly desiredHash: Hash
      readonly baseHash: Hash | undefined
      readonly lifecycleAction: LifecycleAction | undefined
    }
  | {
      readonly _tag: 'local-conflict'
      readonly identity: LocalIdentity
      readonly conflict: ConflictPayload
    }

/**
 * Verdict for one property identity, projected onto
 * `PropertySurfaceSnapshot.localConvergence` so the shared PropertyWriteCore can
 * surface a divergence as `LocalSurfaceDisagreement`. Only `property` identities
 * carry a verdict; `body`/`lifecycle` divergences surface only as conflicts.
 */
export type PropertyConvergenceVerdict = {
  readonly pageId: PageId
  readonly propertyId: PropertyId
  readonly status: 'converged' | 'disagrees'
}

/** Result of reconciling both local surfaces for a `shared`-mode workspace. */
export type LocalConvergenceResult = {
  /** Per-identity outcomes, in a stable, deterministic order. */
  readonly outcomes: ReadonlyArray<ConvergenceOutcome>
  /** Conflicts to raise into the read-only `conflicts` surface. */
  readonly conflicts: ReadonlyArray<ConflictPayload>
  /**
   * Property verdicts to overlay onto the planner's `PropertySurfaceSnapshot`s
   * (see `applyConvergenceVerdicts`). The production push path does not yet build
   * this engine's inputs — `TODO(phase-4-local-convergence)` stays open until it
   * does.
   */
  readonly propertyVerdicts: ReadonlyArray<PropertyConvergenceVerdict>
  /**
   * Identities blocked from remote mutation because their two local surfaces
   * diverge. The caller must not enqueue a remote write for these.
   */
  readonly blockedIdentities: ReadonlyArray<LocalIdentity>
}

const identityKey = (identity: LocalIdentity): string => {
  switch (identity.kind) {
    case 'property':
      return `property:${identity.pageId}:${identity.propertyId}`
    case 'body':
      return `body:${identity.pageId}`
    case 'lifecycle':
      return `lifecycle:${identity.pageId}`
  }
}

const surfaceKeyForIdentity = (identity: LocalIdentity) => {
  switch (identity.kind) {
    case 'property':
      return propertySurfaceKey({ pageId: identity.pageId, propertyId: identity.propertyId })
    case 'body':
      return bodySurfaceKey(identity.pageId)
    case 'lifecycle':
      return pageSurfaceKey(identity.pageId)
  }
}

/**
 * Build the `local` and `remote` {@link import('../core/conflicts.ts').ConflictSurface}s
 * for a divergent identity and classify them. Both inputs are LOCAL surfaces — the
 * SQLite edit is passed as `local`, the `.nmd` fact as `remote` — so the reused
 * `classifyConflict` yields the same-surface conflict kinds (`same-property`,
 * `body-body-delegated`, `delete-vs-edit`) without inventing a parallel
 * classifier.
 */
const conflictFor = ({
  identity,
  sqlite,
  nmd,
}: {
  readonly identity: LocalIdentity
  readonly sqlite: DataFileLocalEdit
  readonly nmd: NmdDesiredFact
}): ConflictPayload => {
  const surface = surfaceKeyForIdentity(identity)

  switch (identity.kind) {
    case 'property': {
      const classification = classifyConflict({
        local: {
          _tag: 'property',
          pageId: identity.pageId,
          propertyId: identity.propertyId,
          baseHash: sqlite.baseHash ?? sqlite.desiredHash,
          nextHash: sqlite.desiredHash,
          surface,
        },
        remote: {
          _tag: 'property',
          pageId: identity.pageId,
          propertyId: identity.propertyId,
          baseHash: nmd.baseHash ?? nmd.desiredHash,
          nextHash: nmd.desiredHash,
          surface,
        },
      })
      return classification._tag === 'conflict'
        ? classification.conflict
        : {
            kind: 'same-property',
            localSurface: surface,
            remoteSurface: surface,
            baseHash: sqlite.baseHash,
            localHash: sqlite.desiredHash,
            remoteHash: nmd.desiredHash,
            message: 'Local SQLite and `.nmd` surfaces disagree on the same property',
          }
    }
    case 'body': {
      const classification = classifyConflict({
        local: {
          _tag: 'body',
          pageId: identity.pageId,
          baseHash: sqlite.baseHash ?? sqlite.desiredHash,
          nextHash: sqlite.desiredHash,
          lossy: false,
          surface,
        },
        remote: {
          _tag: 'body',
          pageId: identity.pageId,
          baseHash: nmd.baseHash ?? nmd.desiredHash,
          nextHash: nmd.desiredHash,
          lossy: false,
          surface,
        },
      })
      return classification._tag === 'conflict'
        ? classification.conflict
        : {
            kind: 'body-body-delegated',
            localSurface: surface,
            remoteSurface: surface,
            baseHash: sqlite.baseHash,
            localHash: sqlite.desiredHash,
            remoteHash: nmd.desiredHash,
            message: 'Local SQLite and `.nmd` surfaces disagree on the page body',
          }
    }
    case 'lifecycle':
      return {
        kind: 'delete-vs-edit',
        localSurface: surface,
        remoteSurface: surface,
        baseHash: sqlite.baseHash,
        localHash: sqlite.desiredHash,
        remoteHash: nmd.desiredHash,
        message: 'Local SQLite and `.nmd` surfaces disagree on the page lifecycle',
      }
  }
}

const indexByIdentity = <TEdit extends { readonly identity: LocalIdentity }>(
  edits: ReadonlyArray<TEdit>,
): ReadonlyMap<string, TEdit> => {
  const map = new Map<string, TEdit>()
  for (const edit of edits) {
    // Last write within a surface wins; a single surface yields one desired
    // state per identity (the data file and the `.nmd` artifact are each
    // self-consistent), so duplicates only arise from the caller batching.
    map.set(identityKey(edit.identity), edit)
  }
  return map
}

/**
 * Reconcile the two local surfaces of a `shared`-mode workspace into one local
 * truth per identity. Pure: no IO, no live handles.
 *
 * Returns `not-applicable` for `local`/`remote` modes: a single source mirrors
 * the other, so there is no second surface to converge. In that case the caller
 * leaves every `PropertySurfaceSnapshot.localConvergence` at its `not-applicable`
 * default (the behavior-preserving single-source mirror).
 */
export const convergeLocalSurfaces = ({
  authorityMode,
  dataFileEdits,
  nmdFacts,
}: {
  readonly authorityMode: 'local' | 'remote' | 'shared'
  readonly dataFileEdits: ReadonlyArray<DataFileLocalEdit>
  readonly nmdFacts: ReadonlyArray<NmdDesiredFact>
}):
  | { readonly _tag: 'not-applicable' }
  | ({ readonly _tag: 'shared' } & LocalConvergenceResult) => {
  if (authorityMode !== 'shared') {
    return { _tag: 'not-applicable' }
  }

  const sqliteByIdentity = indexByIdentity(dataFileEdits)
  const nmdByIdentity = indexByIdentity(nmdFacts)

  // Deterministic union order: SQLite identities first (insertion order), then
  // `.nmd`-only identities, so outcomes are stable across runs.
  const orderedKeys: string[] = []
  const seen = new Set<string>()
  for (const key of sqliteByIdentity.keys()) {
    if (seen.has(key) === false) {
      orderedKeys.push(key)
      seen.add(key)
    }
  }
  for (const key of nmdByIdentity.keys()) {
    if (seen.has(key) === false) {
      orderedKeys.push(key)
      seen.add(key)
    }
  }

  const outcomes: ConvergenceOutcome[] = []
  const conflicts: ConflictPayload[] = []
  const propertyVerdicts: PropertyConvergenceVerdict[] = []
  const blockedIdentities: LocalIdentity[] = []

  for (const key of orderedKeys) {
    const sqlite = sqliteByIdentity.get(key)
    const nmd = nmdByIdentity.get(key)
    const identity = (sqlite ?? nmd)?.identity
    if (identity === undefined) continue

    if (sqlite !== undefined && nmd !== undefined) {
      if (sqlite.desiredHash === nmd.desiredHash) {
        outcomes.push({
          _tag: 'coalesced',
          identity,
          desiredHash: sqlite.desiredHash,
          baseHash: sqlite.baseHash ?? nmd.baseHash,
          lifecycleAction: sqlite.lifecycleAction ?? nmd.lifecycleAction,
        })
        if (identity.kind === 'property') {
          propertyVerdicts.push({
            pageId: identity.pageId,
            propertyId: identity.propertyId,
            status: 'converged',
          })
        }
      } else {
        const conflict = conflictFor({ identity, sqlite, nmd })
        outcomes.push({ _tag: 'local-conflict', identity, conflict })
        conflicts.push(conflict)
        blockedIdentities.push(identity)
        if (identity.kind === 'property') {
          propertyVerdicts.push({
            pageId: identity.pageId,
            propertyId: identity.propertyId,
            status: 'disagrees',
          })
        }
      }
      continue
    }

    const surface: ConvergenceSurface = sqlite !== undefined ? 'sqlite' : 'nmd'
    const edit = sqlite ?? nmd
    if (edit === undefined) continue
    outcomes.push({
      _tag: 'single-surface',
      identity,
      surface,
      desiredHash: edit.desiredHash,
      baseHash: edit.baseHash,
      lifecycleAction: edit.lifecycleAction,
    })
    // No `converged` verdict for a single-surface edit: only one surface asserted
    // a desired state, so there was no second surface to cross-check. `converged`
    // is reserved for the `coalesced` case (both surfaces present and agreeing);
    // emitting it here would falsely assert agreement and — once the engine is
    // wired with an as-yet-empty `.nmd` side — mask every SQLite-only edit as
    // converged. A single-surface identity is left at `not-applicable` (the
    // proof default, also non-blocking) by NOT adding a verdict.
  }

  return { _tag: 'shared', outcomes, conflicts, propertyVerdicts, blockedIdentities }
}

/**
 * Overlay convergence property verdicts onto a planner property-surface list,
 * setting `localConvergence` for each `(pageId, propertyId)` the engine evaluated.
 * Surfaces the engine did not evaluate are left untouched (default
 * `not-applicable`). This is the chokepoint that will close
 * `TODO(phase-4-local-convergence)` once a production push path builds the
 * engine's inputs and overlays its verdicts onto the planner snapshot before
 * `planIntent`: the planner's `PropertySurfaceSnapshot.localConvergence` would
 * then come from the real SQLite-vs-`.nmd` comparison rather than a test-injected
 * literal. Today it is exercised only from tests.
 */
export const applyConvergenceVerdicts = <
  TSurface extends {
    readonly pageId: PageId
    readonly propertyId: PropertyId
    readonly localConvergence?: 'not-applicable' | 'converged' | 'disagrees'
  },
>({
  properties,
  verdicts,
}: {
  readonly properties: ReadonlyArray<TSurface>
  readonly verdicts: ReadonlyArray<PropertyConvergenceVerdict>
}): ReadonlyArray<TSurface> => {
  if (verdicts.length === 0) return properties
  const verdictByKey = new Map<string, PropertyConvergenceVerdict['status']>()
  for (const verdict of verdicts) {
    verdictByKey.set(`${verdict.pageId}:${verdict.propertyId}`, verdict.status)
  }
  return properties.map((property) => {
    const status = verdictByKey.get(`${property.pageId}:${property.propertyId}`)
    return status === undefined ? property : { ...property, localConvergence: status }
  })
}
