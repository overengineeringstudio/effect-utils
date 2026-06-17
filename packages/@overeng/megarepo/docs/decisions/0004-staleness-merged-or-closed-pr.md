# Staleness is merged-or-closed PR, never default branch

## Status

accepted

## Context

Git ancestry is not a reliable merged signal for squash-merged branches; merged
branches can remain hundreds of commits ahead of `main`. GitHub PR state is the
stronger completion signal.

PR-state joins by branch name can match common default branch names such as
`main`, so the default branch needs an independent hard guard.

## Decision

A branch is stale only when its GitHub PR is `merged` or `closed`. An open PR, no
PR, non-GitHub remote, unavailable `gh`, or resolver failure means keep.
Closed-unmerged branches still need the lossless floor, so deleted-remote work is
kept when commits are no longer reachable from a remote.

Before any staleness check, a worktree whose ref equals the repo default branch
is never reclaimed. The default branch is read offline from the bare repository.

## Consequences

- Stale-deletion is coupled to GitHub for GitHub-hosted repos.
- The resolver batches and caches per GC run and returns state plus
  `mergedAt`/`closedAt` for timer checks.
- Branches with no PR, including never-pushed scratch branches, are never
  collected.
