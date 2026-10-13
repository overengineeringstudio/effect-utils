# 0006 Pure Reuse With Root-Local Graph Authority

Status: accepted

## Context

Local development must reuse dependency bytes across many worktrees without
turning shared storage into dependency identity, lifecycle, or repair authority.
pnpm can share either its Store Cache alone or also its Global Virtual Store.
The latter may reuse more topology state but expands the writable/failure scope
across otherwise independent roots.

## Evidence and Argument

- The [mixed Effect-generation experiment](../01-live-pnpm/.experiments/2026-07-17-shared-gvs-identity-and-repair.md)
  proved that native shared GVS preserved correct Effect and peer-context
  identities in both install orders. It also proved that `pnpm install --force`
  did not repair a missing shared GVS edge; repair required discarding shared
  `links/` state.
- The committed [default-gate evidence](../07-verification/evidence/storage-sharing-default-v2.json)
  proves material package-byte and file-count reuse across real Linux/ext4 and
  Darwin/APFS workloads.
- The two-root shared-cache fixture proves zero second-root downloads, offline
  rematerialization, concurrent cold/offline roots, distinct native-package
  inodes, and distinct virtual stores.
- Nix prepared dependencies already demonstrate the stronger reusable-unit
  shape: declared inputs produce immutable, integrity-addressed output without
  lifecycle mutation or ambient live-store authority.

The missing evidence is a same-workload comparison of root-local topology with
shared and identity-partitioned GVS. Current pnpm GVS options also fail the
strict reuse boundary because consumers share mutable topology and repair
state. Therefore this decision records the current pnpm compatibility baseline; it
does not present root-local rematerialization as the long-term ideal.

## Options

| Option                                                                | Tradeoffs                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Shared Store Cache with root-local virtual topology                | Maximizes proven package-data reuse while keeping graph mutation and repair independently bounded; repeats some topology materialization.                                                                   |
| B. Shared Store Cache with one shared GVS                             | May reuse more topology work, but shares writable graph realization and expands one-root repair/fault scope.                                                                                                |
| C. Shared Store Cache with GVS partitioned by declared graph identity | Narrows coupling relative to B but still shares mutable topology within a partition and adds lifecycle complexity.                                                                                          |
| D. Fully isolated stores and topology                                 | Simplest isolation, but discards large proven byte/file-count and second-root reuse gains.                                                                                                                  |
| E. Hermetic Dependency Artifact                                       | Reuses content and topology by complete declared-input identity with immutable, atomic results; requires a producer, compatibility projection, ownership, and GC contract not exposed by current live pnpm. |

## Decision

Keep A as the current pnpm compatibility baseline under DELTA-001, and choose E as the architectural
target.

Reusable package data must first be deterministic, integrity-addressed, derived
from declared inputs, lifecycle-free, and immutable by contract. Within that
eligible layer, share as broadly as the trust and platform evidence allow. Keep
Dependency Graph, virtual topology, Projection State, and repair authority at
one Materialization Root so reuse never grants mutation authority.

Move repeated graph/topology work across roots only by replacing mutable shared
state with a Hermetic Dependency Artifact keyed by the complete lock graph,
platform, package-manager policy, and all identity-affecting inputs. Publish it
atomically, mount or project it read-only, and make eviction independent of
consumers. This follows the property that gives Nix stores and hermetic build
action caches broad safe reuse; it does not require inventing a second mutable
package-manager database.

Use DMP.VER-R12 to quantify A, B, and C and to identify topology work worth
capturing in E. B or C cannot replace A merely by winning a benchmark: a
challenger must first eliminate cross-root mutable topology and repair authority
and pass identity, purity, data-safety, concurrency, and bounded-repair gates.

## Consequences

- Managed live pnpm uses a shared whole Store Cache and root-local
  `node_modules/.pnpm`; GVS is disabled by the current spec. Sharing the cache's
  mutable pnpm index is a transitional compatibility divergence tracked by
  [DELTA-001](../.delta/DELTA-001-whole-store-mutable-index.md), not part of the
  accepted pure reuse target.
- Direct mutation of imported dependency files and dependency lifecycle scripts
  remain outside the managed contract. Native/build-sensitive output is
  isolated or supplied as immutable Nix output.
- Root repair discards only root-owned graph/projection state and never invents
  edges or sweeps the host Store Cache.
- Current GVS remains a measurement subject, not an admissible end state or a
  synonym for cache reuse or runtime identity.
- The long-term design should remove repeated pure topology work by publishing
  immutable graph-addressed artifacts, rather than widening mutation scope.

## Amendment 1 — Reopen Local GVS With Staged pnpm 12 Validation

The local shared-GVS rejection is reopened. Local GVS is the preferred
challenger for compatible isolated-linker workspaces, subject to a designated
pilot and the concurrency, repair, and compatibility gates below. This is an
explicit acceptance of bounded shared mutable topology for the pilot, not a
claim that GVS satisfies the immutable Hermetic Dependency Artifact target.
The original identity experiment already distinguished pnpm's correct native
graph identities from an unsafe secondary name-only graph writer.

