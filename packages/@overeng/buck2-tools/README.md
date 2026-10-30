# `@overeng/buck2-tools`

Repository-owned TypeScript helpers for Buck dependency materialization,
TypeScript execution, and workspace editor views.

Lease retirement integration fixtures use the production filesystem classifier
to select `os.tmpdir()`, falling back to `/dev/shm` when necessary. They fail
explicitly if neither supports local lease semantics; OverlayFS remains unknown
and fail-closed. Editor roots and CAS data share the selected filesystem, while
executable telemetry helpers stay in `os.tmpdir()` because `/dev/shm` may be
mounted `noexec`. Shell teardown fixtures call the same TypeScript data-root
selector. The full `test:buck2-tools` and `devenv-modules:test` tasks also run in
the PR-only `pr/buck2-tools` job on the Linux namespace runner, without duplicating
the merge-group test lane.

Source consumers install the bootstrap lease preload as
`preload-<sha256>.cjs` in a private `editor-view-lease` runtime directory:
`$XDG_RUNTIME_DIR` on Linux, the per-user `$TMPDIR` on macOS, or
`$HOME/.cache` as fallback. This avoids Bun enumerating large store ancestors
while resolving every child preload. Each candidate is resolved to its real path;
every ancestor must be root- or current-user-owned, with no group/other write
permission unless sticky. Unsafe candidates, including paths requiring runtime
option quoting, are skipped in favor of the fallback. If none qualifies, launch
fails closed. Each launch also checks the private directory owner and permissions and
verifies the regular file's owner, read-only mode and hash against the store
source before exporting its resolved path. Inherited forwarding rejects unsafe
path characters too. Concurrent first launches publish atomically;
an existing mismatched file fails closed rather
than being silently repaired. Remove only the reported invalid preload after
investigating its provenance, then launch again.

## Editor publisher

`src/editor-view.ts` atomically publishes and checks one dependency view.
`scripts/editor-view-authority.ts` derives the root source-generator consumer and
every package consumer from the canonical workspace registry, proves that Buck
owns each tracked manifest, builds every `:editor_view_inputs` manifest, and
invokes the publisher in deterministic order. Published snapshots byte-own the
finite provider-declared closure; no link points back into disposable
`buck-out`.

`genie:check` directly depends on `buck2:editor:bootstrap`: source-side generator
freshness needs the root dependency view before trusting the generated graph.
Bootstrap publishes only `.` and `packages/@overeng/otel-contract`, never the
whole workspace. After generation and composition, repository tasks
`buck2:editor:authority`, `buck2:editor:publish`, and `buck2:editor:check`
operate on the complete current registry. The exact-token
`buck2:editor:recover-lock` task recovers only the named consumer's shared
publication lock. These tasks require a real composed megarepo workspace and
are not global check dependencies.

Multi-consumer aggregates avoid serially queueing one publisher per package:
`storybook:build`, `storybook:test`, `netlify:stage`, `netlify:deploy`, and
`test:notion-integration` each select one exact-scope batch publisher.
The two Netlify aggregates share the same 13-consumer preview batch (all configured
Storybooks except `tui-stories`); the complete Storybook build selects 14 consumers,
and play tests select only the packages declaring `playTests`.
Aggregate-only execution aliases reuse the final standalone command, cwd,
environment, status, and freshness predicates, replacing only installer edges.
Standalone package tasks keep their single-consumer publisher and never acquire
the aggregate's wider package set. Existing batch publication acquires each
state-root lock once and prepares up to four consumer views concurrently.

Bootstrap and ordinary scoped publication keep their **300 s execution deadline**.
The non-required `storybook:build`, `netlify:stage`, `netlify:deploy`, and
`test:notion-integration` batch publications have **no total deadline**.
On dev5, cold publication of 13 consumers takes about 25–30 minutes and a single
consumer's verification can take 670 s; the previous 944 s Netlify cap killed
healthy work. These batches retain supervisor ownership and emit per-phase JSON
progress with `package`, `phase`, and `elapsedMs`.

Only `storybook:test` retains its derived **380 s** publication cap:

