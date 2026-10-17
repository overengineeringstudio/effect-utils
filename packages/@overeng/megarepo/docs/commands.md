# Commands Reference

All commands support `--output json` or `--output ndjson`.

## Core Commands

### `mr fetch --apply`

Fetch configured refs, reconcile the workspace to `megarepo.kdl`, and write the new lock.

```bash
mr fetch --apply [--force] [--all] [--only <members>] [--skip <members>] [--create-branches] [--dry-run]
```

Behavior:

1. Resolve members from `megarepo.kdl`
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

This expects the workspace to already be reconciled to `megarepo.kdl`. If a member symlink points at the wrong ref, it is skipped with a hint to run `mr fetch --apply`.

### `mr apply`

Apply the exact commits from `megarepo.lock`.

```bash
mr apply [--force] [--all] [--only <members>] [--skip <members>] [--dry-run]
```

This is the reproducible CI mode. It requires a non-stale lock file and materializes commit worktrees.

With `--worktree-mode tracking`, a canonical branch worktree is reused only
when its branch identity matches, its tree is clean, and `HEAD` equals the
lock commit. Otherwise the member mounts `refs/commits/<lock.commit>`.
Ahead, behind, and dirty canonical branches are never fast-forwarded, reset,
or checked out; their files and edits are preserved without requiring `--force`.
`mr status` reports divergent or dirty tracking mounts as apply-needed, and a
warm apply is ready after selecting the exact-commit fallback.

Member lock rewrites are opt-in with `--lock-sync=direct` or `--lock-sync=recursive`.
Lock sync refuses shared canonical worktrees under `refs/commits/*`, `refs/heads/*`,
and `refs/tags/*`, including symlinked targets, before rewriting any member.
The invoking non-default author branch workspace, proved from Git worktree
metadata, may materialize `repos/` and author its own config, `megarepo.lock`,
generator outputs, and Nix lock files. Pin/unpin and `mr fetch --only` use the same
author-workspace grant. Requested paths and physical destinations must remain
inside that workspace; symlink escapes, including a symlink followed by `..`,
stay refused. Default-branch canonical
worktrees remain shared caches; invoking a command there does not grant ownership.
`mr apply --verify-shared --lock-sync off` verifies selected members read-only in
shared canonical workspaces, and otherwise applies normally. Every selected mount
must be a symlink to its configured local source or the correct store repository
and locked ref/commit, with remote `HEAD` at the locked commit and clean tracking
branches. Commit-member selectors apply the same source-identity checks to every
mount in their nested locked trees. Missing, dirty, or drifted
members fail with instructions to prepare from the owning workspace or use an
owned worktree. No generators, lock sync, registry, or cache-manifest writes run
on this read-only path. `mr:setup` uses this mode. It respects `--only`/`--skip`,
requires lock sync off, and cannot be combined with `--all`.
With `--all --lock-sync=off`, recursive apply may also materialize `repos/` in
commit worktrees freshly created by the same invocation under the worktree lock.
That permission covers only the recorded physical root and its mount directory:
pre-existing canonical roots, escaped symlink destinations, and authoring outputs
remain protected. It is not retained across invocations or granted to tag/branch
members. Config, lock, and generator writers never receive this permission.
Use `--lock-sync=off` to materialize members without changing their lockfiles.
Shared canonical caches retain file-write protection; branch/ref switching and
destructive canonical Git operations remain protected even in author workspaces.
`MEGAREPO_ALLOW_CANONICAL_MUTATION=1` is an explicit administrative override;
other values do not authorize writes.

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

- `applyNeeded`
- `lockNeeded`
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
mr store gc [--dry-run] [--force] [--all] [--generated-artifacts]
mr store gc [--generated-artifacts] --expected-plan <sha256> --candidate-path <absolute-path>
```

Removes clean unrooted `refs/commits/*` worktrees. Named `refs/heads/*` and
`refs/tags/*` worktrees are kept by default. Dirty worktrees are preserved
unless `--force` is used. `--all` also considers named refs for removal.

Dry-run output includes a canonical `planSha256`. Supplying that digest with one
candidate path recomputes the complete plan and applies only the selected
worktree, archive, or generated-artifact action after an owner-locked
revalidation. Missing, ambiguous, changed, or unknown evidence refuses the
application.

Every plan-bound deletion — generated artifact, whole worktree, archive reap —
additionally holds the lease for its owner path, so an activation wrapped in
`mr store lease` can never be overtaken.

### `mr store lock`

```bash
mr store lock [--clone-target] <path> -- <command> [args…]
mr store lock /path/to/worktree -- git -C /path/to/worktree fetch origin
mr store lock --clone-target /path/to/repo.bare -- git clone --bare URL /path/to/repo.bare
```

Runs an external canonical Git writer with inherited stdin/stdout/stderr and
propagates its exit status. `<path>` may name a bare repository, a normal
repository, a linked worktree, or a missing clone target whose parent exists.
The command's working directory is unchanged; pass `git -C` or `--git-dir`
explicitly when needed.

On Linux and macOS, writers cooperate through one host-local kernel `flock`
per real Git common directory, shared with mr's own Git writers. Symlink aliases
and linked worktrees share the same lock; different repositories remain parallel.
The persistent lock file is `<resolved-common-dir>.mr-writer.lock`; never delete
it, including after a crash. Ownership ends when the last inherited descriptor
closes, not when the file is unlinked. The external command inherits the lock,
so killing the mr wrapper does not unlock a still-running command. For bare
clone admission, pass `--clone-target`: the real parent plus target basename
determines the same identity before creation, during partial initialization,
and after the bare clone. The clone command must recheck existence under the lock.
The wrapped command must preserve inherited fd 3 until its canonical writes finish.

Nested acquisitions are unsupported: wrap only the external leaf Git write,
not an mr workflow that takes the same lock internally. This is cooperative
host-local coordination, not a distributed lock or protection from unwrapped Git.
Read-only freshness consumers should use private Git metadata instead. If they
deliberately fetch into shared metadata, suppress configured ref mapping with
`--refmap=` and isolate `FETCH_HEAD` writes (`--no-write-fetch-head`); a custom
destination ref alone does not prevent origin's configured refmap from updating
canonical remote-tracking refs.

### `mr store lease`

```bash
mr store lease --owner-path <path> -- <command> [args…]
```

Runs the command while holding the deletion lease for one store worktree and
propagates its exit code. Wrap workspace activation with it: acquire before the
first worktree write, publish the agent-liveness manifest inside, and the lease
is released when the command exits. If reclamation holds the lease, the wrapper
fails instead of racing it.
