# Test contract: deterministic seams, layered tests, hermetic git env

## Status

accepted

## Context

Cold-worktree reclamation is safety-critical and time-/network-/git-dependent.
Tests must be deterministic and exercise the safety invariants, not just the happy
path. The codebase had no Effect `Clock` usage and no PR/network seam, so the
testability boundaries had to be designed in.

## Decision

Two injected boundaries; everything else uses real implementations (no mocking our
own code):

1. **Time** — an explicit `now: number` (epoch ms) threaded through every decision
   and persistence function (`classifyColdWorktree`, `recordObservations`,
   `archiveWorktree`, `refreshWorkspaceRegistry.updatedAt`). The CLI edge reads
   `Clock.currentTimeMillis`; tests pass fixed values.
2. **PR state** — a `PrStateResolver` service (`Context.Tag` + `Layer.effect`, the
   repo's pattern). Live impl shells `gh`; tests provide a deterministic stub layer.

Four test layers, cheapest-first: **pure unit** (`classifyColdWorktree` as a
gate-precedence table + near-misses; PR-JSON join; observation-ledger transitions;
config merge); **property** (`it.prop`/`fc`: in-live ⇒ never archive; open/none ⇒
keep; unpushed>0 ⇒ keep; stash ⇒ keep); **integration** (extended `store-setup.ts`
fixture — cross-megarepo matrix, reconcile-all fail-safe + repin regression,
retention reap, archive → `mr apply` re-materialization); **isolated real-binary
e2e** (gated; real `mr` against a `/tmp` store).

**Hermetic git environment** (vitest `setupFiles` `git-env-setup.ts`): pin
`GIT_CONFIG_GLOBAL` (`init.defaultBranch=main` + identity), `GIT_AUTHOR/COMMITTER_*`,
and `fs.realPath` fixture temp dirs. Fixtures must not depend on the host's git
config — CI defaults `init.defaultBranch` to `master`, has no committer identity,
and (macOS) symlinks `/var`→`/private/var` while `git worktree list` reports the
realpath; each silently broke tests that passed locally.

## Validated by dry-run (2026-06-11/12)

Real branch CLI in isolated stores (9/9 scenarios) + a read-only classifier
projection over the real store (281 named worktrees): confirmed the design and
surfaced the default-branch hazard (→ [0004](0004-staleness-merged-or-closed-pr.md))
and the levers left as-is — stash repo-global
([0003](0003-lossless-capture-via-archive.md)), default-on
([0001](0001-reclaim-cold-worktrees-in-default-gc.md)), no artifact-pruning,
first-run-archives-nothing ([0005](0005-three-reclamation-timers.md)).