```text
deadlineSeconds = ceil(sum(measuredSeconds or maxMeasuredFallbackSeconds) / 4)
                  × 4 preparation headroom + 120 build/authority allowance
maximumSeconds = 1200
```

The measurements come from `genie/ci-workflow/test-scheduling.json`'s
`editorViewSeconds` (`baselineRun: 37886131764`). The four play-test consumers
currently use the maximum measured fallback of 65 s each (260 s total), because
`effect-schema-form-aria`, `effect-rpc-explorer-react`, `devbar`, and `meters`
have no measurements. The four workers match `publishEditorViews`.
Only this capped batch embeds budget inputs and missing-consumer metadata;
the graph guard independently recomputes its deadline and checks that all other
aggregate publications remain uncapped.

There is no no-progress watchdog: the supervisor currently inherits child output
rather than reading it. Safely forwarding and parsing streams without blocking
on partial lines, handling EOF and descendant-held pipes during cancellation,
and testing those lifecycle paths exceeds the small-change threshold. A future
watchdog would incrementally inspect forwarded JSON lines, reset one named 600 s
window only on `package`/`phase` progress, and use the existing process-group
TERM/KILL cleanup on expiry, with separate handling for queued lock admission.

Scoped devenv publishers retain their explicit consumer sets; Storybook builds do
not publish the whole workspace. Different `packages/@overeng/*` consumers still
share `packages/.editor-view/.publish.lock`, so task invocations queue on the
per-worktree `.devenv/editor-view-publication.lock` before authority/build/publish.
The supervisor uses a blocking kernel `flock`, without polling or lock theft,
with a **5 s kill grace** on interruption or deadline expiry. The execution clock
starts only after admission: scoped/bootstrap work keeps its 300 s cap and
Storybook play tests keep their derived 380 s cap, excluding queue time.
Each admitted invocation logs the lock path and admission wait in seconds.
Signals still cancel queued waiters and identify the lock they were waiting for.
Uncapped batches have no execution deadline. On Darwin, process-group EPERM is
treated as termination only after a process census proves no live members remain;
live-member permission failures still fail closed. The supervisor retains ownership through
process-group cleanup; process exit releases it automatically. The persistent
flock file must not be unlinked while publishers are active.

This deliberately serializes task invocations, not private candidates within one
batch, and never adds unrelated package views to a standalone request. It leaves
the publisher's state-root lock and exact-token recovery contract unchanged for
direct CLI/API callers. The admission lock precedes all state-root and content-store
locks, so it does not change their ordering. Per-package publication locks would
not protect shared state-root inventory, pointer commits, and retention metadata.

Snapshot identity is computed from the admitted inputs and all declared roots
**before copying**. An unchanged publication validates and reuses the immutable
store entry without writing payloads, pointers, retention records, or the package
manifest's editor-resolution signal. Declared links are hashed by their root
owner and relative destination, not the disposable Buck artifact path or literal
link spelling. Equivalent path relocations therefore reuse one generation;
changes to transitive workspace source, declarations, or dependency bytes still
select a new generation. Literal link inventories remain part of the admission
stability proof, so changing even an equivalent link while copying fails closed.

Root publication also converges the authority manifest's package-local dependency
topology: real `node_modules` directories identified by a regular `.modules.yaml`
or dependency symlinks into the root `node_modules/.pnpm` store are renamed into
`.editor-view/.legacy/importer-*` before root first-hop cutover. Their bytes are
retained, not deleted; unselected importers then use normal parent resolution
through the root view. Existing first-hop symlinks are never traversed or moved.
Unidentified real directories fail publication before changing the root pointer.
Move the named directory outside the workspace (or delete it only after confirming
it is cache-only), then rerun bootstrap. Retirement also recognizes already-dangling
pnpm links, so rerunning bootstrap repairs old residue.

Root publication locks its own state root first, then all affected package state
roots in byte-sorted order before inspecting importer directories. A batch acquires
the complete ordered lock set before starting workers and reuses its locks.
An existing package publisher lock fails root publication without moving importers;
retry after that publisher finishes (recover abandoned locks using the reported
explicit recovery command).

