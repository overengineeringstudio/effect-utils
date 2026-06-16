# Body convergence: unify the mechanism, keep the adapter authoritative

Status: proposed

In `shared` mode the SQLite `pages` property surface already flows through the
`convergeLocalSurfaces` engine, while the `.nmd` BODY surface still rides a
bespoke channel with its own identity, base, and divergence model (tracked as F1
in decision 0012). This record decides how the body surface joins the
convergence engine without collapsing the body adapter's authority over remote
semantics.

## Decision

Route the `.nmd` BODY surface through the same `convergeLocalSurfaces` engine as
properties, but ONLY for LOCAL divergence detection, and with per-surface block
granularity: a body conflict blocks only the body surface; an unrelated co-page
property write in the same pass still proceeds. There is NO cross-surface
atomicity — the engine does not gate a clean property write behind a body
conflict on the same page.

The body convergence base is the RENDERED body digest — the current `.nmd`
rendered body compared against the rendered digest of the last materialization —
NOT the evidence fingerprint. Local divergence is a pure rendered-surface
question, and the engine's surface key is already a rendered digest; the base
must match that.

The body ADAPTER stays authoritative for everything remote. It keeps the
stale-vs-live-remote check, the full safety contract (lossy body, unknown
blocks, would-delete-children, synced-page-unsupported, non-body-mutation), and
`BodyPushCommand` construction. The engine never reproduces any of these.

## Architectural invariant

The convergence engine NEVER performs remote comparison. Local divergence
(rendered digest, surface key, per-surface blocking) is the engine's job; remote
semantic reconciliation (evidence fingerprint, lossy-round-trip tolerance,
stale-vs-live-remote, the safety contract, push-command construction) is the
adapter's job. This split is the load-bearing constraint and must be guarded in
spec and review: any change that teaches the engine to look at remote state, or
that moves the safety contract into the engine, violates it.

## Conflict raise loop and vocabulary

Today `cli/main.ts` raises only `property` conflicts into
`_nds_replica_conflicts`. Engine-detected body conflicts must actually be
projected. Extend the conflict-raise loop to carry body conflicts, and reconcile
the conflict vocabulary: an engine-detected local body divergence is
`body-body-delegated` (the engine found it, the adapter still owns remote
reconciliation), distinct from a `body` conflict raised by the adapter's own
remote check. Without this the engine can detect a body conflict that never
surfaces to the user.

## Base sub-decision

The convergence base for the body surface is the rendered-body digest, not the
evidence fingerprint. An evidence-fingerprint base would conflate the adapter's
remote-semantic role into the engine and be internally inconsistent with the
engine's rendered-digest surface key; a too-loose fingerprint could also miss a
real local edit. The lossy-round-trip tolerance that motivates the evidence
fingerprint is a REMOTE concern, handled by the adapter, not the engine.
Back-compat is not a factor — there is no production usage of body convergence
yet.

## Considered Options

| Option                                               | Result   | Reason                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page-level cross-surface atomicity                   | Rejected | Needs a page-level transaction boundary across the outbox plus a unified conflict UX; stalls a clean property write behind an unrelated body conflict.                                                                                            |
| Keep body on its bespoke separate channel            | Rejected | Two identity/base models and sidecar-pointer divergence risk; does not unify the mechanism.                                                                                                                                                       |
| Unify mechanism, per-surface blocking                | Selected | One identity/base/hash model; kills the bespoke divergence path; per-surface blocking preserved (validated by experiment).                                                                                                                        |
| Evidence-fingerprint base in the engine (sub-option) | Rejected | Conflates the adapter's remote-semantic role into the engine; internally inconsistent with the engine's rendered-digest surface key; a too-loose fingerprint could miss a real local edit. Back-compat is not a factor (no production usage yet). |
| Rendered-digest base (sub-option)                    | Selected | Matches the engine's actual job (local divergence); self-contained and internally consistent; the lossy-round-trip tolerance that motivates the evidence fingerprint is a REMOTE concern handled by the adapter.                                  |

A validation experiment confirmed the engine cleanly handles the degenerate
single-body-surface input (single-surface outcome, no false conflict) and that
per-surface blocking genuinely holds — a blocked body identity does not block a
co-page property identity in the same pass. The same experiment enumerated that
the engine does NOT reproduce the adapter safety contract, the stale-vs-remote
check, or push-command construction, which is why the adapter-authoritative
constraint is stated as an invariant rather than left implicit.

## Consequences

- The engine emits body LOCAL-DIVERGENCE only; the adapter keeps the safety
  contract, the remote (stale-vs-live) check, and `BodyPushCommand`
  construction.
- The conflict-raise loop in `cli/main.ts` must be extended to project body
  conflicts, and the conflict vocabulary reconciled (`body-body-delegated` for
  engine-detected local divergence vs `body` for the adapter's remote check),
  or engine-detected body conflicts never reach `_nds_replica_conflicts`.
- The rendered-digest body base must be persisted alongside the property bases
  so the engine has a stable local-divergence reference per materialization.
- The architectural invariant — engine never compares remote; adapter owns all
  remote semantics — must be guarded in spec and at review for every change that
  touches the engine or the body adapter.

### Implementation clarifications (forward-looking; the rail is inert in production)

The body convergence rail landed but is dormant: production keeps the SQLite body
channel single-surface, so the engine never sees a second body surface and no
`body-body-delegated` conflict is raised on real data. Two clarifications matter
before a second body surface is wired:

- **The rendered-digest base applies to the ENGINE's local-divergence fact ONLY.**
  The conflict/intent/command bases correctly stay on the EVIDENCE digest, because
  `guardStaleSurfaceBase` compares the desired write against the evidence-space
  projection. Flipping those bases to the rendered digest would make the guard
  compare across two different digest spaces and false-fire `StaleSurfaceBase`. So
  the rendered-digest base from the "Base sub-decision" is scoped to the engine's
  surface key, not to the downstream conflict/intent/command bases.

- **A `body-body-delegated` conflict is currently UNRESOLVABLE through the
  user-action surface.** `conflict-commands.ts` routes only `lifecycle` conflicts
  (pageId, null propertyId) to their own resolver and otherwise REFUSES any
  conflict with a null `propertyId` (`CurrentSurfaceMissing`: "Only same-property
  conflicts can be resolved through this command surface"). A page-keyed,
  null-`propertyId`, non-`lifecycle` `body-body-delegated` conflict therefore falls
  through to that refuse block while still counting as not-clean / blocking
  compaction. This is dormant today (such a conflict is never raised in
  production), but it is a prerequisite to address before a second body surface is
  wired so an engine-detected body divergence has a resolution path.

Both clarifications are forward-looking: they describe the activation path for the
already-built-but-inert rail, not current production behavior. This record stays
`proposed` until the second body surface is wired.
