# Materialization Spec

This document specifies the materialization action and the editor surface. It
builds on [requirements.md](./requirements.md). Mechanisms are
prototype-validated; see [.experiments/](.experiments).

## Status

Draft.

## Scope

**Defines:** the per-package materialization action, normalization, the editor
view, and the staleness gate.

**Does not define:** semantic dependency declaration (01), tool provisioning
(02), or cache transport (04).

## Materialization Action

```text
translate (genie, freshness-gated)
  pnpm-lock.yaml (+ pnpm-workspace.yaml, patches)
  -> per package version: fetch target (canonical url, sha256, size from generated sidecar)
                          extract target (tarball -> package tree artifact)
  -> per importer:        node_modules assembly target
  -> per-configuration required-edge availability and optional filtering (select())

fetch     host-sharing helper when admitted; native download_file when disabled/fallback;
          verified digest/size; network only here (BUILD.BUCK.MAT-R08); not an RE CAS read
extract   declared tar + ordered patches -> package tree; host recipe replay parked (DQ08);
          local-materialization-policy (no AC reads/uploads)
assemble  importer virtual store: .pnpm/<name>@<ver>[_peer-suffix]/node_modules/<name>
          hardlinks from extract artifacts, relative symlinks for edges,
          workspace: edges as relative links, .bin entries as symlinks
          local-materialization-policy (BUILD.BUCK.MAT-T01); public node_modules output
```

