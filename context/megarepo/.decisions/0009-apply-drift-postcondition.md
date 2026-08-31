# Fail apply when a pinned worktree stays drifted from the lock

Status: accepted

Migrated from `packages/@overeng/megarepo/docs/decisions` on 2026-08-31. The
Context, Decision, and alternatives are verbatim; the `Status:` line, the
Evidence and Argument section, and the `## Options` table (built from this
record's own "Alternatives considered" list, which is retained below in full)
were added to satisfy the VRS decision-record shape.

## Context

`mr apply` promises Lock → Workspace, but every path that returned `skipped`
exited 0. When a skip left a member materialized at a revision other than the one
`megarepo.lock` records, apply reported success over a workspace that disagreed
with the lock that produced it.

Nothing else caught it. `repos/` is gitignored, so `git status` stays clean.
`mr:lock-sync-check` compares `devenv.lock` against `megarepo.lock` — lock against
lock, never workspace against lock. `mr status` does compute the drift, but nothing
gates on it.

That combination put a contributor's checkout at one revision while the lock said
another (livestorejs/livestore#1467, and the same failure a second time in
livestorejs/livestore#1168). They had not skipped a step; apply told them it had
succeeded.

## Evidence and Argument

The decisive evidence is the recurrence: livestorejs/livestore#1467 is
livestorejs/livestore#1168 happening again after the first was handled
downstream. A defect that reappears at the same site after a consumer-side fix
is evidence the fix was in the wrong place — the workspace is written by
`mr apply`, so that is where the postcondition has to be enforced. The
surrounding checks all pass while the workspace is wrong, so no additional
guard elsewhere closes it.

## Options

| Option                                            | Tradeoff                                                                            | Outcome  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ | -------- |
| Error on drifted commit worktrees (this decision) | Restores the Lock → Workspace contract; commit worktrees only, branch worktrees free | Accepted |
| Fail on any drifted worktree, branch or commit    | Simpler rule; breaks co-development, where a branch worktree ahead of the lock is intended | Rejected |
| Force-switch the worktree to the locked revision  | Restores the postcondition with no new error path; silently discards uncommitted work | Rejected |
| Detect the drift in each downstream consumer      | No mr change; special-cases one consumer and leaves every other exposed              | Rejected |

## Decision

A commit worktree (`refs/commits/<sha>/`) is a _pinned materialization_: apply put
it there to satisfy an exact lock entry, and nothing else legitimately moves it. If
its sha no longer matches the lock, apply failed its contract regardless of why it
could not switch — so it reports an error naming both revisions and exits non-zero,
instead of a silent skip.

Branch worktrees are excluded. Co-development deliberately moves `HEAD` ahead of the
lock, and failing there would break the normal local loop.

The dirty-worktree protection itself is unchanged: apply still refuses to clobber
uncommitted work. It just no longer claims success while doing so.

## Alternatives considered

- **Fail on any drifted worktree, branch or commit.** Simpler rule, but it breaks
  co-development: a branch worktree ahead of the lock is the intended state during
  local development, not an error.
- **Force-switch the worktree to the locked revision.** Restores the postcondition
  without a new error path, but silently discards uncommitted work. `--force`
  already exists for callers who want that.
- **Detect the drift in each downstream consumer.** A consumer-side guard (for
  example, validating the checkout inside a `devenv.nix`) was proposed in
  livestorejs/livestore#1468. It special-cases one consumer, leaves every other one
  exposed, and #1467 recurring after #1168 is evidence that the defect has to be
  fixed where the workspace is written.
