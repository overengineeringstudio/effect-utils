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

### Build-output budgets

A host policy can cap per-class build output across every store worktree and evict least recently
written idle roots until each class is back under budget:

```bash
mr store gc --budgets /etc/megarepo/build-output-budgets.json --dry-run --output json
mr store gc --budgets /etc/megarepo/build-output-budgets.json --expected-plan <sha256> --candidate-path <root> --output json
```

`--budgets` cannot be combined with `--generated-artifacts`, `--all`, or `--force`. The policy is
decoded strictly before the store is inspected: an unreadable file, unknown `schemaVersion`, or
malformed field exits non-zero and deletes nothing. Its shape is:

```json
{
  "schemaVersion": "megarepo.build-output-budgets.v1",
  "host": "build-host",
  "storeRoots": ["/home/developer/.megarepo"],
  "quotaBytes": 824633720832,
  "idleRetentionMs": 86400000,
  "classes": {
    "cargo-target": { "budgetBytes": 85899345920, "paths": ["target", "**/target"] }
  },
  "worklog": { "path": "tmp/worklog", "teardown": "delete" }
}
```

`<name>` matches only at the worktree root; `**/<name>` also matches nested directories without
crossing symlinks, mount points, `.git`, another class root, or `tmp/worklog`. Scans are bounded by
an entry cap and deadline; an incomplete scan reports the class `scanStatus: "scan-incomplete"` and
its rows `unknown`, independently of `keptByReason`.

Accounting sums allocated bytes (`st_blocks * 512`) over unique `(dev, ino)` pairs without
following symlinks, so hardlinked files count once. Reflinked or deduplicated blocks still count
as allocated per file: on ZFS or other copy-on-write filesystems, the physical savings of block
cloning are not visible to `du` or to this accounting, and evicting a reflinked root can free fewer
bytes than reported. Per class, roots are evicted in ascending newest-write order until the
projected total fits the budget. Only proven-idle roots are candidates: no live process
cwd/root/fd/maps inside the worktree, no held `mr store lease`, no active agent claim, newest write
older than `idleRetentionMs`, Git-ignored with no tracked file, and canonically contained in the
worktree. Any unknown keeps. When nothing idle remains, the class reports
`over-budget-no-idle-candidate` rather than evicting live work.

JSON output is the `megarepo.build-output-budget-plan.v1` document: `planSha256`, the candidate
`results`, and `classes` keyed by class name with `totalBytes`, `budgetBytes`,
`idleCandidateBytes`, `evictedBytes`, `projectedBytes`, `keptByReason`, `scanStatus`, and `status`
for exporting gauges. Application holds the owner-worktree lock and deletion lease, recaptures
activity on the admitted epoch, replans completely, requires the same digest, and re-checks every
idle predicate on the one candidate before deleting it.

`--budgets` itself never removes worktrees or worklogs; budget mode evicts build-output roots
only. The optional `worklog` field is consumed by default GC teardown (below).

Builds that have not written yet are invisible to the mtime and activity checks. Until devenv and
agent activations wrap their builds in `mr store lease --owner-path <worktree>`, such a build is
protected only by the process veto; lease wrapping of activations is tracked in
[the activation integration follow-up](https://github.com/overengineeringstudio/effect-utils/issues/1755).

### Root activity snapshot

An unprivileged store owner cannot read other users' `/proc/<pid>/{cwd,root,fd,maps}`, so the
strict process probe reports `unknown` (and keeps) whenever foreign processes exist. A host can
close that gap with a root oneshot that writes a producer-neutral manifest:

```bash
mr store activity snapshot --output /run/megarepo/workspace-activity.json
```

The command writes `megarepo.workspace-activity.v2` with producer `mr-process`, the host epoch,
`capturedAt` and `expiresAt` (at most 5 minutes later), `complete`, `errors`, and one claim with
source `process` per path under the store root referenced by any process cwd, root, open file, or
mapped file. It runs no hooks or external commands. Without full visibility of every process
(not root, or any unreadable `/proc` entry) it still writes the manifest, with `complete: false`
and the errors, which consumers treat as `unknown`. `--output` is a file path, not an output mode.

The host owner (for example a dotfiles systemd oneshot run as root before each hygiene plan and
apply) owns the output: the file and its directory are root-owned and not writable by the store
owner, but readable by it. The store owner admits it through `gc-config.json`
`generatedArtifacts.manifestPath` and `agentLivenessProducers: ["mr-process"]`. Plan and apply use
the manifest for foreign-process evidence and still inspect owner-UID processes freshly.
An unreadable owner-UID process is covered only when its current PID and kernel start-time
match a `processIdentities` entry in the unexpired root snapshot; the snapshot's full path
claims still apply. A new unreadable process, PID reuse, or missing, expired, foreign-host,
or incomplete manifest keeps every candidate.

Run as root, point `MEGAREPO_STORE` at the owner's store so the claims cover that store root.

### Merged worktree worklog teardown

Default `mr store gc` reads worklog disposition from the same strict budgets policy, referenced by
`$MEGAREPO_STORE/.state/gc-config.json`:

```json
{ "buildOutputBudgetsPath": "/etc/megarepo/build-output-budgets.json" }
```

No `buildOutputBudgetsPath`, no `worklog` in the policy, or `"teardown": "retain"` keeps today's
archive → reap lifecycle. A configured but unreadable or invalid policy fails the run. With
`"teardown": "delete"`, a merged worktree is removed together with its worklog instead of archived.
Teardown applies only when the cold classifier archives with reason `merged` (merged PR, grace
windows, live-set veto, lossless floor) and additionally HEAD is reachable from
`origin/<default>`, the worktree is registered once and unlocked, the worklog is untracked, Git
status is clean apart from the worklog, and ignored content outside it is rebuildable output. A
planning-time failed or unknown check falls back to archiving; a check failing under the lock keeps
the worktree. Parked, closed, or unmerged worktrees are never torn down. Under the worktree lock and the owner's deletion lease, the policy is reloaded and must
keep the same SHA-256, the live set is re-checked, admitted activity must be available and show
no agent, PTY, or process claim (unavailable activity keeps with `agent-liveness-unavailable`), the
strict cwd/root/fd/maps probe must pass (foreign processes covered by an admitted root snapshot),
and every teardown check is re-run; then the
worklog is measured, and one `git worktree remove --force` removes the worktree (force only covers
the proven worklog and rebuildable output; the branch ref is retained). The result reports
`status: "reaped"`, `reason: "merged-worklog-teardown"`, `worklogBytesRemoved` (allocated bytes,
estimated in `--dry-run`), `worklogPolicyPath`, and `worklogPolicySha256`.

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
