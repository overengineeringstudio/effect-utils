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

Batch publication prepares up to four private candidates concurrently and
serializes commits within each editor state root. Fingerprint requests within
each TypeScript process queue one child at a time, including independent roots.
The native fingerprint library admits at most **four concurrent walks per host**
across Buck actions, publishers, worktrees, users, and executable versions that
implement this protocol. This is a fixed filesystem-pressure limit, not a CPU
count: CPU-scaled fan-out can livelock ZFS dnode lookup.

Admission uses persistent kernel file locks in
`/tmp/effect-utils-buck2-fingerprint-v1`, deliberately independent of `TMPDIR`
and worktree paths. Waiting processes block without polling. When all slots are
busy, a waiter releases the scan-admission lock and blocks on slot `pid % 4`,
spreading waiters across slots rather than placing every waiter behind slot zero.
A waiter may still wait while a different slot is idle. Descriptor closure
(including process death) releases capacity; no stale PID recovery is needed.
Native initialization prepares mode `1777` directories and mode `0666` regular
files under unique temporary names before publishing them: directories by
rename, files by no-replace hard link. Each private directory already contains its
usable admission file before publication, so a competing initializer cannot
replace an empty winner while another caller starts opening that file.
Permissions are set before publication, independent of umask, so concurrent
cold-start callers never see partially initialized modes. Losing initializers use
the winner's files and remove their
temporary entries. Sticky directory permissions prevent other users from
replacing an owner's files; the file bytes are unused. Existing modes are not
required to match exactly: the caller must be able to open the regular files
read-only and lock them. An actual access or lock failure names the affected
path and required sharing mode. Do not unlink the coordination directory or
files while any fingerprint process is alive. Buck's Linux action
launcher initializes the host files without truncation and mounts their directory
read-only into its otherwise private `/tmp`, so independent action sandboxes
share the same inodes without granting payloads permission to replace them.
Other mount namespaces must likewise expose this host directory; old tool
versions do not participate. Coordination errors fail closed before walking.

The coordination directory is deliberately **outside the action digest**. It
controls scheduling only: file contents are neither read as fingerprint inputs
nor written into digests or action outputs. Every admitted walk still hashes
the same declared roots and applies the same stability checks. Host contention
can change waiting time (or cause an explicit admission error), never the bytes
of a successful result. Including this host-local coordination state in the
action digest would destroy cache sharing without adding an output dependency.

All fingerprint subprocesses for a candidate settle before hardening, promotion,
or failure cleanup can change it. A failed fingerprint does not release the
candidate or its state-root lock while another payload walk remains active.

Unstable native fingerprints report the entry type, changed metadata fields,
and before/after metadata and link targets. Publication errors also report the
active workers' package, view, state root, phase, and private candidate. Payload
failures capture these states when the first fingerprint child fails, before
waiting for the remaining children; the original error remains available as
the cause.

Tree stability compares entry type, device, modification/change times, and
regular-file size. File and symlink inode identities remain checked; directory
inode numbers are not persistent on every filesystem and are not a content
stability signal. In particular, overlayfs without persistent inode mapping can
reassign a directory inode on cache eviction without changing its contents or
other metadata. Byte digests, link-target checks, and byte-ownership proofs are
unchanged.
Normal per-view retention keeps the current generation plus the configured
number of previous generations, a **five-minute grace period from supersession**,
and any **managed reader pins**. Repository tasks retain current plus one previous
generation (two snapshots per view), not two snapshots for the entire shared store.
The publisher's `--snapshot-retention` option configures that total (2 through 32);
`--snapshot-grace-ms` configures the grace. A snapshot root's modification time is
lifecycle metadata recording its last supersession, not content identity. Sibling
views and in-flight candidates are never pruned. Retention runs on publication,
not on an idle-worktree background collector.

Host-wide admission additionally defaults to **40,000,000,000 bytes** across the
shared CAS, private snapshot directories and records, source manifests, and
EXDEV copy fallbacks. `EDITOR_VIEW_HOST_BUDGET_BYTES` accepts a positive safe-integer
byte limit. Admission records the conservative materialization footprint before
creating a candidate, so cooperating concurrent publishers account for each
other's in-flight allocations. One user-owned **host-wide registry and ledger**
coordinates every registered content store, including independent Git common
directories; their CAS namespaces remain separate. State defaults to
`${XDG_STATE_HOME:-$HOME/.local/state}/effect-utils/editor-view-budget/v1`.
`EDITOR_VIEW_HOST_BUDGET_STATE` selects another private host-state directory.
All cooperating publishers must select the same host-state directory. Census
deduplicates shared inodes and counts the larger of logical size and nominal
allocated bytes (`st_blocks * 512`), including directories, symlinks, and control
metadata; this is conservative accounting, not compressed physical ZFS usage.
This ledger owns last-use, reservations, and rebuildable inode-footprint caches;
it is not a disposable payload shard. Obsolete footprint sidecars are reclaimed
with the corresponding generation's cached identity.