Retired importers remain in the repository-root `.editor-view/.legacy/importer-*`;
the old root install is retained alongside them as `node_modules-*`. After a
successful bootstrap and once those old installs are no longer needed for recovery,
inspect the retained entries and manually remove only the unwanted entries from
`.editor-view/.legacy`. Publication does not automatically garbage-collect this
legacy state. Do not remove live `.editor-view/.store` generations or first hops
as part of legacy cleanup.

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

The native CLI's explicit `--admission-directory` option and the publisher API's
`admissionDirectory` parameter select an **isolated admission domain** for tests
and isolated fixtures. Production callers must not set them: the default remains
the host-wide directory above, with no environment or config override. Host-budget
integration fixtures share one private four-slot domain per fixture host, so
their policy races cannot queue behind unrelated production fingerprint walks.
Their hashing, filesystem copies, process evidence, and five-second deadlines
remain real and unchanged.

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
Normal per-view retention selects the current generation plus the configured
number of previous generations and a **five-minute grace period from supersession**.
Repository tasks configure two snapshots per view; `--snapshot-retention` accepts
2 through 32 and `--snapshot-grace-ms` configures grace. These are eligibility
policies, not permission to delete. Both retention and host-budget retirement
also require clear reader evidence and a generation's exclusive lease.
**A complete legacy scan that detects an unmanaged reader disables automatic
generation eviction for that root.** Roots are not presumed unmanaged. An
incomplete scan remains unknown and cannot authorize deletion; a clear root still
requires a fresh fenced proof and exclusive generation lease. Positive legacy
references are conservatively unmanaged unless reader ownership is proved.

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
Batch publication shares one in-flight census across workers and admission retries.
Reuse is keyed by host ledger, root identity, and content store; a worker missing
from the measured roots/stores takes a fresh census before admission.
Every fit decision still reads outstanding reservations and later publication
estimates under the host ledger flock. Collection, eviction, or a stale journal
invalidates the shared census. Fitting reservations do not scan live readers,
including above the 80% warning threshold.

Under pressure, unreferenced CAS-only payloads are reclaimed first. Generation
eviction requires complete applicable legacy reader evidence and a nonblocking
exclusive generation lease. Pins, held leases, positive legacy references,
incomplete evidence, recency, and grace protect candidates.
`EDITOR_VIEW_HOST_RECENCY_MS` configures the default 24-hour recency window.
Inaccessible same-user `/proc` observations are **unknown**, not evidence of
inactivity; another namespace or an outside cwd does not prove that a process
cannot reach a view through aliases or retained directory handles.
Only clear candidates may enter a destructive plan. Before retirement the
census is retaken, then journal epoch, generation identity, pointers, pins,
reader evidence, recency, and lease identity are rechecked under root → host →
owning-CAS exclusion. Eligibility stays fixed at the round's initial timestamp
and refreshed plans may select only reader-observed keys. A pointer removed
during locking cannot expose an unobserved orphan to deletion. The per-candidate
pre-delete seam independently rejects unobserved keys and takes a nonblocking
exclusive generation lease; held candidates are skipped, never waited on.
Exclusive leases remain open through rename and actual payload cleanup,
including deferred shared-batch cleanup; cleanup failures close descriptors
without explicitly unlocking shared inherited descriptions.
Reader-protected accounting is refreshed even if an epoch mismatch skips a
batch. Retirement rechecks last-use and publication timestamps, so newly used
views cannot be evicted from an older plan. Payload immutability is required.
Vanished victims are skipped even if teardown removes a held eviction lock.
Active eviction locks are explicitly marked with process-incarnation
identity; a publisher waits for that live maintenance operation rather than
failing as if a competing publisher were present. New publication-lock owners
record host and process-start incarnation. An absent PID (`ESRCH`), or a reused
PID with a different observed start incarnation, permits automatic exact-token
recovery only on the recorded host; recovery is serialized by the host coordination flock and
logged. Live publishers, foreign hosts, unknown identities, unreadable owners,
and legacy records without host evidence still require explicit recovery.

