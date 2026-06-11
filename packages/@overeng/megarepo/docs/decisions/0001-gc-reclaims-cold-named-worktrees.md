# GC reclaims cold named-branch worktrees by deletion, not artifact-pruning

## Status

accepted (supersedes the original scope of issue #771)

## Context

`mr store gc` default mode protects every `refs/heads/*` and `refs/tags/*`
worktree unconditionally (`classifyStoreWorktreePolicy` → `named_branch_ref`).
Only detached `refs/commits/*` worktrees outside the live set are collectable.
A real-store survey (2026-06-10) found 323 named-branch worktrees across the
store (122 in effect-utils alone), most cold, so default GC structurally cannot
reclaim the dominant accumulation.

Issue #771 originally proposed the conservative path: keep every worktree, delete
only its regenerable artifacts in place (`--prune-artifacts`).

## Decision

Target **full deletion of cold named-branch worktrees** instead. Refine the
staleness classification so default GC can safely delete a cold named-branch
worktree (reclaiming source, `.git`, and artifacts together). The
artifact-prune-in-place mode from #771 is **deferred**, not pursued in this work.

## Consequences

- The hard problem moves from "which artifacts are regenerable" to "which
  worktrees hold no irreplaceable state" — a safety-classification problem.
- A false-positive deletion can lose un-pushed/uncommitted work, so the safety
  gate must be conservative (see later decisions on the deletion invariant).
- Worktrees we want to keep but that carry fat artifacts are NOT addressed here;
  artifact-pruning remains available as future work under #771.