Under pressure, unreferenced CAS payloads and unused old generations are reclaimed
first, then least-recently-used current generations outside the five-minute grace.
Managed pins, positive cwd/fd/maps references inside the view root or its CAS
payload, and publication/use within the last 24 hours protect a view.
`EDITOR_VIEW_HOST_RECENCY_MS` configures that recency window in milliseconds.
Worktree-only process references and inaccessible `/proc` entries do not by
themselves protect a view; durable recency is the conservative stand-in.
The ordinary current-plus-previous policy is not an unconditional guarantee under host
pressure: pin a generation when it must remain available. Idle-current eviction
removes both the owned consumer hop and current pointer, records an eviction marker,
and the next explicit publication explains the eviction and cleanly republishes.
Each eviction round fixes one eligibility timestamp before observing readers,
including the fallback when a concurrent reservation consumes headroom. Crossing
grace or recency during the process scan cannot add an unobserved victim; a later
round observes newly eligible generations before retiring them. Retirement also
rechecks last-use and publication timestamps after acquiring the victim root lock
and CAS flock, so a newly used view cannot be evicted from an older census.
Vanished victims are skipped even if teardown removes a held eviction lock.
Active eviction locks are explicitly marked with process-incarnation
identity; a publisher waits for that live maintenance operation rather than
failing as if a competing publisher were present. New publication-lock owners
record host and process-start incarnation. An absent PID (`ESRCH`), or a reused
PID with a different observed start incarnation, permits automatic exact-token
recovery only on the recorded host; recovery is serialized by the host coordination flock and
logged. Live publishers, foreign hosts, unknown identities, unreadable owners,
and legacy records without host evidence still require explicit recovery.

If protected usage prevents reaching the budget, publication **continues** and
emits a structured `over-budget` event with budget, use, and top holders.
**No command fails because of the budget**, including explicit
`buck2:editor:materialize`, scoped publication, Genie freshness, and `check:quick`.
Budget discovery and maintenance failures are structured advisory diagnostics:
uncertain discovery aborts that budget round without eviction, and maintenance
failure never rejects an otherwise successful publication.
The `editor-view.host-budget` OpenTelemetry span records over-budget publication
and the protected-share early warning at 80%. Budget, publication, phase, and
watch-build spans share deferred, fire-and-forget, drop-on-full delivery, with at
most four queued/running exporters per process. Hung exporters are killed after
one second and keep their slots until reaped; publication and watch cycles never
await delivery, and telemetry never changes real command exit codes.
The `editor-view.phases` span records a nonzero exit code and error status when
publication fails or is interrupted. Successful publication and snapshot reuse
record exit code zero, independently of whether a snapshot was created.
The shared host ledger permits one budget span per content store and event kind
every 60 seconds, across publisher processes. Suppressed event counts
are durable and appear on the next admitted span as
`editor_view.host_budget.suppressed_events`; synchronous structured logs remain
unsuppressed and include `otelSuppressedEvents`. Existing ledgers without delivery
state retain their roots, reservations, and last-use history.
This is a pressure-driven idle/stale retention budget, not a hard cap on actively
protected bytes. Release readers or
unused views, or deliberately increase the byte limit; do not remove persistent
flock or reservation control files. Older publishers on other refs do not
participate in the protocol and must be quiesced or upgraded for coordinated
accounting and eviction.

The kernel census and shell-created symlinks are **advisory observations only**,
not guaranteed reader registration: a reference can appear after inspection,
process permissions can hide it, and editors can cache paths after closing files.
Linux observes same-user `/proc` executable, working-directory, descriptor,
mapped-file, and entry-point references; macOS uses native `lsof`. Local snapshot
retention matches observed pathnames: a shared payload hardlink may be reported
under another generation or the content store instead of the path used to open it.
Observed references and state-root symlink targets defer retirement, and an
unavailable inventory backend defers collection. None of those observations
replaces a managed pin for a reader that requires guaranteed retention.
Retention reuses the selected generation's full validation from the same publication.
Older protected generations receive only ownership and root-permission checks;
their complete permission proof runs outside the CAS flock before publishing the
new current pointer. A writable eligible generation rejects publication without
changing that pointer or retiring the invalid generation. Actual retirement and
post-commit cleanup remain advisory and log failures without rejecting a committed view.
When no unpinned generation is eligible, retention skips both the advisory process
census and the CAS flock. Every generation is still fully checked before reuse.

