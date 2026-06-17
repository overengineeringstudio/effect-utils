# Body is single-surface and adapter-owned

Status: proposed

In `shared` mode the SQLite `pages` property surface flows through the
`convergeLocalSurfaces` engine. An earlier iteration also routed the `.nmd` BODY
surface through that same engine, on the theory that the body should join one
unified convergence mechanism. This record decides that the body surface is
SINGLE-SURFACE and ADAPTER-OWNED, and that routing it through the convergence
engine was a false symmetry.

## Decision

The `.nmd` artifact is the ONLY local body surface. There is no second local body
surface to converge against (the SQLite `body_patch` channel does not exist in
production), so the body never has two disagreeing local surfaces for the engine
to reconcile. Routing the body through `convergeLocalSurfaces` therefore added no
handling the body adapter does not already do — it was dead-weight ceremony plus
a latent stuck-state, not a unification.

The body ADAPTER is authoritative for everything about the body: the
stale-vs-live-remote check, the full safety contract (lossy body, unknown
blocks, would-delete-children, synced-page-unsupported, non-body-mutation), and
`BodyPushCommand` construction. A body conflict is raised by the adapter
(`conflictKind: 'body'`, from `planLocalChange` → `BodyConflict`), never by the
convergence engine.

The convergence engine is for PROPERTIES only. In `shared` mode it reconciles the
SQLite `pages` property edits against the `.nmd` frontmatter and is fed property
facts exclusively; it is never fed a body fact.

## Body conflict resolution

A `body` conflict is reachable in production (a real remote-vs-local body
divergence from `planLocalChange`) and is resolvable through the user-action
command surface. Body carries no engine-owned mergeable value — it is content —
so resolution is NOT a value merge but a re-push (local) / re-materialize
(remote):

- **keep-local**: re-assert the local `.nmd` body by re-enqueueing a
  `BodyPushCommand` against the current body pointer, routed through the planner
  so the normal body-edit guards apply. On settlement the body pointer
  reconverges and the divergence is gone. The conflict moves to `resolved`.
- **keep-remote** (and `manual`): accept the remote body and DISCARD the local
  edit. Emit `ConflictResolved(keep-remote)`; the store `body` apply arm retires
  the conflict and records the re-materialization intent on the body pointer by
  (a) clearing `sidecar_identity_proven` (the local sidecar is no longer trusted)
  AND (b) setting a DEDICATED `keepRemoteBodyResolution` marker in the body
  projection payload. The intent is CONSUMED on the next pull: `pullOneShotSync`
  collects every body pointer carrying the `keepRemoteBodyResolution` marker and
  passes them as `forceMaterializePageIds`, which overrides the mirror path's
  global `materializeBodyArtifacts: false` suppression for exactly those pages.

  A `body` conflict ALWAYS has a dirty local `.nmd` by construction (the conflict
  is only raised when the rendered local body diverges from the observed remote
  body), so re-materializing it requires OVERWRITING a dirty file. keep-remote is
  an EXPLICIT user decision to discard that edit, so the forced materialize
  carries `acceptRemoteOverwrite` on its `MaterializePlan`, which bypasses ONLY
  the workspace's "local edits; repair required" dirty-edit safety throw (the
  structural collision / non-file / no-identity guards still apply). The
  divergence is therefore reset to the remote body rather than the materialize
  failing closed and WEDGING every subsequent pull. This is a DEFERRED remote
  effect (it happens on the next pull), exactly as the lifecycle keep-remote arm
  defers its reconvergence. The marker is cleared automatically once the forced
  materialize lands and the next `RowObserved` rebuilds the projection without it.

  The trigger is the DEDICATED marker, not `sidecarIdentityProven === false`: a
  cleared `sidecarIdentityProven` is the routine state of EVERY page after any
  suppressed (`materializeBodyArtifacts: false`) pull, so triggering on it would
  force-overwrite every dirty `.nmd` on two consecutive suppressed pulls and break
  the dirty-edit-preservation contract for pages that were never keep-remote
  resolved.

This mirrors the lifecycle conflict resolver (decision 0018): a page-keyed,
null-`propertyId` conflict routed to its own resolver before the property-only
refuse block, with a re-push for keep-local and a deterministic projection
reconvergence for keep-remote.

## Considered Options

| Option                                             | Result   | Reason                                                                                                                                                                                                     |
| -------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route the body surface through the engine          | Rejected | False symmetry: `.nmd` is the only local body surface, so the engine always sees a single body fact and adds no handling the adapter does not already do — dead-weight ceremony plus a latent stuck-state. |
| Body is single-surface and adapter-owned           | Selected | One authority for the body (the adapter), no inert engine rail, no stuck-state. The engine stays property-only.                                                                                            |
| Body conflict as an engine value-merge             | Rejected | Body is content, not an engine-mergeable value. There is nothing for the engine to merge.                                                                                                                  |
| Body conflict resolved by re-push / re-materialize | Selected | The principled shape for content: keep-local re-pushes the local body, keep-remote re-materializes from the remote observation. No value merge.                                                            |

## Consequences

- The convergence engine is property-only; it is never fed a body fact and never
  raises a body conflict. The body adapter is the sole body authority.
- A `body` conflict (raised by the adapter) is resolvable via keep-local re-push /
  keep-remote re-materialize. The `ConflictResolved` store apply has a `body` arm
  that retires the conflict and, for keep-remote, records the re-materialization
  intent via the dedicated `keepRemoteBodyResolution` marker and an approved
  `acceptRemoteOverwrite` materialize that overwrites the dirty `.nmd`. The forced
  materialize is scoped to exactly the keep-remote-resolved pages, so a routine
  suppressed pull never clobbers an unresolved dirty page.
- Workspace-port note: the guard-bearing `makeFilesystemLocalWorkspacePort`
  (`assertSafeMaterializeTarget`) honors `acceptRemoteOverwrite`, bypassing ONLY
  the dirty-edit throw for an approved keep-remote overwrite. The live-NotionMD
  materializing port (`materializeBody` → `trackPage`) overwrites a same-page
  `.nmd` unconditionally, so the flag is a benign no-op there. The over-broad
  trigger fix (the dedicated marker) lives in the pull/observation seam, so it
  is port-independent and applies to both wirings.
- The lifecycle conflict machinery (decision 0018) and the property convergence
  engine are untouched by this decision.

This record stays `proposed` until the body conflict resolution path is exercised
end-to-end against a live Notion workspace.
