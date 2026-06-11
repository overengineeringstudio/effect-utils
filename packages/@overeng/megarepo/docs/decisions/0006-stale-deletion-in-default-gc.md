# Stale named-branch deletion is part of default `mr store gc`

## Status

accepted

## Context

Options considered: a default-off opt-in mode, a separate command, or folding
stale named-branch deletion into the default `mr store gc`. The default-gc option
was chosen for maximal effectiveness and a single "reclaim disk" surface.

## Decision

`mr store gc` (no flags) collects stale named-branch worktrees in addition to its
current commit-worktree cleanup. The aggressive, protection-bypassing `--all`
remains a separate explicit mode.

Because this changes long-standing behavior and permanently deletes worktrees,
the safety gates are NOT optional — they are what makes default-on acceptable:

- Hard cross-megarepo live-set veto (registry, all workspaces).
- Lossless floor: commit reachable on a remote + capture-then-trash any
  uncommitted state before deletion.
- Primary staleness signal = merged PR; absence of merged evidence ⇒ keep.
- Continuous-absence grace window before a worktree is eligible.
- `--dry-run` remains; normal runs must clearly report every stale deletion and
  how to recover it from trash.

## Consequences

- Any caller of `mr store gc` now also removes merged/cold named branches; output
  must make this visible and recoverable, not silent.
- A timer/disk-hygiene consumer can call `mr store gc --dry-run --json` for
  pressure-aware planning and the plain command to act.
- The conservative gates mean the effective default behavior on a repo with no
  GitHub access or no merged PRs is unchanged (nothing extra deleted).
