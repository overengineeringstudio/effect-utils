# Cold named-branch reclamation policy

Status: accepted

Qualifier carried from the migrated record: supersedes the artifact-pruning
scope for #771.

Migrated from `packages/@overeng/megarepo/docs/decisions` on 2026-08-31. The
Decision section is verbatim. The `Status:` line, `## Context`, and
`## Evidence and Argument` / `## Options` sections were added to satisfy the
VRS decision-record shape; their content is drawn from this record's own text
and the change that landed it, not from new analysis.

## Context

Named-branch (`refs/heads/*`) worktrees are the dominant form of store
accumulation, and default `mr store gc` previously protected them
unconditionally. That made the default mode unable to reclaim the thing that
actually grows, leaving `--all` — which bypasses every protection — as the only
lever.

## Evidence and Argument

The gates below are layered and short-circuiting, and each one exists because a
weaker rule was demonstrably unsafe. The liveness veto is store-wide: a
`repos/` symlink alone never protects a worktree, only a recorded `livePaths`
entry does, which is why reclamation must reconcile every registered workspace
rather than the current one — a repinned-but-unre-registered workspace's live
worktree was otherwise deletable. Staleness cannot be derived from git ancestry
because the repos squash-merge, so it is read from GitHub PR state. The
governing principle across all of it: absence of evidence never licenses
deletion.

## Options

This record predates the current decision-record shape and did not enumerate
options. The table below is reconstructed from alternatives named in the
record's own text; it adds no analysis the record did not already carry.

| Option                                         | Tradeoff                                                                        | Outcome  |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | -------- |
| Layered gates + archive-then-reap (this record) | Default gc reclaims the dominant accumulation; six gates and a ledger to maintain | Accepted |
| Keep protecting every named branch (prior default) | Zero work; the class that actually grows stays unreclaimable outside `--all`   | Rejected |
| Reclaim on staleness alone                     | One signal, much simpler; deletes unpushed work — the lossless floor is independent | Rejected |
| Widen scope to artifact pruning                | More disk reclaimed per run; a different risk surface, named out of scope here    | Rejected |

## Decision

Default `mr store gc` may delete cold `refs/heads/*` worktrees. `--all` remains
the explicit protection-bypassing mode; artifact pruning is out of scope.

Eligibility gates, in order:

1. **Default branch:** never reclaim the repo default branch, read from the bare
   repository.
2. **Cross-megarepo liveness:** never delete a worktree present in any registered
   workspace live set. Before destructive work, reconcile every registered
   workspace from disk; unreadable workspaces keep last-known paths.
3. **Staleness:** require GitHub PR state `merged` or `closed`. Open PR, no PR,
   non-GitHub remote, unavailable `gh`, or resolver failure means keep.
4. **Lossless floor:** require remote-reachable local commits, no unpushed
   commits, and no stash. Dirt is not classified; uncommitted and untracked files
   move with the worktree.
5. **Timers:** require absence grace (default 14d) and, for merged PRs,
   post-merge grace (default 7d). Archive retention defaults to 30d. Values are
   host-overridable via `$STORE/.state/gc-config.json`.
6. **Capture:** move first to `<repo>/.archive/<name>/`, free the branch ref so
   `mr apply` can re-materialize, and hard-delete only after retention TTL.

Continuous absence is persisted in the observation ledger. `--dry-run` must not
persist observations, and the first real run archives nothing from an empty
ledger. Reap must scan `.archive/` and re-check cross-megarepo liveness under
lock.
