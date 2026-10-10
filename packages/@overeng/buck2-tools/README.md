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
store entry without writing payloads, pointers, retention records, or the package
manifest's editor-resolution signal. Declared links are hashed by their root
owner and relative destination, not the disposable Buck artifact path or literal
link spelling. Equivalent path relocations therefore reuse one generation;
changes to transitive workspace source, declarations, or dependency bytes still
select a new generation. Literal link inventories remain part of the admission
stability proof, so changing even an equivalent link while copying fails closed.

Batch publication prepares one private candidate at a time and serializes
commits within each editor state root. Independent root fingerprints within
that candidate still run concurrently. All fingerprint subprocesses
for a candidate settle before hardening, promotion, or failure cleanup can
change it. A failed fingerprint does not release the candidate or its state-root
lock while another payload walk remains active.

Unstable native fingerprints report the entry type, changed metadata fields,
and before/after metadata and link targets. Publication errors also report the
active workers' package, view, state root, phase, and private candidate. Payload
failures capture these states when the first fingerprint child fails, before
waiting for the remaining children; the original error remains available as
the cause.

Repository tasks retain **current plus previous (two snapshots per view)**,
not two snapshots for the entire shared store. The publisher's
`--snapshot-retention` option configures that total (2 through 32). Superseded
generations also receive a **five-minute grace period from supersession**,
configurable with `--snapshot-grace-ms`. A snapshot root's modification time is
lifecycle metadata recording its last supersession; it is not content identity.
Once the grace expires, publication prunes older validated entries owned by that
view, but never current pointers, state-root symlink targets, explicit reader
pins, or concretely process-referenced snapshots. Linux checks same-user
`/proc` executable, working-directory, descriptor, mapped-file, and entry-point
references; macOS uses its native `lsof` reader inventory. An unavailable
inventory backend defers collection. Permission-hidden or closed cached paths
require explicit reader pins; one unrelated language server does not prevent all
collection. Sibling views and in-flight candidates are never
pruned. The steady-state bound is the configured count per view; generations
within grace or protected by live references are intentionally additional.
Retention runs on publication, not on an idle-worktree background collector.

Editors that cache closed paths cannot be inferred from a kernel file inventory.
Pin the generation for the reader's lifetime, then remove the pin after closing
or refreshing that reader. For example, from `packages/.editor-view`:

```sh
mkdir -p .pins
ln -s "../$(readlink tui-core)" .pins/my-editor
# After the editor no longer uses that generation:
rm .pins/my-editor
```

Pins may target either a snapshot root or a path inside it. A later publication
collects unpinned, unreferenced generations after their grace has expired.

Snapshots deliberately own their Buck artifact bytes and remain usable after
`buck-out` is removed. Copies use reflinks when supported. New candidates share
regular-file payloads through a **host-shared content-addressed store**, across
views, editor state roots, generations, and worktrees. They never hardlink or
symlink to disposable artifacts. A payload key is its SHA-256 plus normalized
read-only mode: **0444 for data, 0555 when any source execute bit is set**.
Executables remain executable; write and special permission bits are removed.
Only the snapshot-root `editor-view.json` remains independent metadata; nested
files of that name are ordinary shareable payloads. Snapshot directories and
relocated symlinks remain private to each generation.

The default store is `.editor-view-content/v1` beside the common Git repository
directory, so every worktree uses the same host-local data. Non-Git fixtures use
`~/.cache/effect-utils/editor-view-content/v1`. Set `EDITOR_VIEW_CONTENT_STORE`
or pass `--content-store <path>` to select another store. Use a child directory
on the selected filesystem, not the mountpoint itself: the sibling control
files must be on that same device. The store cannot overlap an editor state
root. Existing immutable generations are validated and reused without rewriting;
new generations populate the shared store.

Store and shard directories are 0555 outside maintenance. Blobs are installed
atomically from fully written, read-only files; an existing key is never
truncated, overwritten, or chmodded into compliance. Admission rejects writable,
symlinked, wrong-owner, or mismatched blobs. A sibling exclusive lock coordinates
only short batches of hardlink/rename/unlink operations. Payload traversal,
hashing, and cross-device copying happen **outside that lock**, so independent
worktrees can prepare concurrently. An `EXDEV` destination keeps an independent
read-only reflink/copy and reports `copiedFiles` and `copiedBytes`; it does not
pretend to share an inode.

Collection runs after one publication, once per distinct store after a batch,
and after explicit release. Only validated blobs whose link count is **one**
(the CAS entry alone) are removed, with identity and link count rechecked under
the same short lock used by publishers. Current, retained, grace-protected,
pinned, and concrete-reader-protected snapshots keep their blob links alive.
Removing one worktree never chmods shared file inodes or removes another
worktree's linked payloads. A same-user mutation of a shared inode is a real
immutability violation for every owner, not silently repaired.

Manual maintenance uses the publisher CLI:

```sh
bun packages/@overeng/buck2-tools/src/editor-view.ts collect-content --repo-root "$PWD"
bun packages/@overeng/buck2-tools/src/editor-view.ts recover-content-lock \
  --repo-root "$PWD" --token <exact-token-from-the-lock-error>
```

These commands also accept `--content-store`. Live content-store owners are
waited for; a dead owner requires explicit exact-token recovery, never automatic
lock theft. Recovery removes only verified stale-token temporary links and
restores directory modes before releasing the lock. An existing recovery guard
fails closed, including after an interrupted recovery: first quiesce publishers,
prove the reported recovery PID is dead, restore only real store/shard
directories to 0555, and retire that exact guard before retrying recovery.

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
