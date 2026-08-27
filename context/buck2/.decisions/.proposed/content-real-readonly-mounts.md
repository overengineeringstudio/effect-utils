# 0020 Content-Real Read-Only Member Mounts; Writable Mounts Deferred

Status: proposed (q11 answered 2026-08-27; final acceptance pending the read-only-mount e2e prototype and adversarial design review)

## Context

Decision [0014](./0014-megarepo-cell-composition.md) committed to cells for
cross-member source deps but left mr's mount mechanism open. Three
investigations closed the space: symlink mounts are content-blind (Buck2
hashes the target string, not the member content — cache poisoning, no
upstream fix exists or is coming;
[05-composition/.experiments/2026-08-27-symlink-content-blindness.md](../05-composition/.experiments/2026-08-27-symlink-content-blindness.md));
git enforces one worktree per branch, so writable branch mounts require
exclusive per-branch ownership; and content-real mounts on the tracked tier
cost ~31 MiB / ~150 ms with every legacy toolchain payload (.devenv,
node_modules, buck-out) already excluded by the composition root's ignore
set.

## Evidence and Argument

The workflow survey (37,061 recorded mutations across the session archive)
measured live cross-workspace branch sharing at ONE deliberate use, zero
prescribing docs, and zero flows depending on uncommitted state crossing a
workspace — while shared `main` worktrees carried weeks-old uncommitted
lockfile drift that silently rewrote dependency identity for up to 77
mounting compositions. Authoring through mounts versus in member worktrees
ran 1:820; the practiced cross-repo flow is already commit-mediated
upstream-first. mr's `apply` can silently repoint a member mount under a live
agent on branch divergence (the fallback the prescribed PR-stack rebase step
triggers). The sharing property is therefore vestigial as a workflow, real
only as storage dedup (which content-addressed mounts preserve), and
actively hazardous as a mutation surface. Benchmarks disqualified bind
mounts (daemon-lifetime illusion, Linux-only) and writable hardlink farms
(mr's own truncate-writers mutate the source through shared inodes); the
capability projection resolved to a per-(toolset, platform) build copied
into each mount at ~4 ms with a 20 ms `--check` gate.

## Options

| Option                                                | Tradeoff                                                                       | Outcome  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ | -------- |
| Content-real read-only mounts now; writable deferred  | Smallest mr change covering all cache goals; authoring stays in member worktrees | Accepted |
| Full ref-type-keyed shape incl. writable branch mounts | In-composition authoring day one; exclusivity/prune/ref-identity machinery for a consumer evidence says barely exists | Rejected |
| Keep symlinks, forbid cache upload from compositions  | Zero mr work; forfeits cross-repo reuse and vision criterion 6 entirely        | Rejected |

## Decision

mr materializes member mounts as content-real, read-only views of locked
revisions (detached git worktree or write-protected hardlink farm; mechanism
chosen at implementation from the retained benchmarks), satisfying
COMP-R08/R10. Writable branch-attached mounts (exclusive ownership) are a
deferred addition behind demonstrated demand. Authoring happens in member
worktrees via the practiced upstream-first flow; live cross-workspace branch
sharing retires as a mutation surface, and dirty shared-`main` mounts are
cleaned as an operations task. CI composition roots may be store-resident
disposable directories (root paths do not enter digests). The mount pipeline
owes one capability projection per (toolset, platform) copied into each
mount plus the `--check` gate.

The Buck2-era agent workflow contract (q12, adopted as normative; 19 points
covering acquisition via branchy, locked-rev member defaults, read-only
shared-`main` mounts, exclusive-ownership authoring, commit-mediated
convergence, and the pin-then-author guards) supersedes contradicting skill
prose — notably sk-megarepo-alignment's non-executable "create a branch in
the member worktree" step — and lives in the execution epic's workflow
section; skill updates are follow-up work in dotfiles.

## Consequences

- Phase 2's mr work shrinks to read-only materialization + the generator; no
  branch-exclusivity machinery ships until demanded.
- The `apply`-moves-members-under-live-agents hazard class and the
  CI-env-dependent detachment trap exit the agent workflow (mounts are
  disposable read-only views regenerated from the lock).
- COMP-R10's "member cells + cache upload must not combine until
  content-real mounts land" stands as the interim guard.
