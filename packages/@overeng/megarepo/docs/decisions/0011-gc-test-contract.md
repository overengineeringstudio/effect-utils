# GC test contract: deterministic seams, layered tests

## Status

accepted

## Context

Cold-worktree reclamation is safety-critical and time-/network-dependent. Tests
must be deterministic and must exercise the safety invariants, not just the happy
path. The codebase has no Effect `Clock` usage and no PR/network seam, so the
testability seams must be designed in, not retrofitted.

## Decision

Two injected boundaries, everything else real (no mocking of our own code):

1. **Time** — an explicit `now: number` (epoch ms) threaded through every decision
   and persistence function (`classifyColdWorktree`, `recordObservations`,
   `archiveWorktree`, `refreshWorkspaceRegistry.updatedAt`). The CLI edge reads
   `Clock.currentTimeMillis`; tests pass fixed values. One uniform seam.
2. **PR state** — a `PrStateResolver` service (`Context.Tag` + `Layer.effect`, the
   repo's service pattern) provided into the gc command. Live impl shells `gh`;
   tests provide a deterministic stub layer. No process-level `gh` mocking.

Four test layers, cheapest-first:

- **Pure unit** — `classifyColdWorktree` as a gate-precedence table (one row per
  gate proving short-circuit + the dangerous near-misses), PR-JSON parse/join,
  observation-ledger transitions (incl. corrupt-file and no continuity-laundering),
  config merge.
- **Property** (`@effect/vitest` `it.prop`, `fc` from `effect/FastCheck`) — the
  hard invariants: in-live-set ⇒ never archive; open/none ⇒ keep; unpushed>0 ⇒
  keep; stash present ⇒ keep.
- **Integration** (extended `store-setup.ts` fixture) — the cross-megarepo matrix,
  the reconcile-all fail-safe (unreadable workspace ⇒ kept) and repin regression,
  archive/reap with retention, and archive → `mr apply` re-materialization. Needs
  three new fixture primitives: a bare with real remote-tracking refs (for
  reachability), a `repinWorkspace` mutator, and `createArchiveEntry`.
- **Isolated real-binary e2e** (CI-gated/manual) — the real `mr` against a `/tmp`
  store; needs `gh`/network, excluded from the default unit run.

## Consequences

- The injected-`now` and `PrStateResolver` seams are net-new patterns in this
  package; introduced deliberately for determinism.
- The integration fixture must grow before the load-bearing safety tests can be
  written; budget that work explicitly.