Orphan reachability includes package `node_modules` symlinks under hidden directories,
`repos`, `dist`, `result`, and `buck-out`, not just ordinary source directories.
The package inventory walks real directories without following directory symlinks.
It prunes real `node_modules` payloads, Git metadata, and editor roots' payload
stores (their control pointers have a separate inventory), but inspects each
entry before pruning so package `node_modules` symlinks remain visible.
The package walk is bounded to 200,000 entries. Unreadable or oversized inventories
are unknown and keep orphan payloads, never evidence that pointers are absent.
Only candidate-bearing roots request this inventory: census adoption does so
for actual `.legacy` entries, and eviction planning does so lazily for potentially
eligible orphans. Ordinary generation-only roots never trigger a package walk.
Each census/planning invocation caches at most one inventory per such root and
emits a `pointer-inventory` aggregate with root count, entry count, total duration,
and per-root entries/durations. Retirement repeats the selected orphan root's
reachability proof at its deletion fence.
Startup cleanup carries normal-acquisition or proven-dead-owner-recovery
provenance and validates the held lock path, exact per-acquisition token, current
PID, host, and process-start incarnation (including the Linux boot identity).
Unknown identities refuse reclamation. Normal acquisition follows the previous
holder's release; automatic recovery proves the previous holder dead. Missing or
mismatched proof refuses reclamation. Every startup candidate and interrupted
`.gc-*` payload also receives a fresh reader observation, preserving stale cwd/fd
holders as well as pointer targets.

If protected or unknown usage prevents admission, publication fails **before
materialization** with `EditorViewCapacityError` (`EDITOR_VIEW_CAPACITY`).
This replaces the previous force-admit/publish-anyway fallback. The bounded
diagnostic reports budget, measured and requested bytes, protected generation
count, and actionable blockers; it deletes no unknown candidate. Explicitly stop
unmanaged sessions and release idle worktrees/pins, or deliberately raise
`EDITOR_VIEW_HOST_BUDGET_BYTES`. Admission/discovery failures are not swallowed.
Post-commit maintenance failures remain advisory and do not undo a valid view.
Reserve start, work reasons, and grant durations use the `[editor-view-budget]`
prefix and are forwarded live by both single and batch publication. Forwarding
buffers partial stderr lines until their terminating newline, independently of
child-process chunk boundaries. Phase records explicitly distinguish entry from
completion and include completion durations.
Census completion records use `event: "completed"`, `stage`, and monotonic
`durationMs`, with aggregate counts for root discovery, generation enumeration,
sidecar reads (hits, misses, bytes), footprint walks on misses (walks, linked
bytes), sidecar staging, CAS accounting, linked-inode merge (entries and distinct
entries), sidecar installation, and fenced admission. Enumeration time excludes
the separately measured reads, walks, and staging; records are per census or
admission attempt, never per generation. Installation and admission durations
include waiting for the host ledger fence.
The structured `over-budget` event and `editor-view.host-budget` span record
rejected admission with nonzero exit status, alongside the protected-share
early warning at 80%. Budget, publication, phase, and
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
The admission limit does not revoke existing reader protection. Release readers
and explicitly retire unused views, or increase the limit; never remove persistent
flock controls to manufacture capacity. Older publishers on other refs must be
quiesced or upgraded before using coordinated accounting and eviction.