Extract, store-entry, store-SCC, store-view, package-tree, and runtime-module rules use the
default non-remote execution platform, not the cache-admitted platform.
Their cheap filesystem projections execute locally; declared outputs, incremental
invalidation, and editor backing-root completeness are unchanged. Host extraction
replay is parked, not an active replacement for archive decoding.
The decision and measured transfer cost are specified by
[the local materialization policy](../06-reuse-client/spec.md#local-materialization-policy-buildbuckreuse-r08r10).

When host sharing is disabled or its private fallback is selected, standalone
pnpm archive acquisition uses one native `download_file` action with the
canonical registry URL and reviewed SHA-256 and byte size. Buck owns verification
and deferred materialization. This native path has no command fetch branch,
runtime archive-origin selection, or automatic CAS-to-registry fallback.
Warm materialized archives need no transfer, but fresh roots on this path
download registry bytes
([0038, Amendment 3](../../.decisions/0038-digest-origins-for-acquisition.md#amendment-3-one-native-download-shape-q58-2026-10-17)).
The [host-local materialization contract](../06-reuse-client/spec.md#host-local-materialization-reuse-lever-5a)
defines the admitted archive-acquisition exception: its declared local helper
reuses verified host archive blobs, downloading only on cache misses. An intact
warm archive cache permits zero downloaded archive bytes in a fresh sibling root.
Extraction replay and its zero-extraction target are parked under that contract's
open DQ08; its recipe-generation/proof amendments are not the active design.
The archive helper's integrity, filesystem, lifetime and fallback gates remain.
Remote CAS/mirror infrastructure and its verified seeder remain optional, not
archive read-path prerequisites; this exception does not authorize other origins.
Nix-backed builds instead retain the per-digest fixed-output archive projection
through `nix_store.root`, copying and verifying each archive before extraction.

No package manager executes inside Buck actions. pnpm is the developer-time
resolver that writes `pnpm-lock.yaml`; the generated sha256 sidecar is derived
from the lockfile's sha512 integrity values and verified against them at
generation, so it cannot disagree with the lockfile except by staleness, which
the freshness gate rejects. The lockfile's peer-suffixed snapshot keys map
directly to virtual-store entries; peer resolution is not re-derived.

Invalidation is structural (BUILD.BUCK.MAT-R07): a changed package version re-runs its
fetch and extract and the assemblies of importers whose closure contains it;
unrelated importers are untouched. A change that leaves an importer's closure
byte-identical re-runs nothing for it.

Lifecycle scripts are not executed (ratified policy: builds disallowed;
`requiresBuild` is empty in the lockfile). A package that would require a
build fails admission until a declared mechanism exists. `patchedDependencies`
apply during extraction as declared inputs. Optional platform packages are
filtered by cpu/os constraints so foreign-platform entries are neither fetched
nor linked.

The assembled tree is relocatable (no absolute paths) but hardlinks share inodes
with extract artifacts; Buck resets output modes, so read-only protection is
applied on the published editor view, not inside `buck-out`. The retired
deploy-based two-stage action and its normalizer are recorded in
[the retained experiment](.experiments/2026-08-26-two-stage-prune-install.md)
and superseded by
[the closure prototype](.experiments/2026-08-30-declared-closure-prototype.md).

The package-tree API projects declared workspace files into the output for
cacheable consumers; the editor-surface realization provides BUILD.BUCK.MAT-R03
live-source links outside the cacheable package tree without weakening
BUILD.BUCK.MAT-R02.

## Resolver-Context Platform Availability

```text
own package cpu/os/libc gates
  -> initial snapshot/importer availability
  -> required-edge removal to a fixed point (including cycles)
  -> supported entry/view variants + unsupported-configuration reasons
  -> configured Buck selection
       supported: materialize the complete filtered resolver context
       unsupported: fail before registering actions
```

This realizes BUILD.BUCK.MAT-R02, BUILD.BUCK.MAT-R07, and
BUILD.BUCK.MAT-R08 under
[decision 0040](../../.decisions/0040-required-edge-transitive-platform-availability.md).
Portability is a property of the complete required resolver context; own
package gates are only initial constraints. Unsupported configurations are
representable and rejected when selected; required obligations are never
omitted to manufacture a supported tree.

The dependency projection evaluates four configurations: `javascript_portable`,
`linux_aarch64`, `linux_x86_64`, and `macos_aarch64`. The native configurations
use the tuples in [the platform spec](../02-platforms-toolchains/spec.md#platforms).
`javascript_portable` requires an ungated package: any cpu, os, or libc
restriction excludes it, rather than borrowing the generator host's tuple.

Availability is computed over resolved snapshot and importer nodes before
projecting store edges:

1. Seed each snapshot with the configurations allowed by its package's own
   metadata gates; seed importers with all four configurations.
2. For each required resolved dependency, remove a configuration from its
   owner whenever the dependency is unavailable in that configuration.
   Required workspace references participate through their importer context
   when the lockfile represents it; externally declared workspace trees remain
   first-party Buck dependencies. Peer-suffixed snapshots retain exact resolution.
3. Propagate removals through required predecessors until no set changes.
   This descending fixed point preserves a required strongly connected
   component when every member and external required dependency is available.
   A restriction in any member or external required dependency propagates
   through the cycle; traversal order must not affect the result.
4. Project edges only for surviving owner configurations. A required edge
   remains present in every such configuration. An optional edge is retained
   only when its resolved dependency is available there, including that
   dependency's own required closure; its absence does not remove the owner.
   Linked and injected optional workspace references use their resolved importer
   availability when represented in the lockfile. Importer `workspace_trees`
   and `workspace_dependencies` declarations select only that configuration's
   surviving edges; an omitted optional workspace must not remain a Buck
   dependency that triggers analysis of an unavailable workspace closure.

Missing referenced package or snapshot metadata, integrity, or patch metadata remains a
global generation error, including for an unavailable configuration or an
optional edge. Platform exclusion is not permission to accept an unresolved
reference or bypass hash verification.

Store-entry `platforms` records the transitively constrained availability set.
The normalized projection schema is `effect-utils/buck2-pnpm-store/v2`; adding
the view availability set changes the versioned metadata and store fingerprint,
not the identity of unchanged supported view rules.
Each `PnpmStoreView` independently records `platforms: readonly PnpmPlatform[]`;
its variants cover supported configurations only. Equal supported projections
may share a variant. SCC assembly likewise projects only supported member
contexts; it cannot restore a removed configuration. An empty availability set
is a valid projection, not a reason to omit the target or fail generation.

Restricted entries and views emit `unavailable_by_platform`, a repository-local
Starlark attribute mapping all four exact lowercase configuration keys to a
nonempty diagnostic reason when unavailable and an empty string when supported.
Unrestricted entries and views omit the attribute, preserving their existing
generated bytes and identities. Shared rules select the diagnostic for the
configured platform and fail at the beginning of implementation, before any
actions are registered. Thus generation of a mixed-platform graph succeeds,
while selecting an unsupported dependency context fails explicitly rather than
linking an incomplete tree. Supported, unrelated view bytes remain unchanged.

## Editor Surface

The repository-root source-generator consumer and each admitted workspace
package `<package>` expose `:<editor_inputs>` as their canonical Buck dependency
view and `:editor_view_inputs` as the manifest joining that view, the package
tree, and every provider-declared backing root. The stable filesystem shapes are:

```text
<package>/node_modules
  -> ../../.editor-view/<view>/node_modules
<package>/../../.editor-view/<view>
  -> .store/<view>-<snapshot-identity>
<package>/../../.editor-view/.store/<view>-<snapshot-identity>/
  editor-view.json
  node_modules/
  .backing/
```

```text
node_modules
  -> .editor-view/root/node_modules
.editor-view/root
  -> .store/root-<snapshot-identity>
```

Package consumers share a two-level state root; the root source-generator
consumer uses the repository-local `.editor-view/root` state. Every published
link remains inside the repository while context packages,
`packages/@overeng/*`, nested workspace packages, and root generators use the
same publisher.

Each schema-v2 record binds the package, Buck cell and target, selected
`editor_inputs` fingerprint, normalized declared-root digest, exact selected
view digest, exact byte-owned snapshot digest, and deterministic snapshot name.
Tree digests use the `effect-utils/tree-digest/v1` domain separator, unsigned
UTF-8 byte ordering, length framing, and fail-closed checks for special or
concurrently changing files.
Stability checks retain entry type, device, modification/change times, regular-file
size, and file/symlink inode identity. Directory inode numbers are excluded:
[overlayfs inode properties](https://docs.kernel.org/filesystems/overlayfs.html#inode-properties)
do not guarantee their persistence in every layer configuration. Directory
content and link targets remain covered by the same tree digest and timestamps;
the digest format and byte-ownership admission are unchanged.

Before publication, `buck2:editor:authority` compares the canonical admission
registry with tracked package manifests and a Buck `owner(...)` census. The
resulting authority file must name identical required and owned package sets;
every package publication validates it.

Publication holds the exclusive state-root `.publish.lock`, created atomically.
A positively identified dead same-host holder can be recovered after repeating
the process-incarnation proof under the host fence. Live publishers, foreign-host
owners, and ambiguous ownership retain explicit token-gated recovery; lock age
does not authorize recovery. After acquiring the lock, before any batch worker
creates a candidate, the publisher reclaims abandoned payloads. Under the lock,
the publisher:

1. fingerprints each distinct selected dependency view and finite declared root
   once for the admitted state;
2. derives the content-addressed snapshot name before copying; if that entry
   exists, verifies its complete immutable payload and exact admission record
   and reuses it without writing store bytes;
3. for a missing entry, copies the selected view and disjoint backing roots into
   a same-filesystem byte-owned candidate, relocates links into `.backing/`,
   rejects links outside declared roots, and proves no snapshot file shares an
   inode with a disposable source;
4. verifies the complete payload digest and writes `editor-view.json`;
5. hardens the private candidate read-only, then promotes it with owner-write
   temporarily enabled only on the top directory for Darwin's rename semantics;
   the payload stays read-only, and the final root is hardened and checked
   before any current pointer is published;
6. atomically renames the current pointer, installs or validates the package
   first hop, and emits the package-manifest settle signal required by live
   language servers;
7. updates retention eligibility and attempts only reader-proven-safe collection.
   Retention proves eligible snapshots of the published view read-only in full;
   a store entry owned by another view is proven by its self-addressed record and
   read-only root, because its owner proves its payload at publication, reuse,
   and check. A whole-workspace publication stays linear in total snapshot size.
   Pointer helpers validate exact writes under CAS exclusion; a separate
   `buck2:editor:check` performs the full admitted-state traversal.

Bootstrap and publication commands submit all selected views in one
`publish-batch` operation, with the JSON array of publish argument lists on
stdin. Request size is not limited by the operating system's per-argument cap.
The batch acquires each distinct state-root lock before preparing any view and
holds every lock until all workers have settled. `editorViewPublicationWorkers`
in the publisher is the single declared resource bound (four); bootstrap and
source-test publication both use it. Independent root fingerprints within a
candidate remain concurrent. Native copy children are awaited asynchronously,
with at most one per active view. Candidate names are unique per view operation;
promotion, retention, pointer writes, and GC
are serialized per state root, so sibling inventory validation cannot race
promotion or deletion. Duplicate root/view identities are rejected. Every view
is attempted after a preparation failure, and the first failure in request order
is reported only after workers settle and locks are released. Each successful
view retains its stderr timing record. Snapshot/retention formats, lock ownership,
explicit recovery, and whole-workspace authority checks are unchanged.

If a legacy root install occupies the first hop, immutable GNU
`mv --exchange --no-copy` installs the symlink without an absent-path window and
retains the exchanged entry under `.legacy/`. A failure before the pointer flip
leaves the prior current view intact. Snapshot payloads never retain links into
`buck-out`, whose action directories Buck may delete before rebuilding.

Abandoned `.store/.candidate-*`, interrupted root `.gc-*`, and individual
unreferenced `.legacy/*` entries are reclaimable payloads, not completed
generations. Publisher startup reclaims candidates and interrupted garbage under
the exclusive publication lock. Cleanup carries normal-acquisition or
proven-dead-owner-recovery provenance and validates the held lock path/token/PID.
Normal acquisition follows the preceding holder's release; recovery proves the
preceding holder is dead. Both exclude publisher writes. Missing or mismatched
lock proof refuses cleanup. Startup also observes readers for candidates and
interrupted garbage: stale cwd/fd references keep those entries even though they
were unpublished or had previously crossed deletion commitment.
Reclamation requires no live reservation and a known pointer inventory proving
that no pointer reaches the entry. Pointer reachability includes
root/control symlinks and package `node_modules` links, with both lexical and
resolved targets retained so dangling or indirect legacy links remain protected.
The retirement fence repeats identity and reachability checks before renaming
the entry to a private `.gc-*` name; recursive deletion follows outside the
metadata fence. An interrupted rename or deletion is resumed by the next lock
holder. Budget eviction considers these orphans before completed generations.
Publisher acquisition and budget victim acquisition share the same fenced
dead-owner recovery helper; budget acquisition never waits for a live holder.
A budget batch holds its exclusion fence and uses one fresh census and reader
proof, considering orphans before generations and retiring only enough payloads
to cover the shortfall. The proof expires after 30 seconds. Each candidate
rechecks identity and ledger epoch immediately before retirement; failed checks
skip that candidate without waiting. An expired or insufficient batch starts
another census and proof. Every committed retirement emits its own deletion
receipt, followed by a batch summary, even when admission subsequently fails.
The pre-delete seam is an identity/epoch check, not a reader exclusion: a reader
arriving after observation need not change either value. Non-blocking exclusive
reader leases in #1990 must be probed at this seam to close that advisory race;
a held lease skips the candidate without waiting.

Legacy entries are evaluated independently: a referenced displaced install does
not preserve unrelated legacy entries. A still-referenced legacy entry is
adopted with one footprint walk and an immutable-identity sidecar when its bytes
can be sealed safely. Writable shared inodes are not chmodded through aliases;
unproven immutability remains conservatively uncached.

Repository tasks configure two completed snapshots **per view**: current and
previous. This is a retention-eligibility target, not a bound on protected state.
Grace, pins, reader leases, legacy evidence, and unmanaged-session policy can
retain older generations indefinitely. Literal admitted link text participates
in identity, so changed Buck artifact paths can create a new snapshot even when
dependency file bytes remain identical.

### Generation Reader Leases

The reader-lifetime boundary supplements atomic publication (BUILD.BUCK.MAT-R05):

```text
publish/backfill: CAS fence → persistent generation control → pointer publication
reader:          CAS fence → resolve/validate → shared lease → source reads → close
retirement:      root → host → CAS → fresh proof + nonblocking exclusive lease
                                      → rename → payload cleanup → close
```

Each generation has a private regular control at
`<editorRoot>/.leases/<generation>.lock`, separate from immutable payloads. Its
canonical root, generation name, and inode identity are validated under CAS
exclusion; readers resolve pointers inside that fence rather than trusting a
pre-resolved path. Locks use native `flock`; only known local Linux/macOS
filesystems supply usable evidence. NFS, SMB, unclassified filesystems,
replaced/unsafe controls, and native errors are unknown. A missing control is
`no control (clear under fence)` in read-only planning. Readers, publishers, and
retirement may safely backfill it only after validating the generation under the
owning CAS exclusion. Reader acquisition then takes `LOCK_SH`; retirement must
obtain `LOCK_EX` before deleting payloads. Unsafe existing controls are never repaired.

The launcher leases the generations reachable at launch and keeps those leases for the process lifetime. It does not refresh leases when a pointer moves later.
The packaged launcher loads no helper from an evictable view. Explicit fd
mappings keep leases in source-reading servers and worker descendants, including
the Genie TypeScript API child. Parent `SIGKILL` does not release a child's open
description. A lease is released only by closing its fd, never by `LOCK_UN`;
this invariant is checked against the native, TypeScript and inherited-fd code.
Unrelated CAS descriptors remain close-on-exec.

Active leased Bun processes also preserve their mapped descriptors across
`process.execve`: the packaged native helper marks all other descriptors above
stderr close-on-exec, keeps the lease numbers and open descriptions, and replaces
the process without reacquisition. This covers Genie's source transpiler-cache
restart on Linux and macOS; Bun's ordinary `process.execve` closes all descriptors
above stderr. Failed replacement restores the original descriptor flags and
reports its errno rather than falling back to an unleased replacement. Any flag
restoration failure is attached to that error without hiding the exec errno.
An unrelated descriptor closed by a runtime thread during enumeration is already
absent and is skipped on `EBADF`; a missing lease descriptor remains an error.
The preload's `bun:ffi` dependency is a runtime builtin,
loaded only on Bun paths; standalone staging still verifies isolated Node loading
and rejects unrecognized `bun:` imports.

A lease alone never makes a root eligible for automatic eviction; the legacy reader scan stays on for every root until #1985.
A complete scan with a positive legacy payload/root reference from a process
without a proved matching generation lease detects an unmanaged session and
disables automatic generation eviction root-wide. A leased process still holds
every generation it references, but does not disable eviction of unrelated
generations. Roots are not presumed unmanaged. Incomplete evidence blocks
retirement as unknown; only a complete clear scan plus fenced identity/pointer/
pin/recency checks and an exclusive lease authorizes retirement. No managed-only
opt-in bypasses legacy evidence. Dynamic refresh and external integration remain
in [#1985](https://github.com/overengineeringstudio/effect-utils/issues/1985).
Launch leases do not claim coverage of later moving-pointer opens; external
readers requiring guaranteed retention must pin before use.

Per-process lease proof matches the descriptor's device/inode to the validated
persistent control of the referenced generation and requires a simultaneous
nonblocking exclusive probe to fail with `EWOULDBLOCK`. Linux additionally
requires that description's `/proc/<pid>/fdinfo/<fd>` record to show a shared
`FLOCK READ` lock. Darwin requires `PROC_PIDFDVNODEINFO` to report the matching
identity and `FWASLOCKED`. This sticky Darwin bit is valid here only because the
lease protocol never explicitly unlocks: release closes the description.
Neither a control pathname nor another process's lock is sufficient. Failed
proof remains unleased (root-wide protection) or unknown, never managed.
See XNU [`sys_flock`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_descrip.c)
and [`fill_fileinfo`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c).

Linux uses one infrastructure identity allowlist in `reader-infrastructure.ts`:
exact comm plus cmdline shapes for same-user `sshd-session`, the exact systemd
user executable and `--user` arguments, and `(sd-pam)`. A readable UID must match;
matching comm alone is insufficient. The exemption applies only to that process,
never its descendants. The rule protects against accidental deletion of a view
in use, not against a same-user adversary. Census logs report allowlisted and
unknown process counts. This exemption is Linux-only: failed or incomplete macOS
`lsof` observations remain unknown.
Linux stat state and starttime identify an incarnation together. Zombie/dead
states prove no remaining address space or filesystem handles. Disappearance is
ignored only after a fresh stat confirms exit; an unobserved live replacement
remains unknown. This positive exit proof is not a permission-error exemption.

Applicable evidence merges as `held > unknown > clear`. Positive legacy inode
or pathname references and shared leases hold the generation; incomplete
same-user `/proc` observations or failed/partial `lsof` output make it unknown.
An outside cwd or a different namespace does not prove view unreachability.
Only clear candidates may be retired by either host-budget eviction or
per-view snapshot collection. Final proof repeats under root → host → owning-CAS
exclusion, including journal epoch, pointers, pins, recency, and identity.
Exclusive leases remain open through private cleanup and are closed on errors.
Only published generation candidates receive the nonblocking exclusive lease probe, held through payload cleanup; unpublished orphan `.candidate`, `.gc`, and `.legacy` paths retain the fresh legacy-reader, pointer, and identity proofs without a lease probe.

Control files are persistent tombstones and are not unlinked on generation
retirement, recreation, or explicit editor-root release. Their inode and
metadata pressure participates in host accounting and classification reports.
Explicit release requires stopped users and exclusive generation leases, removes
payloads, and preserves the canonical root/control identities.

Host-budget admission replaces force-admit with bounded
`EditorViewCapacityError` (`EDITOR_VIEW_CAPACITY`) when clear candidates cannot
provide capacity. Rejection reports measured/requested/budget bytes, protected
generation count, reasons and remediation, without materializing a candidate
or deleting unknown generations. Post-commit maintenance remains advisory.

## Staleness Gate

`buck2:editor:bootstrap` regenerates whole-workspace ownership authority but
builds and publishes only the declared source-generator import closure: the
repository-root dependency view backed by Genie's package tree and the
OpenTelemetry contract view needed by Genie's Weaver runtime. The shared Genie
runtime-closure walker checks every generator before `genie:check` and names any
first-party package imported outside that declaration, so a new edge cannot
silently rely on a stale whole-workspace publication. Bootstrap therefore stays
bounded by source-generator dependencies instead of every workspace package. It
exists only to make `genie:check` runnable and reports no governed evidence.
After freshness and workspace reconciliation, `buck2:editor:publish` and
`buck2:editor:check` derive the complete root-plus-package set from the canonical
source registry, regenerate whole-workspace ownership authority, build every
`:editor_view_inputs` manifest in one Buck invocation, then publish or validate
each consumer in deterministic order. The checker validates record schema and
identity, both symlink hops, state-root containment, pointer liveness, snapshot
completeness, immutable payloads, retention state, and admitted versus recorded
digests. It does not use tsgo as an oracle.

The mutating `buck2:editor:materialize` entrypoint serializes `mr:setup`,
bootstrap publication, `genie:run`, `genie:check`, `mr:apply`, and authoritative
editor publication. TypeScript declaration publication waits for that barrier.
This does not change the standalone freshness contract: `genie:check` still
runs after bootstrap without invoking `genie:run`, so it cannot repair the
projection it proves.

Direct `test:<package>` and source-complement tasks publish only that package's
view plus the repository-root and OpenTelemetry bootstrap views. The scoped
publisher still proves complete workspace authority and waits for unchanged
generator freshness validation; the selected package snapshot contains its
entire provider-declared runtime closure, not links to sibling editor views.

`test:run` uses aggregate-only execution aliases. These aliases retain bounded
batch ordering and share `buck2:editor:publish:test`, which publishes the union
of the aggregate's selected source-test consumers plus the root and extra
source-suite consumers. Required CI platform scope is defined in
[the CI spec](../../../ci/spec.md#required-platform-test-coverage).
Direct package tasks never depend on an earlier batch; requesting one package
does not run unrelated package tests. The `check:all` observability profile and
extra source suites retain the union publisher.

Explicit setup/materialization and the full `buck2:editor:publish` entrypoint
remain complete-workspace operations for human consumers; shell entry is
mutation-free. Views not selected by a test refresh through these explicit
operations. Publishers sharing `packages/.editor-view` must be ordered: their
publication lock fails fast rather than waiting. Aggregate aliases use the one
union publisher rather than concurrently scheduling per-package publishers.
`scripts/devenv-task-graph-check.mjs` verifies scopes, direct-task isolation,
batch ordering, and publisher ordering on the evaluated graph.

Missing, malformed, escaping, dangling, incomplete, or stale state fails with
the recorded and current identities. `buck2:editor:recover-lock` is the only
recovery surface; it requires both `EDITOR_VIEW_PACKAGE` and the exact printed
`EDITOR_VIEW_LOCK_TOKEN`, and neither builds nor mutates snapshots.

## Retired Worktree Teardown

```text
worktree:teardown
  -> stop root-owned Buck isolations and remove only their state
  -> delete the root's watch from reachable Watchman
  -> remove root-keyed watcher admission entries
  -> buck2:editor:release
  -> chmod owner-write on remaining real directories
  -> operator leaves checkout and runs git worktree remove
```

After closing editors and builds, run
`devenv tasks run worktree:teardown --mode single` from the retired worktree.
The shared task resolves the physical absolute Git checkout root and operates
only on state keyed to that root. It is offline and idempotent; missing daemons,
unreachable Watchman, and absent cache/editor roots are no-ops. Watcher admission
filenames under `${XDG_CACHE_HOME:-~/.cache}/effect-utils/buck2-posture-v2` begin
with `sha256(absolute-root)-`, followed by the invocation-key hash; endpoint-only
REAPI/archive admission remains shared and is not removed.

Buck state is a hierarchy under canonical `~/.buck/buckd`: the absolute checkout
path without its leading slash, followed by an isolation name. A directory with
direct `buckd.info`, `buckd.pid`, `buckd.stdout`, `buckd.stderr`, or
`buckd.lifecycle` files identifies an isolation. Other child directories hold
descendant checkout state and are untouched. An identified isolation can itself
contain descendant state when its name overlaps a descendant checkout path.
Before stopping its daemon, teardown refuses ambiguous contents with a nonzero
exit: subdirectories matching actual descendant paths, unknown subdirectories,
symlinks, or non-regular history entries. It clears only regular daemon files and
the shallow regular-file contents of Buck's owned `prev` history directory, then
uses `rmdir`; isolation directories are never recursively deleted. The checkout's
state container is removed only if empty. State paths outside the canonical base
and any symlinked state component are refused.

`devenv tasks run buck2:editor:release --mode single` is the editor-only release
surface. Teardown calls that existing task when the consuming repository defines
it. Both are explicit lifecycle operations, never dependencies of publication,
setup, tests, or checks. The evaluated task graph asserts that isolation.
Consumers inherit teardown through the shared setup, check, clean, or
worktree-guard module, or import the exported worktree-teardown module directly.

Teardown makes remaining directories owner-writable without following symlinks
or changing file modes. Before chmod, it prunes any nested directory containing
a `.git` file/directory, a megarepo configuration, or a `.bare` store boundary,
and the `repos` member container of a megarepo-configured directory. These nested
checkout/composition roots and their contents retain their modes.
It never deletes tracked files or determines removal eligibility; the caller
owns dirty-tree and canonical-checkout policy.
Capability-profile Nix indirect gcroots are left alone: after worktree removal
they become dangling, and Nix GC prunes them.

The publisher's `release --repo-root <root> --package <package>` command operates
on the package's entire shared editor root, not just its individual view. It
acquires the existing publication lock, refuses active or stale locks, makes
owned directories writable without following symlinks, atomically retires the
root, and removes it. Missing roots are a no-op; external dependency targets and
source files are untouched. Exact-token recovery remains required for a stale
lock. Package first-hop links can remain dangling until the retired worktree is
removed or publication recreates its root.

Every tool that removes a worktree runs root-scoped `buck2 kill` for each of the
root's isolations before removal. A Buck daemon's cwd can be the root itself or
`<root>/buck-out/<isolation>`, so a live daemon holds the worktree for in-use probes.
Once the directory is renamed or gone the CLI can no longer address it. `worktree:teardown`
follows this rule. On Linux, `mr store gc` discovers the current user's daemons
inside an eligible worktree and runs `buck2 --isolation-dir <i> kill` from each
daemon's project root only after root-scoped status proves the same PID/daemon
ID and no active commands. This happens under the worktree lock (and lease where
present), after the path's existing keep/activity checks and before its in-use
probe or deletion, for cold and ref-mismatch archives, merged-worklog teardown,
legacy whole-root deletion, and targeted applications. The legacy sweep adds no
process probe or status reclassification. Receipts record every stop and the
daemon + forkserver's pre-kill RSS + VmSwap KiB; targeted application errors
include stopped daemon identities and memory estimates in their message.
Status/kill failures degrade to unreachable evidence; paths with an existing
probe still veto held roots. Already-moved archive entries are
report-only/unreachable, never killed from the new path. Budget and generated
artifact evictions inside a surviving root do not stop Buck; `mr store fix` is
unchanged. See `packages/@overeng/megarepo/src/store/store-buck-daemons.ts` and
`packages/@overeng/megarepo/src/cli/commands/store/mod.ts`.

## Buck Maintenance

```text
devenv tasks run buck2:maintain
  -> mr store buck-maintain --config <repo>/buck-maintain.json
  -> shared store/store-buck-maintain.ts runtime
  -> owner/activity/blackout checks under the maintenance lease
  -> native Buck stale clean, optional inactive full clean, and idle daemon kill
```

`scripts/buck2-daemon-reaper.ts` is a thin runtime adapter, not an independent
policy implementation. Its former `--buck2`, `--idle-seconds`, and `--root-prefix`
flags are replaced by `--config`; `--dry-run` reports decisions without mutation.
The CLI's `--json` emits the complete versioned maintenance receipt.

The neutral version 1 repository configuration scopes roots to the current
checkout. It sets a soft 2 GiB `buckOut.budgetBytes`, `buckOut.keepSince: "24h"`,
and `daemon.idleStopAfter: "30m"`. The 30-minute value is **maintenance policy**,
not a native idle guarantee. The runtime does not set `daemon_idle_timeout_s`:
command-arrival timeouts are not proof that a build or editor session is idle.
Native stale clean can retain recent outputs above budget. Full clean requires
the optional `buckOut.fullCleanWhenInactiveFor` policy and inactive-worktree
evidence. No maintenance path recursively removes Buck files itself.

Owner scope defaults to the current exact `ST_AGENT`. Configured
`maintainOwners` entries are exact identities or glob patterns, never permission
for any arbitrary owner value. Without a seat or configured owners, maintenance
is report-only. Unowned roots require `maintainUnowned: true`; unknown owner
evidence is foreign. UTC blackout windows include their start, exclude their
end, and support midnight wrap. Public configuration has no host-specific roots,
owner identities, or schedules.

Active streaming commands, including attached `buck2 lsp`, and live Buck client
processes prevent maintenance. Daemon shutdown uses native, root-scoped Buck
commands after rechecking activity and identity under the maintenance lease.
Missing roots and uncertain evidence are report-only. The runtime does not
signal daemon processes directly.

Accepted residual: Buck has no conditional kill or client-admission API. A new
client may arrive between the final status/client census and native kill.
The recheck narrows that window, and detected races are reported; this is not an
atomic no-new-clients guarantee. The next client invocation can restart the
daemon. Host scheduling remains host-owned rather than public repository policy.

## Relationship to Exact Closure Materialization

The declared closure above is the per-package fetch-and-verify tier that the
retired package-evidence regime anticipated. It is introduced with live
consumers (the admitted packages) under the Buck admission contract; no
evidence infrastructure from the retired regime is revived.
