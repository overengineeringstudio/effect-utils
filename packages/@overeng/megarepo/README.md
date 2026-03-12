# megarepo

Megarepo (`mr`) composes multiple git repositories into a shared development workspace. It materializes member repos from `megarepo.json` into `repos/`, and records exact commits in `megarepo.lock` when you explicitly manage the lock.

## Why megarepo?

- Shared worktrees in `~/.megarepo` avoid duplicate clones across workspaces
- `megarepo.json` declares branch or tag intent
- `megarepo.lock` records exact commits for CI and reproducible setups
- Workspace sync and lock management are separate operations

## Quick Start

```bash
mr init
mr add effect-ts/effect
mr add effect-ts/effect#v3.0.0 --name effect-v3
mr add ./packages/local-lib --name local-lib

mr sync
mr lock sync
```

## Command Model

| Command | Purpose |
| --- | --- |
| `mr sync` | Reconcile `repos/*` and store worktrees to `megarepo.json` without changing `megarepo.lock` |
| `mr lock sync` | Record the current synced workspace state into `megarepo.lock` |
| `mr lock update` | Fetch configured refs, update workspace worktrees, and write the new lock |
| `mr lock apply` | Apply `megarepo.lock` exactly, using commit worktrees for reproducible CI |

## Typical Flow

```bash
mr sync

# work in repos/*

mr lock sync
git add megarepo.lock
git commit -m "Update megarepo lock"
```

To intentionally move dependencies forward:

```bash
mr lock update
```

For CI:

```bash
mr lock apply --git-protocol=https
```

## Directory Layout

After `mr sync` and `mr lock sync`:

```text
my-megarepo/
├── megarepo.json
├── megarepo.lock
└── repos/
    ├── effect -> ~/.megarepo/github.com/effect-ts/effect/refs/heads/main/
    ├── effect-v3 -> ~/.megarepo/github.com/effect-ts/effect/refs/tags/v3.0.0/
    └── local-lib -> ./packages/local-lib
```

Branch worktrees are canonicalized under percent-encoded paths in the store, for example `feature/foo` becomes `refs/heads/feature%2Ffoo/`.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Commands Reference](docs/commands.md)
- [Workflows](docs/workflows.md)
- [Specification](docs/spec.md)