Each generation owns a private persistent sibling control at
`<editorRoot>/.leases/<generation>.lock`. Publication/backfill creates and
validates it under CAS exclusion. Readers resolve the generation and validate
its control inode **inside that fence**, acquire `flock(LOCK_SH)`, and only then
read/import sources. The packaged native launcher is bootstrap-safe: it does not
load lease code from an evictable view. Deliberately mapped lease descriptors
remain in source-reading server/worker descendants; parent death is not release
while a child retains an open description. Normal and error cleanup closes
descriptors, never `LOCK_UN`. The unrelated CAS descriptor stays close-on-exec.
Unvalidated control paths are opened nonblocking and close-on-exec before the
regular-file and identity checks, so an unsafe FIFO without a writer cannot
stall reader classification or hold up the host fence.
The same native package supplies fixed-arity `eu_getfd` and `eu_dupfd_cloexec`
FFI entrypoints. Variadic libc calls must stay inside C: Darwin arm64 passes
variadic arguments differently from fixed-arity FFI arguments. The immutable
library path is inherited even when a child replaces its environment.
Leaf readers retain their inherited descriptors without loading a native spawn
binding; the Bun FFI binding is initialized only when that process actually
spawns a descendant. This avoids unnecessary per-leaf startup compilation.
Missing controls are backfilled lazily by readers, publishers, or retirement,
only after generation validation under the owning CAS fence. Creation uses a
private exclusive regular file in the validated `.leases` directory; existing
unsafe or replaced controls are never repaired. Readers then acquire a shared
lease before leaving exclusion. Retirement must obtain an exclusive lease before
deleting payloads. Read-only planning reports missing controls as
`no control (clear under fence)`.
Lease discovery, acquisition, or bookkeeping failures in the native launcher
degrade to unknown evidence without stopping the target program: its arguments,
stdio, and exit status remain unchanged. Unsupported filesystems (including
OverlayFS) are not treated as local and do not gain lease controls or CAS fences.
This launch availability policy does not authorize deletion: retirement remains
fail closed on unknown evidence and still requires a validated exclusive lease
under the owning CAS fence.
The publication supervisor intentionally closes descriptors outside its own
admission protocol. It removes inherited lease mappings and the active marker
from its child's environment; the child source launcher discovers fresh leases.
It never adds parent leases to `pass_fds`. A stale mapping reaching the native
launcher is diagnosed as unknown, removed, and never re-exported to descendants.
The launcher leases the generations reachable at launch and keeps those leases for the process lifetime. It does not refresh leases when a pointer moves later.
The admitted set is explicitly passed to source-reading descendants.
It does not intercept every future filesystem read or freeze moving `node_modules`
pointers. Launch descriptors do not cover later moving-pointer opens. Legacy
reader evidence therefore remains mandatory for every root; external readers
requiring guaranteed retention must register persistent pins before use. Dynamic
refresh and external editor/tsserver integration remain in #1985; there is no
managed-only opt-in that bypasses legacy evidence.
A positive legacy reference still holds its generation. It disables automatic
eviction root-wide only when its process has no proved matching generation
lease. The packaged `eu_reader_lease` helper matches the process fd's device/inode
to the validated persistent control and requires a simultaneous exclusive probe
to fail with `EWOULDBLOCK`. Linux also requires that fd's `FLOCK READ` record;
Darwin requires its vnode info to carry `FWASLOCKED`. The latter sticky bit is
valid only under the source-tested invariant that lease code never explicitly
unlocks: release closes the fd. A control pathname or someone else's lock alone
does not make a process leased. Failed proof grants no exemption.
Linux alone exempts the process identities in `reader-infrastructure.ts`: exact
comm and argv shapes for same-user `sshd-session`, `systemd --user`, and `(sd-pam)`.
Children remain independently scanned, and name-only matches are unknown.
Permission failures outside that rule, including macOS `lsof` failures, remain
unknown. Linux census diagnostics count allowlisted and unknown processes.
Linux task state and starttime are read together from `/proc/<pid>/stat`.
Zombie/dead states positively prove that the incarnation has exited and retains
no address space or filesystem handles. A disappearing process is ignored only
after a fresh stat confirms exit; a live replacement not completely observed
still blocks. This is exit evidence, not a permission-error exemption.

Retirement integration fixtures scope enumeration to their test process and real
spawned readers/publishers, including inside publisher children. A contextual
test dependency refreshes the fixture PID inventory for each scan; Linux `/proc`
and macOS libproc/`lsof` observations and fail-closed decisions are unchanged.
The native-lease suite retains one explicit host-wide fail-closed scan.
Production always enumerates all processes: neither environment variables nor
CLI flags can install the test enumeration context.

