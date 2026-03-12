# Workflows

Common megarepo workflows.

## Daily Development

Start by reconciling the local workspace to `megarepo.json`:

```bash
mr sync
```

This ensures `repos/*` points at the configured refs but does not rewrite `megarepo.lock`.

## Recording Current State

After making changes across member repos, record the exact current commits:

```bash
mr lock sync
git add megarepo.lock
git commit -m "Update megarepo lock"
```

## Updating Members From Remote

To intentionally move branch-tracking members forward:

```bash
mr lock update
mr lock update --only effect
mr lock update --force
```

Pinned members are skipped by `mr lock update` unless `--force` is set.

## CI Reproducibility

CI should apply the committed lock exactly:

```bash
mr lock apply --git-protocol=https
```

That materializes commit-based worktrees from `megarepo.lock`.

## Switching Refs

```bash
mr pin effect -c feature/new-api
mr pin effect -c main
mr unpin effect
mr lock update --only effect
```

Each ref has its own worktree in the store, so switching refs preserves local WIP in the previous worktree.

## Nested Megarepos

```bash
mr sync --all
mr lock sync --all
mr lock update --all
mr lock apply --all
```

Use `mr sync --all` for local workspace setup. Reserve `mr lock apply --all` for CI or other isolated stores.