The shared task exposes `globalVirtualStore = true;` and Genie exposes
`enableGlobalVirtualStore: true`. Defaults remain root-local. CI and
fixed-output preparation remain GVS-disabled and job/output-local, independent
of a local opt-in. Actual effect-utils and LiveStore enablement waits until the
designated pilot has remained green for several days; this amendment does not
enable either repository.

### New Evidence And Limits

A 2026-10-05 same-workload comparison used all 36 workspace projects in
[LiveStore at a52baaff](https://github.com/livestorejs/livestore/commit/a52baaff0396dfc4ac8ca7e295afdd4fab051cf8),
pnpm 12.7.0, Node 24.20.0, an isolated linker, and ignored lifecycle scripts.
The second checkout shared each strategy's already-populated complete store:

| Strategy                                        | Second-checkout install | Additional allocated bytes | Additional unique inodes |
| ----------------------------------------------- | ----------------------: | -------------------------: | -----------------------: |
| Root-local virtual topology, hardlinked content |                 36.51 s |                160,271,360 |                   36,302 |
| Shared GVS                                      |                  4.94 s |                 17,368,064 |                    3,594 |

These are store-plus-root `du` union deltas with hardlinks deduplicated and
distinct `(device, inode)` counts, not exclusive physical filesystem usage.
GVS reduced charged bytes by 9.23× and unique inodes by 10.10× for this workload.
Heavy background disk contention prevents treating the timing difference as a
clean general speed ranking. The successful smokes resolved Effect, TypeScript,
and Vitest, executed an Effect expression, and ran the TypeScript CLI version
command; they did not prove semantic typechecking, a bundler build, native
rebuilds, or full application compatibility.

The upstream offline tarball regression independently proves real pnpm 12.7
graph-instance reuse between two roots, package execution, parsed
`.modules.yaml`/`pnpm store path` agreement, and default/CI isolation despite
ambient and authored GVS opt-ins. Reachable-edge health/digest tests cover
missing and foreign-store edges without scanning unrelated shared graphs.
These checks do not substitute for the rollout gates.

### Concurrency Contract And Gate

- pnpm remains the sole Dependency Edge writer. Declare missing edges in
  manifests or graph-specific package extensions; never rewrite by package name.
- Share one complete, same-filesystem Store Cache among trusted same-user
  consumers. Reject external version/files bridges. pnpm 12.7 uses `v11`;
  neither a historical `v12` assumption nor a split writable `files/` pool is
  admissible.
- Managed mutations retain per-root and PNPM_HOME locks plus the shared Store
  Cache maintenance lease. Independent roots may install concurrently; prune,
  graph removal, and other maintenance require the exclusive counterpart.
- A native addon initializer must also hold an instance-local lock while
  holding the shared maintenance lease. Do not infer native-build safety from
  script-free installs; consume immutable native output or prove this locking
  path before enabling a workspace that needs it.
- In disposable stores, run overlapping cold and offline warm installs into
  equivalent and different graphs in both orders. Repeat mixed Effect and React
  peer generations on pnpm 12, verify every root's exact runtime identity and
  realpaths, and verify maintenance cannot enter while a consumer lease is held.

### Repair Contract And Gate

`pnpm store status` and install integrity checks validate package content;
`pnpm store prune` collects reachability. None proves a damaged graph edge was
restored. The pnpm 11 missing-edge result remains a warning, not proof about
pnpm 12; do not promise that `pnpm install --force` repairs shared topology.

Reproduce a missing edge in a disposable pnpm 12 graph shared by two roots.
Check both consumers, record what status/force/prune actually do, then quiesce
affected consumers and take the exclusive maintenance lease. Discard only the
identified corrupt graph instance and reinstall every affected root. If safe
instance identification or complete affected-root enumeration is unavailable,
select a fresh complete `PNPM_SHARED_STORE_DIR` namespace and reinstall rather
than destructively sweeping a live store. Keep the old namespace until its
consumers are quiesced and maintenance ownership is established.

Root repair removes only root-owned projections; it cannot certify shared-graph
recovery. A root-local rollback disables the opt-in and rematerializes that
root's projection without deleting shared instances.

### Verification And Rollout Gate

For the designated pilot, record the exact pnpm version, lock/peer graph, linker,
effective store/mode, `.modules.yaml`, package realpaths, cold/warm footprints,
and readiness receipts. pnpm 12 must receive GVS through the honoured environment
key or workspace YAML, not the ineffective kebab-case generic config argument.
Test mode changes against both normal and shortcut readiness caches.

Run semantic typechecks and the consuming applications' actual build/runtime
paths, including bundlers with root boundaries, implicit type/phantom
dependencies, patched/local packages, generated source inputs, and any required
native initialization. Prove CI and fixed-output preparation stay local.
Observe the pilot across repeated fresh worktrees and lock changes for several
green days before proposing effect-utils/LiveStore cutover. Only measured
compatible consumers advance; default changes require that evidence, not this
API's availability or the benchmark alone. Hermetic artifacts remain the
long-term architectural target; GVS remains pnpm-owned mutable live state.