On macOS, an `lsof` descriptor with missing/unknown type may be excluded only by
the packaged fixed-arity `int eu_darwin_dead_vnode(int pid, int fd)` helper.
The census probes only numeric process IDs and numeric descriptors. The helper
returns `1` only when `PROC_PIDLISTFDS` confirms that this exact descriptor is
`PROX_FDTYPE_VNODE` and **both** `PROC_PIDFDVNODEINFO` and
`PROC_PIDFDVNODEPATHINFO` return zero with `errno == ENOENT`. Every other result,
missing helper/library, or helper failure leaves that record unknown. The library
is loaded lazily from the absolute packaged `EDITOR_VIEW_LEASE_LIBRARY` path;
the Linux helper returns zero. A proof excludes only that descriptor, never its
process or another handle. Positive pathname/device/inode references and all scan
completeness checks remain in force. The exact `lsof` marker `(revoked)` alone is
not proof. Diagnostics expose `editor-view-process-census: deadVnode=N unknown=M`,
where `N` counts proven descriptors and `M` counts unresolved census reasons.
Every unknown Linux identity, observation or enumeration and every unknown
`lsof` record also emits `editor-view-reader-unknown` with its observed PID,
command name, descriptor, failing call and errno. Unavailable fields are explicitly
`null`, never invented. On Darwin the packaged fixed-arity `eu_darwin_log_unknown`
helper additionally emits correlated
kernel diagnostics with numeric errno/results for BSD process info before and
after the query, a bounded descriptor-type sample, and vnode/path-info calls.
These observations help distinguish an exit race from an inaccessible live
process; they never change classification or authorize retirement.

