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

fetch     native download_file, verified digest/size, deferred materialization;
          network only here (BUILD.BUCK.MAT-R08); not an RE CAS read
extract   tar -> package tree, local-materialization-policy (no AC reads/uploads)
assemble  importer virtual store: .pnpm/<name>@<ver>[_peer-suffix]/node_modules/<name>
          hardlinks from extract artifacts, relative symlinks for edges,
          workspace: edges as relative links, .bin entries as symlinks
          local-materialization-policy (BUILD.BUCK.MAT-T01); public node_modules output
```

Extract, store-entry, store-SCC, store-view, package-tree, and runtime-module rules use the
default non-remote execution platform, not the cache-admitted platform.
Their cheap filesystem projections are recomputed locally; declared outputs,
incremental invalidation, and editor backing-root completeness are unchanged.
The decision and measured transfer cost are specified by
[the local materialization policy](../06-reuse-client/spec.md#local-materialization-policy-buildbuckreuse-r08r10).

Standalone pnpm archive acquisition uses one native `download_file` action
with the canonical registry URL and reviewed SHA-256 and byte size. Buck owns
verification and deferred materialization; no command fetch branch, runtime
archive-origin selection, or automatic CAS-to-registry fallback is involved.
Warm materialized archives need no transfer, but explicit fresh roots still
download registry bytes. The private CAS and verified seeder are optional
infrastructure, not archive read-path prerequisites. A mirror or CAS read path
requires a separate decision
([0038, Amendment 3](../../.decisions/0038-digest-origins-for-acquisition.md#amendment-3-one-native-download-shape-q58-2026-10-17)).
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
An existing lock fails immediately and prints the explicit token-gated recovery
operation. There is no age heuristic, timeout, or automatic lock theft. Under
the lock, the publisher:

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
7. updates the retention record and garbage-collects snapshots outside the
   configured finite retention set. Retention proves every snapshot of the
   published view read-only in full; a store entry owned by another view is
   proven only by its self-addressed record and read-only root, because its
   owner proves its payload in full at every publication, reuse, and check. A
   whole-workspace publication therefore stays linear in total snapshot size.
   Pointer helpers validate their exact writes; a separate
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

Repository tasks configure two completed snapshots **per view**: current and
previous. For `N` admitted views the shared-store bound is `2 × N`, excluding
in-flight candidates, which are not retention garbage. GC deletes only
validated older snapshots of the publishing view after its pointer flip; it
neither infers process liveness nor collects inactive worktrees. The preceding
snapshot supplies a bounded rollback/read-overlap window, not an indefinite
lease for a process pinned to an older generation. Literal admitted link text
participates in identity, so changed Buck artifact paths can create a new
snapshot even when dependency file bytes remain identical.

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

## Idle Daemon Reaping

```text
scripts/buck2-daemon-reaper.ts --buck2 <raw buck2> [--idle-seconds 10800]
  -> the user's live daemon processes: argv daemon id + isolation, cwd <root>[/buck-out/<i>]
  -> per daemon: root gone           -> report-gone (pid, daemon id, root, RSS + swap)
                 status fails/differs -> keep-unreachable (reason)
                 active command      -> keep-active
                 idle < threshold    -> keep-recent
                 idle >= threshold   -> recheck from root -> buck2 --isolation-dir <i> kill
```

The pinned `[buck2] daemon_idle_timeout_s` counts command arrivals rather than
running work, so it can stop a build that runs longer than the timeout or an
attached `buck2 lsp`. It stays at Buck's default; the reaper owns idle exit.
Daemons are found from `/proc` rather than `buck2 status --all`, which probes
every historical `~/.buck/buckd` entry and stalled past a 180 s test timeout on a busy host.
Each daemon's status is read from its own root with a 30 s timeout and must
report the same pid and daemon id; anything else keeps the daemon.
Idle time runs from the later of the daemon's `start_time` and the newest event-log
file under `<root>/buck-out/<isolation>/log`, where every streamed command writes its
event log. `buck2 status` writes no event log, and `buck2 kill` only adds a
directory there. A daemon reporting any
`active_commands` entry, which includes an attached editor session, is kept
regardless of age. Memory is sampled first; the final status read from the
daemon's root, together with the newest event-log write, is then immediately
followed by `buck2 kill`. The kill is aborted on a changed daemon id or pid, a
new command, or an event-log write since the deciding observation. After the
kill, an exited pid other than the observed one, or an event log written during
the kill, is reported loudly as `raced`.

Accepted residual: `buck2 kill` has no conditional form and the daemon has no
admission API, so a client cannot make the idle check and the shutdown atomic.
A command that starts within the sub-second window between the final read and
the kill, after at least three hours of idleness, fails loudly with the daemon
killed; the next client invocation restarts the daemon. Buck2's state is
crash-consistent, so the residual is a visible failed command, never silent
corruption. `mr store gc`'s teardown stop uses the same order, the same residual
and a `raced` receipt field; its window follows the retiring worktree's keep
checks instead of the three-hour threshold.

The reaper never signals a process. A daemon whose root no longer exists is
report-only. The default threshold of three hours outlasts an agent's usual
pause between commands on one worktree, so active worktrees keep a warm daemon;
a longer pause only costs a cold daemon start on the next command. A merged or
abandoned worktree's daemon is stopped at most one run interval after its last
command plus the threshold.
`--root-prefix` limits a run to roots under the given prefixes, and `--dry-run`
prints decisions without stopping anything. Host scheduling belongs to the host
configuration; the script holds no state between runs.

## Relationship to Exact Closure Materialization

The declared closure above is the per-package fetch-and-verify tier that the
retired package-evidence regime anticipated. It is introduced with live
consumers (the admitted packages) under the Buck admission contract; no
evidence infrastructure from the retired regime is revived.
