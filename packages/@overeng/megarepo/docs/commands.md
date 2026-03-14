# Commands Reference

All commands support `--output json` or `--output ndjson`.

## Core Commands

### `mr fetch --apply`

Fetch configured refs, reconcile the workspace to `megarepo.json`, and write the new lock.

```bash
mr fetch --apply [--force] [--all] [--only <members>] [--skip <members>] [--create-branches] [--dry-run]
```

Behavior:

1. Resolve members from `megarepo.json`
2. Fetch from remotes and update worktrees to latest commits
3. Materialize or reuse canonical source-ref worktrees in the store
4. Repair duplicate encoded/unencoded branch worktrees with `--force`
5. Repoint `repos/*` symlinks
6. Update `megarepo.lock`
7. Run generators

Pinned members are skipped unless `--force` is used.

### `mr lock`

Record the current synced workspace state into `megarepo.lock`.

```bash
mr lock [--force] [--all] [--only <members>] [--skip <members>] [--dry-run]
```

This expects the workspace to already be reconciled to `megarepo.json`. If a member symlink points at the wrong ref, it is skipped with a hint to run `mr fetch --apply`.

### `mr apply`

Apply the exact commits from `megarepo.lock`.

```bash
mr apply [--force] [--all] [--only <members>] [--skip <members>] [--dry-run]
```

This is the reproducible CI mode. It requires a non-stale lock file and materializes commit worktrees.

## Pin Commands

### `mr pin`

```bash
mr pin <member> [-c <ref>]
```

Switch a member to a specific branch, tag, or commit and mark the lock entry as pinned.

### `mr unpin`

```bash
mr unpin <member>
```

Remove the pin so `mr fetch --apply` can move the member again.

## Info Commands

### `mr status`

```bash
mr status [--json]
```

Reports:

- `workspaceSyncNeeded`
- `lockSyncNeeded`
- duplicate encoded/unencoded branch worktrees
- ref mismatch, symlink drift, stale lock, and commit drift

### `mr ls`

```bash
mr ls [--json]
```

### `mr root`

```bash
mr root [--json]
```

## Store Commands

### `mr store ls`

```bash
mr store ls [--json]
```

### `mr store fetch`

```bash
mr store fetch [--json]
```

### `mr store gc`

```bash
mr store gc [--dry-run] [--force] [--all]
```

Removes unused worktrees. Dirty worktrees are preserved unless `--force` is used.