This narrow rule follows the Darwin vnode-query implementation in
[XNU `proc_info.c`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c#L2555-L2608):
the queries acquire the vnode with `vnode_getwithvid`, then obtain vnode metadata
through `fill_vnodeinfo`/`vn_stat`. The affected Watchman process had 68 descriptors
listed as VNODE for which both queries failed with ENOENT. In an owned same-volume
APFS experiment, an open-and-unlinked file, an open-and-removed directory, and a
renamed view parent all retained successful vnode-info and vnode-path-info queries
with device/inode identities; open-file reads still succeeded. Force-unmounting
the owned APFS disk image instead produced paired ENOENT and file reads failed
with EIO. These observations support this specific paired-query, confirmed-VNODE
rule, not a general claim that ENOENT or an unlinked pathname proves a dead handle.
Routine tests do not mount or unmount devices.

Controls are tombstones: retirement, recreation, and explicit root release never
unlink/recreate their identities. Their inode and metadata usage participates in
host accounting and read-only classification reports. Only known local Linux/macOS
filesystems admit lease proof; NFS, SMB, unsupported/unknown filesystems, unsafe
controls, native failures, and incomplete process scans are unknown.
Linux retains same-user `/proc` pathname and shared-inode evidence; macOS retains
`lsof`, including command status and completeness checks. Held wins over unknown,
and either protects the generation. Legacy scans remain additional evidence,
not a substitute for complete managed lifetimes or root-wide no-eviction.
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
lock and acquire CAS afterward; no path inverts that lock order. Unpinning removes
only that explicit retention reason; it does not opt an unmanaged root into eviction.

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
for abandoned temporary links. Automatic crash repair never rewrites or chmods
payload inodes.

### Recovering a chmod-poisoned shared store

When collection encounters a writable blob, it keeps refusing the store and emits
`editor-view.content-store.integrity-incident` with a writable-blob count and
`alertPath`. The sibling `<content-store>.incident.json` receipt records the
first unresolved incident's observation time, metadata-only count, bounded
examples, and explicit quiesced repair command. Repeated failures reuse that
receipt rather than scanning the whole store for every package; its count is an
observation, not a live metric. Incident reporting never hashes or changes
payload files. Only a successful digest-verified repair with a clean final census
and an absent or empty quarantine directory clears the receipt. Every remaining
quarantine entry is unresolved, including entries from earlier repair runs;
repair records their `unresolvedQuarantineCount` in the retained incident receipt.

Cleanup must unlock **directories only**, never recursively chmod payload files:
snapshot payloads are hardlinked into the CAS and other worktrees. Snapshot
prepare and verification first validate the complete payload byte digest. When
regular payload files have writable-mode drift, repair repeats the canonical
TypeScript aggregate hash through `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` descriptors,
recording each candidate's inode identity and SHA-256 while its bytes feed that
aggregate. Only a matching secondary aggregate authorizes mode repair; private
source-stat hints are not authority, and legacy snapshots without hints remain
supported. All candidate digests must participate in the matching aggregate before
any mode changes. Repair uses bounded descriptor counts: it reopens one candidate
at a time, checks its inode and SHA-256 again, then removes write bits through that
matching descriptor. It rehashes the same descriptor after chmod with strict
before/after metadata checks; a mismatch restores its prior mode through that
descriptor and fails. Each rehash reads at most the initial descriptor size and
rejects short reads or growth. A later inode failure leaves already proven inodes
protected; only the mismatched inode retains or regains its prior mode, and the
snapshot verification still fails closed. The `[editor-view-mode-drift]` stderr record reports the
repaired inode count and up to five sample paths; hardlinked aliases are repaired
together. A byte mismatch during aggregate verification fails before changing any
file mode. Writable directories and private metadata
remain errors. Direct CAS admission still rejects writable blobs; do not bypass
its checks with a blanket chmod or a private-copy fallback.

An initial read-only census requires no quiescence acknowledgement and does not
create a flock, normalize directories, or change any inode:

```sh
bun packages/@overeng/buck2-tools/src/editor-view.ts repair-content \
  --repo-root "$PWD" --dry-run true
```

It reports matching writable blobs, mismatches, and total checked blob inodes;
`repairedBlobs` is zero. It fails if entries change while being hashed.

First stop every editor-view publisher, watcher and reader using this shared
store, and stop the cleanup process that made its files writable. The CAS flock
excludes cooperating publishers, but cannot exclude arbitrary open writable
descriptors. Then explicitly acknowledge that quiescence:

```sh
bun packages/@overeng/buck2-tools/src/editor-view.ts repair-content \
  --repo-root "$PWD" --quiesced true
```

Like `collect-content`, this command accepts `--content-store` for an explicitly
selected store (including an offline copy). Under the existing CAS flock it
hashes each writable blob against its SHA-256 content address before restoring
its addressed mode (0444 or 0555). Matching inodes retain their hardlinks, so
their linked snapshots regain immutability too. It never blesses bytes solely
from a filename or cached source manifest.
The final locked metadata census requires every surviving blob inode to have its
addressed immutable mode. Since mode belongs to the inode, this also proves
that every alias outside the store is readonly, not only the CAS pathname.

Mismatches are moved to a private sibling `<content-store>.quarantine` directory
without chmodding their inodes. The JSON receipt lists the original and
quarantine paths and actual digest; any quarantine makes the CLI exit nonzero.
Linked snapshots still hold the corrupted, untrusted inode: retire those
snapshots using directory-only unlock/unlink and republish their views from
admitted sources before restarting readers. Keep quarantine evidence until the
incident is understood, then explicitly remove the reviewed entries after
retiring their corrupt snapshot aliases. Repair never removes quarantine evidence
or assumes a previously quarantined inode was fixed merely because the remaining
CAS is clean. Rerun quiesced repair after resolving those entries to clear the
incident receipt, then rerun bootstrap and the normal quick gate before resuming
work. Never run repair against a shared live store without coordinating its users.

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

If teardown fails, fix its reported error and rerun it; do not fall back to
`chmod -R` or `rm -rf` on the worktree. Snapshot files are hardlinks to the
host-shared store, so a recursive permission change also makes other worktrees'
payloads writable. Use the quiesced, digest-verified repair procedure above if
that happens. Explicit release can restore owner permissions on its verified
private editor-root and lease-control directories even when those directories
were hardened; it never restores write permission on payload files.

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

CLI bundles override `import.meta.main` only in the selected entry and require
exactly one override. Entry matching resolves symlinks while preserving hardlink
names, so macOS file-descriptor path ambiguity cannot select a source outside the
portable farm or skip the entry override.

CommonJS `__dirname`/`__filename` normalization and farm containment assertions
use the same name-preserving symlink resolution: raw `realpathSync` on macOS can
report the original source name for a hardlinked farm file. Canonicalization
resolves existing files through their symlink chains and retains missing suffixes
below the deepest existing ancestor. A descriptor-reported hardlink alias is not
evidence of an escape; an actual symlink to a source outside the farm is rejected.

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

Pointer-reached orphan reclamation scenarios guard initial publication, each reader
pointer transition, and the final fingerprint check separately. Their fixture teardown
awaits the complete in-flight phase (including assertions) before deleting the fixture
or restoring the host-budget environment; later phases depend on the preceding phase
settling successfully.

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
