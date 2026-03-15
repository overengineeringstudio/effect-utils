# Workflows

Common megarepo workflows.

## Daily Development

Start by fetching and reconciling the local workspace to `megarepo.json`:

```bash
mr fetch --apply
```

This fetches from remotes, ensures `repos/*` points at the configured refs, and updates `megarepo.lock`.

## Recording Current State

After making changes across member repos, record the exact current commits:

```bash
mr lock
git add megarepo.lock
git commit -m "Update megarepo lock"
```

## Updating Members From Remote

To intentionally move branch-tracking members forward:

```bash
mr fetch --apply
mr fetch --apply --only effect
mr fetch --apply --force
```

Pinned members are skipped by `mr fetch --apply` unless `--force` is set.

## CI Reproducibility

CI should apply the committed lock exactly:

```bash
mr apply --git-protocol=https
```

That materializes commit-based worktrees from `megarepo.lock`.

## Switching Refs

```bash
mr pin effect -c feature/new-api
mr pin effect -c main
mr unpin effect
mr fetch --apply --only effect
```

Each ref has its own worktree in the store, so switching refs preserves local WIP in the previous worktree.

## Nested Megarepos

```bash
mr fetch --apply --all
mr lock --all
mr apply --all
```

Use `mr fetch --apply --all` for local workspace setup. Reserve `mr apply --all` for CI or other isolated stores.
