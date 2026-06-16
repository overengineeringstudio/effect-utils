# Lifecycle reconciliation is a planner/outbox concern; remove the vestigial convergence path

Status: proposed

`convergeLocalSurfaces` carries `kind:'lifecycle'` / `lifecycleAction` branches
that imply page archive/restore is a local-convergence problem. It is not. Page
lifecycle (archive/restore via the SQLite `pages._in_trash` column) is
mono-surface locally — the `.nmd` file has no writable trash CDC source — so
there is no second surface to converge against.

## Decision

Page lifecycle is a planner/outbox concern, not a convergence concern. Production
already handles `row_archive` / `row_restore` entirely through the planner/outbox
path: `replicaChangesToPlannerIntents` produces `Trash`/`RestorePageCommand`, the
executor drives them, and the gateway applies them — none of this flows through
`convergeLocalSurfaces`.

Therefore REMOVE the vestigial `kind:'lifecycle'` / `lifecycleAction` branches
from `convergeLocalSurfaces`. They are dead code reachable only from tests, and
their presence advertises a convergence capability that never runs in
production; the convergence matrix should stop gesturing at a non-running path.

Lifecycle correctness is delivered instead by three concrete items, two of which
cross-reference decision 0015 (F8):

- (a) F8 (decision 0015): remote-trash reprojects the row with `in_trash = 1`,
  so an archived row survives reprojection and a local restore becomes
  expressible.
- (b) Guard `RestorePageCommand` through tombstone safety. Today it bypasses
  `guardTombstoneSafety`, which is gated on `TrashPageCommand` only. Restoring a
  page that was moved out gets no `MoveOutNotDelete` / `DeleteVsEdit` protection
  — a found gap. The guard must cover restore as well as trash.
- (c) Fix the fake gateway so `queryRows` excludes trashed rows. Today it returns
  them, which masks the F8 restore gap from tests (the fake re-observes a trashed
  row, so the archive-drops-out-of-window behavior that motivates F8 never
  reproduces at the fake level).

## Considered Options

| Option                                        | Result   | Reason                                                                                                                      |
| --------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| Remove the vestigial path                     | Selected | Honest and simpler; lifecycle is correctly a planner concern; the convergence matrix stops gesturing at a non-running path. |
| Keep it for a future `.nmd` lifecycle surface | Rejected | Speculative; no such surface or requirement exists today.                                                                   |
| Build a `.nmd` writable lifecycle surface now | Rejected | Largest scope; editing trash state from `.nmd` is not a v1 goal.                                                            |

A validation trace proved the lifecycle convergence branch is unreachable in
production — the CDC-to-planner path bypasses the engine — and that lifecycle is
mono-surface locally. The same trace surfaced the `RestorePageCommand` guard gap
and the fake-gateway query-fidelity gap via a pure-SQLite probe plus a code
trace.

## Consequences

- The four items above land: remove the convergence lifecycle branches; deliver
  F8 (decision 0015) so remote-trash reprojects `in_trash = 1`; extend
  `guardTombstoneSafety` to cover `RestorePageCommand`; fix the fake gateway's
  `queryRows` to exclude trashed rows.
- The fake-fidelity fix (c) is a prerequisite for testing F8 restore at the fake
  level — without it the archive-then-restore round trip can only be exercised
  live.