Register a managed pin **before using a generation**, and unpin only after closing
or refreshing that reader. From the repository root:

```sh
bun packages/@overeng/buck2-tools/src/editor-view.ts pin \
  --repo-root "$PWD" --package packages/@overeng/tui-core --name my-editor
# The command reports the admitted .store/tui-core-<digest> generation.
# To select an existing rollback generation, also pass:
#   --snapshot .store/tui-core-<64-hex-digest>
# After the editor no longer uses that generation:
bun packages/@overeng/buck2-tools/src/editor-view.ts unpin \
  --repo-root "$PWD" --package packages/@overeng/tui-core --name my-editor
```

`pin` defaults to the selected view's current generation; `--view-name` selects a
nondefault view. `--name` is a portable identifier without dots, up to 64 characters,
unique within the shared editor state root. Managed records are regular JSON files
at `.pins/<name>.json`, distinct from shell symlinks. Reusing a name atomically
retargets that pin, so first stop using its old generation. `unpin` is idempotent.
Both commands accept `--content-store`; use the same store as publication.
The exported APIs are `pinEditorView({ options, name, snapshot? })` and
`unpinEditorView({ options, name })`; `pinEditorView` returns the admitted pin record.

Pin admission validates the generation's name, ownership record, and existence
while holding the CAS store flock. Retirement inspects managed records and atomically
renames eligible generations out of their canonical names under that same flock;
recursive directory permission changes and payload unlinking happen afterward,
outside the flock. A pin that wins this race protects its generation; one that loses
fails instead of creating a dangling registration, even while private retired-tree
cleanup is still running. Cleanup failure rehardens owned directories outside the
flock before reacquiring it to restore any remaining canonical generations. Pin operations
take only the CAS flock, while publishers keep their explicit-token publication
lock and acquire CAS afterward; no path inverts that lock order. A later publication
collects unpinned generations once their retention and grace protection expire.

Snapshots deliberately own their Buck artifact bytes and remain usable after
`buck-out` is removed. Copies use reflinks when supported. New candidates share
regular-file payloads through a **host-shared content-addressed store**, across
views, editor state roots, generations, and worktrees. They never hardlink or
symlink to disposable artifacts. A payload key is its SHA-256 plus normalized
read-only mode: **0444 for data, 0555 when any source execute bit is set**.
Executables remain executable; write and special permission bits are removed.
Snapshot-root `editor-view.json` and `editor-view-sources-v1.json` remain private
metadata; nested files of those names are ordinary shareable payloads. Snapshot directories and
relocated symlinks remain private to each generation. Link containment resolves
a file through the link path, not the kernel's descriptor name: on Darwin,
realpath of a shared inode may report its content-store or sibling-snapshot name.

The default store is `.editor-view-content/v1` beside the common Git repository
directory, so every worktree uses the same host-local data. Non-Git fixtures use
`~/.cache/effect-utils/editor-view-content/v1`. Set `EDITOR_VIEW_CONTENT_STORE`
or pass `--content-store <path>` to select another store. Use a child directory
on the selected filesystem, not the mountpoint itself: the sibling control
files must be on that same device. The store cannot overlap an editor state
root. Existing immutable generations are validated and reused without rewriting;
new generations populate the shared store.
Only host-local filesystems are supported; **NFS and SMB content stores are
unsupported**. Kernel flock and local inode/link-count semantics are part of
the cooperative same-user contract, not a distributed locking protocol.

