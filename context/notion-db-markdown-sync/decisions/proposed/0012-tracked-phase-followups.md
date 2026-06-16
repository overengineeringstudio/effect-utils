# Tracked phase follow-ups not closed by PR #775

Status: proposed

Per proposed decision 0007 ("if a scenario is structurally unprovable or a feature
is mechanism-backed but not falsifiably proven, document the gap as a
ratification-gated item — do not silently drop it"), this record catalogs the
follow-ups that PR #775 honestly tracks but does NOT close. Each is durable here
so it survives into ratification rather than living only in scenario comments or
the orchestrator transcript. None of these block the PR's stated scope; they are
the explicit residue at the edges of what landed.

The matrix already encodes most of these as `traceabilityResiduals` or as
`lowestPlannerLevel`/`highestIntegrationLevel` bounds in
`packages/@overeng/notion-datasource-sync/src/testing/scenarios.ts`; this doc is
the prose ledger that makes the gaps reviewable in one place.

## F1 — Body + lifecycle convergence is engine-ready but production emits property facts only (Phase 4)

The local-surface convergence engine is wired and active, but in production only
`property` facts are emitted into it (`buildPropertyConvergenceInputs` produces
the property surface; the body surface is not fed). Body convergence remains
entangled with sidecar identity and the `--no-materialize-bodies` path, so the
`.nmd` body surface is not yet a first-class convergence input alongside the
SQLite `pages` property surface.

What is proven: property-surface convergence end to end (`NDS-L3-local-surface-convergence`).
What is not: body facts flowing through the same convergence space in production.

## F2 — Dry-run objects / `.nmd` surfaces are mechanism-backed but not falsifiably proven (Phase 5, SM5.2)

The `sync --dry-run` suppression guarantee is falsifiably proven for the four core
durable surfaces (the `NDS-L4-dry-run-suppression-all-surfaces` scenario snapshots
each surface and asserts byte/row/count invariance plus a zero gateway-write
counter, with a non-dry control proving non-vacuity). Two further surfaces —
object/attachment storage and bodies-on `.nmd` materialization — are covered by the
same suppression MECHANISM but are not falsifiably proven, because there is no
fixture today that exercises an attachment or a bodies-on materialization under
dry-run. The mechanism gates them; no test makes the gate observable.

## F3 — External-URL attach is structural-only where "proven" (Phase 6, SM6.1)

External-URL file attach is structurally represented today: an `external_url` lives
on the frontmatter `NmdPropertyFileRef` rather than on `storage.files`. The current
coverage is therefore structural — the ref shape carries the URL — but it does not
genuinely drive a media-boundary attach. Genuinely enabling external-URL attach
requires a property-boundary change so the external URL crosses into the media/
storage surface, not just the property frontmatter.

## F4 — `local_file` property-ref boundary is guarded at property encoding, not the media boundary (Phase 6)

The `local_file` property reference is guarded at the `sync.ts` property-encoding
boundary (it fails closed there), NOT at the media boundary. This is a coherent
fail-closed posture for v1, but the guard lives one layer up from where a future
media-attach path would need it. When the media boundary is built out, the guard
should move (or be duplicated) to the media boundary so a `local_file` ref cannot
slip through a future attach path.

## F5 — Settlement-proof production wiring is plumbed but dormant (Phase 3c-ii, `TODO(settlement-wiring)`)

The `shared`-mode settlement proof field is plumbed through the planner's property
proof path but is dormant in production: it currently defaults to `present` and
fires only from tests. The real outbox settlement verdict does not yet populate it
(`TODO(settlement-wiring)`). Until the outbox supplies the verdict, the
`shared`-mode settlement block is exercised by unit/fake tests but is not driven by
a real settlement outcome on production data.

## F6 — Webhook fail-closed coverage nit: malformed-shape-with-valid-HMAC not unit-exercised (Phase 7)

Webhook payload decode is fail-closed and verified at the implementation level. The
unit suite exercises HMAC mismatch and malformed-shape deliveries, but the specific
cross-product cell — a payload with a malformed SHAPE yet a VALID HMAC — is not
unit-exercised as its own case. The path is verified at the implementation level;
this is a coverage completeness nit, not a known hole in behavior.

## F7 — `createReplicaSchema` non-transactional CDC-trigger window (pre-existing, shared with one-shot sync)

`createReplicaSchema` installs the replica schema and CDC triggers outside a single
transaction, leaving a narrow window during schema creation where triggers exist
without the full schema (or vice versa). This is PRE-EXISTING and shared with the
one-shot sync path — PR #775 neither introduces nor closes it. Recorded here so the
window is tracked for a future transactional-creation fix rather than rediscovered.

## F8 — Archived-row restore round trip is not supported (archived rows leave the query window) (Phase 8, live L6)

A row archived via the public SQLite surface (`UPDATE pages SET _in_trash = 1`)
pushes and applies end-to-end: the `row_archive` CDC intent drains to Notion and
the page is confirmed trashed remotely. The inverse — restoring that same row by
toggling `_in_trash` back to `0` after the archive has synced — is NOT supported.
Notion's data-source query does not return trashed pages, so the next
reprojection rebuilds the row from observations that no longer include the
archive, and the local replica reads `_in_trash = 0`. A subsequent
`UPDATE pages SET _in_trash = 0` is then a no-op and emits no `row_restore`
intent: there is nothing to toggle.

What is proven: the archive round trip (local CDC toggle → push → remote-confirmed
trash) and that the local restore CDC trigger itself emits `row_restore` when a
row genuinely transitions `1 → 0` (non-live `sqlite-storage-contract` coverage).
What is not: a live archive-then-restore round trip on the same row, because the
archived row drops out of the active projection window and cannot be locally
restored.

Closing this needs a projection change so an archived page's trash state survives
reprojection (e.g. retaining the archive-observed event or probing the page's
trash state directly rather than relying solely on the data-source query window).
That is a fidelity/projection-semantics change out of PR #775's stated scope. The
live CDC scenario (`NDS-LIVE-public-sqlite-cdc-write`, single source) asserts the
observed behavior (post-archive-sync the row reads `_in_trash = 0`; the local
restore toggle is a no-op) rather than a contrived restore, and the
archive↔restore round-trip portion of that CDC acceptance should be untracked
until this is ratified. This is unrelated to multi-source establish, which is a
supported and accepted feature (one workspace, many tracked sources sharing one
`.notion/v1/state.sqlite`).

## F9 — Spec-declared scenarios are realized in the matrix but not yet executable (cross-phase)

Thirteen scenarios in `e2eHarnessScenarios`
(`packages/@overeng/notion-datasource-sync/src/testing/scenarios.ts`) remain
`file: docs/vrs/spec.md` — declared in the traceability matrix but not pointed at a
concrete executable test. This is deliberate: each names behavior that is either
mechanism-backed but not yet falsifiably driven, or whose production logic is not
wired, or whose proof needs a fixture or timing context that does not exist today.
Six sibling scenarios that previously sat here were repointed to the concrete tests
that already exercise them (`NDS-L4-bidi-disjoint-property-merge`,
`NDS-L3-bidi-ambiguous-write-idempotency` →
`src/e2e/fake-service.e2e.test.ts`; `NDS-L4-bidi-conflict-resolution-lifecycle`
→ `src/e2e/conflict-resolution.e2e.test.ts`;
`NDS-L4-bidi-clean-outbound-after-remote-observation`,
`NDS-L4-bidi-rebuild-replay-safety` → `src/e2e/realistic-workflows.e2e.test.ts`;
`NDS-L6-live-workspace-scratch-row-bidi` → `src/e2e/live-notion.e2e.test.ts`).
The thirteen below are the residue that no current test genuinely proves.

Each is listed with the single reason it stays declared:

- `NDS-L6-bidi-body-local-capture-first` — body-convergence-pending. Tracked by F1:
  production emits property facts only into the convergence engine, so a local
  `.nmd` body capture preceding remote body materialization has no convergence path
  to prove.
- `NDS-L4-bidi-same-property-race-conflict` — daemon-incremental-timing-scope. The
  same-property conflict base behavior is covered; the concurrent SQLite/Notion race
  variant depends on daemon incremental timing not yet scoped.
- `NDS-L4-bidi-archive-edit-race` — daemon-incremental-timing-scope. Row-lifecycle
  vs property-edit fail-closed is covered at base; the race ordering between archive
  and edit is a daemon incremental-timing variant.
- `NDS-L5-bidi-watermark-boundary-overlap` — daemon-incremental-timing-scope.
  Incremental last-edited-time boundary draining is a daemon-loop timing concern not
  yet wired for a falsifiable boundary-overlap proof.
- `NDS-L5-bidi-incremental-absence-not-tombstone` — daemon-incremental-timing-scope.
  Polling-omission-is-not-a-tombstone needs an incremental poll loop to drive the
  filtered-absence path.
- `NDS-L5-bidi-local-first-slow-pull` — daemon-incremental-timing-scope. Pushing
  eligible CDC before a slow remote pull completes is a watch-loop interleaving not
  yet scoped.
- `NDS-L5-bidi-inline-hydration-correctness` — daemon-incremental-timing-scope.
  Inline query-row hydration correctness across incremental polls needs the same
  daemon timing context.
- `NDS-L5-bidi-relation-pagination-scoped-block` — relation-rollup-file-fixtures-missing.
  Scoped blocking on incomplete relation pagination needs relation/rollup fixture
  types that do not exist in the corpus today.
- `NDS-L3-conflict-soak-matrix` — matrix-umbrella-over-tested-cells. An umbrella
  declaration over same-surface and cross-surface replay cells, individual cells of
  which are already exercised by concrete conflict tests.
- `NDS-L5-high-cardinality-fake-soak` — matrix-umbrella-over-tested-cells. An umbrella
  over bounded pagination and outbox-pressure cells whose primitives are individually
  proven; the soak aggregate is not run as one declared case.
- `NDS-L3-property-data-type-matrix` — matrix-umbrella-over-tested-cells. An umbrella
  over writable/computed/relation/file/rollup property cells; the writable cells are
  exercised, the computed/relation/rollup cells need the missing fixtures above.
- `NDS-L6-live-workspace-provisioner-lane` — live-workspace-lane-incomplete. The
  canonical synthetic-workspace provisioner lane is not fully stood up outside the
  repository, so its stable-fixture-ID guarantee is not driven end to end.
- `NDS-L6-live-workspace-read-only-downsync` — live-workspace-lane-incomplete. The
  #715 read-only live downsync depends on the same provisioner lane.

These remain `file: docs/vrs/spec.md` on purpose: declared-but-not-executable so the
matrix stays honest about what is named versus what is proven. They are to be
realized post-merge, each repointed to a concrete test once its mechanism is wired,
its fixture exists, or its daemon-timing/live lane is stood up.

## Considered Options

| Option                                                          | Result   | Reason                                                                                                                                                                          |
| --------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document each tracked-but-open follow-up as a ratification gate | Selected | Honors decision 0007 ("document the gap, don't silently drop"); keeps the matrix green and honest while making the residue reviewable in one durable place.                     |
| Force-close each follow-up inside PR #775                       | Rejected | Several need a property/media boundary change (F3, F4) or real outbox/settlement wiring (F5) that is out of PR #775's stated scope; rushing them risks unsafe partial surfaces. |
| Leave them only in scenario comments / transcript               | Rejected | Not durable for ratification; violates decision 0007's "don't silently drop".                                                                                                   |

## Consequences

Each follow-up needs an explicit ratification verdict: accept as a tracked v1 gap,
schedule as a follow-up issue, or pull into scope. F3/F4 share a property/media
boundary refactor and should be ratified together. F5 unblocks once the outbox
settlement verdict is wired (`TODO(settlement-wiring)`). F2 and F6 are coverage-
completeness items closeable with fixtures, not behavior changes. F7 is a
pre-existing transactional-creation fix independent of this PR.
