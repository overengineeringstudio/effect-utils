# megarepo

Megarepo (`mr`) composes multiple git repositories into a shared development workspace. It materializes member repos from `megarepo.kdl` into `repos/`, and records exact commits in `megarepo.lock` when you explicitly manage the lock.

## Why megarepo?

- Shared worktrees in `~/.megarepo` avoid duplicate clones across workspaces
- `megarepo.kdl` declares branch or tag intent (KDL v2 format, hand-written)
- `megarepo.lock` records exact commits for CI and reproducible setups
- Workspace sync and lock management are separate operations

## Quick Start

```bash
mr init
mr add effect-ts/effect
mr add effect-ts/effect#v3.0.0 --name effect-v3
mr add ./packages/local-lib --name local-lib

mr fetch --apply
mr lock
```

## Command Model

| Command            | Purpose                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `mr fetch --apply` | Fetch configured refs, reconcile workspace, and update `megarepo.lock`    |
| `mr lock`          | Record the current synced workspace state into `megarepo.lock`            |
| `mr apply`         | Apply `megarepo.lock` exactly, using commit worktrees for reproducible CI |

## Typical Flow

```bash
mr fetch --apply

# work in repos/*

mr lock
git add megarepo.lock
git commit -m "Update megarepo lock"
```

To intentionally move dependencies forward:

```bash
mr fetch --apply
```

For CI:

```bash
mr apply --git-protocol=https
```

## Directory Layout

After `mr fetch --apply` and `mr lock`:

```text
my-megarepo/
├── megarepo.kdl
├── megarepo.lock
└── repos/
    ├── effect -> ~/.megarepo/github.com/effect-ts/effect/refs/heads/main/
    ├── effect-v3 -> ~/.megarepo/github.com/effect-ts/effect/refs/tags/v3.0.0/
    └── local-lib -> ./packages/local-lib
```

Branch worktrees use raw Git ref paths in the store, for example `feature/foo` becomes `refs/heads/feature/foo/`.

## Generated artifact cleanup

`mr store gc` can plan old generated directories in registered, clean, inactive store worktrees.
This first slice is deliberately non-mutating:

```bash
mr store gc --generated-artifacts --dry-run --output json
```

Configure the host at `$MEGAREPO_STORE/.state/gc-config.json`:

```json
{
  "generatedArtifacts": {
    "enabled": true,
    "retentionMs": 86400000,
    "allowlist": ["node_modules", ".direnv", "target"],
    "agentLivenessManifest": "/run/megarepo/st2-workspace-activity.json",
    "agentLivenessEpoch": { "catalog": "/var/lib/st2/catalog", "host": "dev3" }
  }
}
```

The allowlist may contain only the compiled canonical classes. The liveness manifest must be a
native, short-lived `st2 workspace-activity --json` snapshot:

```json
{
  "schemaVersion": "st2.workspace-activity.v1",
  "producer": "st2",
  "epoch": { "catalog": "/absolute/catalog", "host": "dev3", "catalogGeneration": 42 },
  "capturedAt": "2026-08-14T08:00:00.000Z",
  "expiresAt": "2026-08-14T08:01:00.000Z",
  "complete": true,
  "errors": [],
  "claims": [
    {
      "workspace": "/absolute/path/to/a/store/worktree",
      "agents": ["dev3.example.agent"],
      "activeRuntimeIds": ["dev3.example.agent"],
      "active": true
    }
  ]
}
```

Missing, invalid, incomplete, erroneous, expired, or non-canonical liveness data produces
`unknown`. The configured catalog and host admit the expected epoch; its catalog generation must
remain unchanged across the pre-scan and post-scan reads. A candidate
must also be Git-ignored, older than the retention window, absent from Megarepo's live set, and
inside a clean registered worktree. A capped, timed recursive scan uses the newest nested mtime;
symlinks or incomplete scans produce `unknown`. JSON results distinguish
`would-delete`, `keep`, and `unknown` and include a deterministic `planSha256`. Mutation and
`--expected-plan` are rejected until the deletion transaction has a separately verified design.
The snapshot is planning evidence, not deletion authority; a future mutation path must independently
revalidate process and filesystem liveness immediately before changing data.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Commands Reference](docs/commands.md)
- [Workflows](docs/workflows.md)
- [Specification](docs/spec.md)