Store and shard directories are 0555 outside maintenance. Blobs are installed
atomically from fully written, read-only files; an existing key is never
truncated, overwritten, or chmodded into compliance. Admission rejects writable,
symlinked, wrong-owner, or mismatched blobs. A persistent sibling
`${contentStore}.flock` file coordinates short metadata transactions with the
kernel's exclusive `flock`; **the lock file is never unlinked**. Payload traversal,
hashing, and cross-device copying happen **outside that lock**, so independent
worktrees can prepare concurrently. Cross-device store copies use owner-identified
`.staging/<pid>-<starttime>-<uuid>.tmp` files, with directory write permissions changed
only under the flock. An `EXDEV` destination keeps an independent read-only
reflink/copy and reports `copiedFiles` and `copiedBytes`; it does not pretend to
share an inode.
Cross-device fallback is selected only when an actual hardlink returns `EXDEV`,
not by comparing file and directory device numbers: overlayfs may report
different device identities for those entries while hardlinks still work.
Required store-side copies are prepared after releasing the flock, then installed
in a short retry batch under the same lock.
The descriptor is opened with `O_CLOEXEC` and verified close-on-exec; children
cannot retain a parent's ownership. Bun FFI calls libc on Linux and macOS.

Admission groups at most 128 files per shard into a metadata transaction, avoiding
reopening most shards for each batch. Pending shard queues retain at most
256 × 128 file records, not payload bytes. Small-file SHA-256 work uses four
bounded native crypto jobs; larger payloads stream. Immutable inode verification
is memoized by device, inode, size, nanosecond modification time, mode, and owner
in a bounded 65,536-entry process cache; ctime is required except for read-only
shared inodes. Unchanged generation identities skip CAS hashing and linking
entirely. Buck's JSON build output supplies paths, not
per-file digests; its private materializer database is not an admission contract.

Each finite generation keeps a private, read-only `editor-view-sources-v1.json`
manifest mapping payload paths to source stat keys and SHA-256-plus-mode addresses.
Incremental materialization links unchanged content directly from the CAS after
rechecking its recorded inode identity under the store lock. Only source-stat
misses are copied and hashed; source Buck inodes are never linked. Stat keys
include device, inode, size, nanosecond modification time, mode, and owner;
ctime is also required except for read-only shared source inodes. The complete
admitted-source versus candidate payload proof remains mandatory, so the manifest
is an optimization hint, not a substitute for integrity validation.

Collection runs after publications that create or unlink snapshot payloads, once
per changed store after a batch, and after explicit release. A genuinely unchanged
publication still evaluates retention, but skips a redundant CAS census when it
unlinks nothing. Only validated blobs whose link count is **one**
(the CAS entry alone) are removed, with identity and link count rechecked under
the same short flock used by publishers. Current, retained, grace-protected,
managed-pinned, and advisory-reference-protected snapshots keep their blob links alive.
Removing one worktree never chmods shared file inodes or removes another
worktree's linked payloads. A same-user mutation of a shared inode is a real
immutability violation for every owner, not silently repaired.

Manual maintenance uses the publisher CLI:

```sh
bun packages/@overeng/buck2-tools/src/editor-view.ts collect-content --repo-root "$PWD"
```

`collect-content` also accepts `--content-store`. Live content-store holders are
waited for, and the kernel releases ownership automatically when a holder exits
or crashes. Every acquisition repairs interrupted metadata work under the flock:
real store directories are rehardened to 0555, recognized shard-local temporary
files are removed, and `.staging` files belonging to dead process identities are
removed. Linux identities use numeric `/proc/<pid>/stat` field 22 and the boot ID;
macOS probes `ps lstart` with an otherwise empty environment, `TZ=UTC`, and `LC_ALL=C`.
Its one-second resolution can conservatively retain an orphan after same-PID,
same-second reuse; it never deletes a concretely protected staging copy.
Unknown-owner staging files are removed only after five minutes. No exact-token
content-store recovery command, owner record, watcher, or recovery guard remains.
The separate per-view publication lock automatically recovers only proven dead
or reused same-host owners; all uncertain ownership retains explicit exact-token recovery.
The persistent control file records a dirty byte before repair/mutation and clears
it only after successful restoration. Normal acquisitions inspect the bounded
directory set and staging metadata; dirty acquisitions also scan shard metadata
for abandoned temporary links. Repair never rewrites or chmods payload inodes.
The dirty byte provides **process-crash recovery, not power-loss durability**:
metadata/control writes are not fsync-ordered for machine or filesystem failure.
Five-minute eviction of unknowable-owner staging files is an **availability
tradeoff**: it may interrupt a live copy whose identity cannot be established,
making that publication fail/retry rather than retaining its staging inode forever.

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
for one shared editor root. Teardown holds the publication lock, refuses a live
or uncertain owner, automatically recovers proven abandoned same-host owners,
and makes only
owned directories writable before removal. It never follows snapshot symlinks
or changes external dependency targets. Neither release nor teardown is ever a
dependency of setup, tests, or checks; republishing recreates a released root.

