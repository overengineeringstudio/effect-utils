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
