# `@overeng/buck2-tools`

Repository-owned TypeScript helpers for Buck dependency materialization,
TypeScript execution, and workspace editor views.

## Editor publisher

`src/editor-view.ts` atomically publishes and checks one dependency view.
`scripts/editor-view-authority.ts` derives the root source-generator consumer and
every package consumer from the canonical workspace registry, proves that Buck
owns each tracked manifest, builds every `:editor_view_inputs` manifest, and
invokes the publisher in deterministic order. Published snapshots byte-own the
finite provider-declared closure; no link points back into disposable
`buck-out`.

`buck2:editor:bootstrap` publishes only the dependency views named by the
committed generated root manifest so `genie:check` can run before trusting the
generated graph. After generation and composition, repository tasks
`buck2:editor:authority`, `buck2:editor:publish`, and `buck2:editor:check`
operate on the complete current registry. The exact-token
`buck2:editor:recover-lock` task recovers only the named consumer's shared
publication lock. These tasks require a real composed megarepo workspace and
are not global check dependencies.

Snapshot identity is computed from the admitted inputs and all declared roots
**before copying**. An unchanged publication validates and reuses the immutable
store entry without writing its payload. Literal symlink targets participate in
the input hash: a Buck artifact-path change is a new admission even when package
file bytes are unchanged, and therefore materializes a new byte-owned snapshot.

Repository tasks retain **current plus previous (two snapshots per view)**,
not two snapshots for the entire shared store. With `N` package views the bound
is `2 × N` completed snapshots, plus in-flight candidates. After the atomic
pointer flip, the publisher prunes only older, validated entries owned by that
view. Sibling views and candidates are never pruned. The preceding snapshot is
the rollback/read-overlap window; there is no process-reference lease registry
or idle-worktree collector. Retention runs only when that view publishes, so an
inactive worktree keeps its last published snapshots until it is reclaimed.

Snapshots deliberately own their Buck artifact bytes and remain usable after
`buck-out` is removed. They must not hardlink or symlink to disposable artifacts.

### Retired worktree removal

After closing editors and builds using a retired worktree, run
`devenv tasks run worktree:teardown --mode single` from that worktree. It stops
every Buck daemon isolation for the absolute checkout root, removes only its
isolation state, deletes its Watchman watch when the service is reachable, removes only
its root-keyed admission cache entries, invokes `buck2:editor:release`, and makes
remaining directories owner-writable without following symlinks or chmodding
files. Then leave its working directory and use ordinary `git worktree remove`
from another worktree. Teardown is offline and idempotent, does not delete
tracked files, and does not decide whether a checkout is eligible for removal.

Buck's absolute-path state hierarchy can contain descendant checkouts, even
inside a directory with direct daemon files identifying this checkout's isolation.
Before stopping that daemon, teardown refuses ambiguous contents with a nonzero
exit: subdirectories matching descendant paths, unknown subdirectories, symlinks,
or non-regular history entries. Only regular daemon files and Buck's shallow
`prev` history directory are cleared; isolation directories are never recursively
deleted. Sibling state is preserved, and the parent state directory is removed
only when empty. State paths must remain under the canonical Buck state base and
contain no symlinked components. The permission walk prunes nested Git checkouts,
worktrees, and megarepo member/composition boundaries before changing their modes.

Capability-profile Nix indirect gcroots are left alone: worktree removal makes
them dangling and Nix GC prunes them. Shared endpoint admission caches and other
checkouts are untouched. Consumers inherit the task through the shared setup,
check, clean, or worktree-guard module, or can explicitly import
`inputs.effect-utils.devenvModules.tasks.worktree-teardown`.

`devenv tasks run buck2:editor:release --mode single` remains available for
editor-only release, including every sibling view sharing those roots.

The publisher CLI also supports `release --repo-root <root> --package <package>`
for one shared editor root. Teardown holds the publication lock, refuses an
existing lock (including a stale one until exact-token recovery), and makes only
owned directories writable before removal. It never follows snapshot symlinks
or changes external dependency targets. Neither release nor teardown is ever a
dependency of setup, tests, or checks; republishing recreates a released root.

## Test collection

The JavaScript runner loads test modules when collecting their inventory without
executing assertions. Static parsing is opt-in: the runner passes an explicit
negative flag otherwise, rather than relying on the pinned Vitest CLI's default.
This includes cases registered by imported helpers such as rule-test generators.
