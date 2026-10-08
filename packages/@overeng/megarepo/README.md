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

For authenticated HTTPS clones, configure a Git credential helper (for example,
`gh auth setup-git`) or use SSH. Clone URLs are stored as the `origin` remote;
megarepo removes HTTP URL userinfo before cloning so tokens cannot be persisted
there. A credential in a source URL does not replace a configured credential helper.

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

`mr store gc` can plan old generated directories in registered, clean, inactive store worktrees,
then apply exactly one candidate from that immutable plan:

```bash
mr store gc --generated-artifacts --dry-run --output json
mr store gc --generated-artifacts --expected-plan <sha256> --candidate-path <path> --output json
```

Configure the host at `$MEGAREPO_STORE/.state/gc-config.json`:

```json
{
  "generatedArtifacts": {
    "enabled": true,
    "retentionMs": 86400000,
    "allowlist": ["node_modules", ".direnv", "target", "storybook-static"]
  }
}
```

The allowlist may contain only the compiled canonical classes, including `storybook-static`.
Activity is captured directly from `st3 agents ls --all --json`, each agent's
`st3 subject show <id> --json` `actual.workspace`, and `pty list --json --tags`.
There is no external activity manifest to configure. By default `st3` and `pty` are resolved
on PATH. Set `MEGAREPO_GC_ST3_BIN` and `MEGAREPO_GC_PTY_BIN` to explicit executable paths
(for example Nix store paths in a systemd unit). A configured executable that cannot be run
produces `unknown`; it never falls back to another binary on PATH.

Active workspaces and all retained PTY records protect overlapping worktree paths, including
exited or vanished sessions, nested cwds, and composed workspace roots. A terminal PTY record
continues to own its workspace until the record is removed; process exit alone does not release
its conservative GC protection.

Missing, invalid, incomplete, timed-out, or unreadable activity evidence produces `unknown`.
Each bounded command invocation observes the native live surface. st3's snapshot `created_at`
is the last incorporated claim's timestamp, not request time, so an idle projection is not
rejected merely because that timestamp is old.
A candidate must also contain no Git-tracked files (including force-added files beneath ignored
directories), be Git-ignored, older than the retention window, absent from Megarepo's live set,
and inside a clean registered worktree with no live process cwd. An unavailable native process
probe also produces `unknown`. A capped, timed recursive scan uses the newest nested mtime;
symlinks or incomplete scans produce `unknown`. JSON results retain the same shape and distinguish
`would-delete`, `deleted`, `keep`, and `unknown` with a deterministic `planSha256`.
Application recomputes the complete plan, requires the exact digest and a unique candidate, then
revalidates and removes only that candidate under its owner-worktree lock and its deletion lease.

### Deletion lease

An activity snapshot cannot exclude an activation that starts immediately afterwards. A lease
per canonical owner worktree closes that window for cooperating activators: reclamation holds it
across final classification and deletion, and activation holds it from before its first worktree
write until after it has published its activity. The lease is one file at
`$MEGAREPO_STORE/.state/deletion-leases/<sha256-of-owner-path>.lease`, taken by hard-linking onto
that path — atomic on POSIX, so the loser fails closed instead of proceeding on a stale snapshot.
Every plan-bound deletion takes it, whole worktrees and archive reaps included, since an activation
of the worktree being deleted is exactly what the lease has to exclude.

Reclaiming a dead holder's lease is the only step that can destroy another holder's lease, so it is
serialized by a per-owner recovery lock (`<sha256>.recover`, hardlink-create-only and never itself
recovered) and, inside that lock, may remove only the exact record it proved dead. Without both, two
recoverers of one dead lease can interleave into two believed holders. A crash while holding the
recovery lock blocks only future recovery — plain acquisition and release stay live.

Activation needs no protocol code of its own; wrap it:

```bash
mr store lease --owner-path /path/to/store/worktree -- <activation command>
```

A lease is reclaimed only when its record is decodable, names this host, and names a pid that is
provably gone. A foreign host, a live pid, or an unreadable record keeps the lease and refuses the
caller. `mr store lease` propagates the wrapped command's own exit code.

### Live-process veto

The lease only excludes an activation that takes it, and a shell or agent session that was already
sitting inside a worktree announces nothing. On Unix a rename is invisible to a process already in
that directory — its cwd silently follows the inode into `.archive/` — so every destructive
worktree step additionally refuses when a live process has its cwd inside the target, reporting
`kept` with `reason: process-in-use` (a plan-bound application fails instead). Evidence is
`/proc/<pid>/cwd` on Linux and the system `lsof` cwd table on macOS; megarepo's own process and its
children are excluded so a `git` child cannot self-veto. A host without a supported process table,
or a scan that cannot be read, is `unknown` and keeps.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Commands Reference](docs/commands.md)
- [Workflows](docs/workflows.md)
- [Specification](docs/spec.md)
