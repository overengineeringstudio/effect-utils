# Reclaim cold named-branch worktrees by deletion, in default `mr store gc`

## Status

accepted (supersedes the original artifact-pruning scope of #771)

## Context

`mr store gc` default mode protected every `refs/heads/*`/`refs/tags/*` worktree
unconditionally (`classifyStoreWorktreePolicy` → `named_branch_ref`); only
detached `refs/commits/*` outside the live set were collectable. A real-store
survey (2026-06-10) found 323 named-branch worktrees (122 in effect-utils),
mostly cold — the dominant accumulation default GC could not touch. #771
originally proposed keeping every worktree and pruning only its regenerable
artifacts in place.

## Decision

Target **full deletion of cold named-branch worktrees**, folded into the **default
`mr store gc`** (not an opt-in flag or separate command — one "reclaim disk"
surface). The protection-bypassing `--all` stays a separate explicit mode. The
artifact-prune-in-place mode from #771 is **deferred**.

Because this permanently deletes worktrees, the safety gates are what make
default-on acceptable, evaluated in order (each short-circuits to keep): hard
cross-megarepo live-set veto ([0002](0002-cross-megarepo-liveness-veto.md)) →
staleness = merged/closed PR, never the default branch
([0004](0004-staleness-merged-or-closed-pr.md)) → lossless floor + capture
([0003](0003-lossless-capture-via-archive.md)) → grace timers
([0005](0005-three-reclamation-timers.md)) → archive-then-reap.

## Consequences

- The hard problem is "which worktrees hold no irreplaceable state", a safety
  classification — a false positive can lose un-pushed/uncommitted work, so the
  gate is conservative.
- Any `mr store gc` caller now also removes merged/cold named branches; output
  must make each deletion visible and recoverable, not silent. `--dry-run --json`
  serves a pressure-aware disk-hygiene consumer.
- **Default-on stands** (confirmed by dry-run validation): the per-run cost (~31
  fetch + ~31 `gh`) is accepted even though steady-state reclaim is modest. With
  no GitHub access or no merged PRs the effective behaviour is unchanged.
- **Worktree-deletion is the accepted scope** (validation): it reclaims ~90M–7.9G
  while ~445G sits in `node_modules`/`target` of legitimately-kept worktrees;
  artifact-pruning is explicitly NOT pursued here (future work under #771).