## Package action capabilities

`package_bin_artifact` builds portable JavaScript bundles without a fingerprint
executable, manifest, or `--fingerprint-tool` argument. Bundle parsing rejects
that argument rather than silently accepting an unused capability. Its inputs
remain the declared package tree, closure roots, runner closure, Bun toolchain,
and platform-gated package manifest; bundling does not execute the entrypoint.
The subsequent compiled-product action likewise consumes the portable module
without invoking the fingerprint tool.

Non-bundle package execution (`exec`, `check`, `native-check`, and `build-dir`)
still requires an explicitly declared immutable `/nix/store/.../bin/buck2-fingerprint`
executable and fingerprints its declared read roots before and after the child
process to reject source mutation. TypeScript emit and typecheck retain the same
real fingerprint requirement. There is no ambient-tool lookup or no-op fallback.

The generated native, compiled, and cache product inventories carry
`buildCapabilities` and `linuxBuildCapabilities`, derived by
`genie/buck2/product-capabilities.ts` from their rule kinds. The cache publisher
validates both lists as sorted, unique capability IDs before source access or
credentials; Linux-only capabilities must not duplicate host-neutral ones.
Nix projects only those producer realizations and their transitive store closures. Tools absent from a scoped projection are absent Buck targets;
requesting one fails analysis rather than falling back to the development
shell. `nix/buck2-products/capability-closure.test.sh` checks a real native
product with its declared packager, then proves omission rejects that target.

Native and compiled imports use independently projected source paths and a
separate Buck root, without commit-addressed provenance. The independent
`buck2-fingerprint` crate does not enter the shared packager/archive helper
crate or the events tool's stage-zero source fileset. Npm products retain
fingerprint because their emission/typecheck prerequisites execute it.

## Test collection

The JavaScript runner loads test modules when collecting their inventory without
executing assertions. Static parsing is opt-in: the runner passes an explicit
negative flag otherwise, rather than relying on the pinned Vitest CLI's default.
This includes cases registered by imported helpers such as rule-test generators.

## Bun wall deadlines and failure classification

Repository devenv Bun test tasks and Buck Bun lanes share `src/bun-test-runner.ts`.
The CLI accepts Bun's explicit `test` command followed by its source paths and flags:
`bun ./src/bun-test-runner.ts test ./src/`. Use explicit relative source directories
instead of substring filters so discovery does not include Buck's staged copies.

At run start it samples the one-minute host load and the CPU parallelism available
to the process. The CLI default and explicit per-test deadlines use:

```text
effective = ceil(base × min(cap, max(1, load1 / cpus)))
```

If `load1` or `cpus` is missing, non-finite, or `<=0`, the factor is `1`;
otherwise the formula above applies.

`BUN_TEST_TIMEOUT_CAP` sets the cap (default `4`, finite and at least `1`);
`BUN_TEST_TIMEOUT_SCALING=0` disables scaling. Buck lanes can declare these as
environment inputs; local external-test runs also accept the caller's environment.
The factor stays fixed for the run. A shared preload intercepts native Bun test
registration, including parameterized tests and modifiers, to scale explicit
deadlines and record each case's base. Expanded case titles and nested parameterized
suites retain their own deadlines in JUnit classification. Hooks, assertions,
callbacks and exit statuses remain native; no tests are retried.

The wrapper requests Bun's JUnit reporter and leaves console output untouched.
After the child exits, it samples host load and Linux memory PSI and emits one
`test-timeout-under-load` line for each JUnit `TimeoutError`, including the test
identity, base, factor, effective deadline, measured JUnit elapsed milliseconds,
load, CPU count and `memPsiFullAvg10` (`unavailable` outside Linux or without PSI).
`test-failure-summary` counts timeout, assertion and other failures separately.
Self-closing passing records and skipped cases are consumed individually, so a
later failure keeps its own test identity, elapsed time and registered deadline.
Attribute boundaries are quote-aware: literal `>` and `/>` in test names or failure
messages are data, not tag delimiters.
“Under load” is a diagnostic category, not proof that load caused the timeout.
Reports live in executor results for Buck and disposable scratch for direct tasks.

Bun's inspector reporter protocol can stream lifecycle events, but would require
a debugger connection. Its ordinary lifecycle/preload hooks do not expose failure
results or deadlines. JUnit provides typed outcomes and measured durations without
parsing stdout, changing assertion semantics or opening a debugger port.
