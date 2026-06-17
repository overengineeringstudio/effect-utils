# Cold named-branch reclamation policy

## Status

accepted; supersedes artifact-pruning scope for #771

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
