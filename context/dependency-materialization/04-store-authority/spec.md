# Store Authority Spec

This document specifies store authority. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Scope

This spec defines steady-state storage placement, graph isolation, package
import selection, and root-repair boundaries. It does not define transitional
legacy-store migration, a root registry, named storage profiles, all-root
repair, or machine-specific Store Cache placement.

## Requirement Trace

| Section            | Requirements                                               |
| ------------------ | ---------------------------------------------------------- |
| Ownership model    | DMP.STORE-R01, DMP.STORE-R02, DMP.STORE-R03                |
| Placement          | DMP.STORE-R03, DMP.STORE-R11, DMP.STORE-R12                |
| Import policy      | DMP.STORE-R09, DMP.STORE-R10                               |
| Concurrency        | DMP.STORE-R08                                              |
| Health and repair  | DMP.STORE-R04, DMP.STORE-R05, DMP.STORE-R06, DMP.STORE-R07 |
| Benchmark evidence | DMP.STORE-R13, DMP.STORE-R14                               |
| Host lifecycle     | DMP.STORE-R15                                              |
| Legacy migration   | DMP.STORE-R16                                              |
| Optimization order | DMP.STORE-R03, DMP.STORE-R09, DMP.STORE-R14                |

## Ownership Model

```text
same-user local Materialization Roots
  root A: node_modules/.pnpm + graph + projection
  root B: node_modules/.pnpm + graph + projection
              |
              +--> host pnpm Store Cache
                   - immutable content-addressed files
                   - pnpm-owned mutable derived index

CI job
  root-local graph + job-local Store Cache

Nix builder
  prepared dependencies + builder-owned store
```

The pnpm Store Cache is a performance cache, not a dependency-identity or
availability authority. The current compatibility realization shares its
mutable index inside the same-user trust boundary under pnpm synchronization,
but that index is not part of the pure reusable layer and remains an explicit
[implementation delta](../.delta/DELTA-001-whole-store-mutable-index.md).
Dependency edges and peer-context topology remain in each root's
`node_modules/.pnpm` with `enable-global-virtual-store=false`.

This is the current admissible pnpm baseline, not the long-term reuse ideal.
Current GVS realizations share mutable topology and repair state and therefore
fail the pure reuse and bounded-authority gates even if they save bytes or time.
The verification contract still measures them to quantify repeated topology
work and inform a future immutable, graph-addressed dependency artifact.

## Placement

| Realization       | Store Cache scope | Virtual-store scope  | Cleanup authority |
| ----------------- | ----------------- | -------------------- | ----------------- |
| local development | one host/user     | Materialization Root | host cache owner  |
| CI                | one job           | Materialization Root | that CI job       |
| Nix prepared deps | builder-owned     | builder-owned        | Nix               |

The local Store Cache path is configurable so operators can place it on an
appropriate volume. Storage placement is excluded from Materialization Profile
identity: moving or discarding a cache does not change dependency identity.

## Import Policy

| Context           | Import method | Gate                                      |
| ----------------- | ------------- | ----------------------------------------- |
| Linux local dev   | `auto`        | cache files and root have equal device ID |
| Darwin local dev  | `auto`        | pnpm filesystem-capability selection      |
| CI                | `auto`        | job-local Store Cache                     |
| Nix prepared deps | Nix policy    | independent of live-install policy        |

Linux fails before installation when device IDs differ; it does not silently
copy and turn a zero-copy goal into per-worktree duplication. On a filesystem
without clone support, pnpm's native `auto` policy may select hardlinks inside
the explicitly mutually trusted same-user boundary. Managed installs never run
package lifecycle mutation over imported dependency files.

The managed contract treats imported dependency files as immutable even when
the operating-system user could deliberately change permissions and mutate a
hardlinked inode. Such direct mutation is outside the trust boundary, while
integrity checks and rematerialization detect or replace corrupted data.

## Concurrency

pnpm owns concurrency inside its Store Cache. Materialization-root locks remain
independent and protect each root's graph and projection. A shared Store Cache
admission lease composes pnpm mutation with host maintenance: every managed
install takes a shared lease, while pruning takes its exclusive counterpart.
Shared leases are compatible, so this is not a host-wide install mutex. Every
managed graph mutation (`install`, lockfile update, or deduplication) therefore
composes as:

```text
Materialization-Root lock + package-manager-home lock
  -> shared Store Cache admission lease
  -> capacity gate
  -> pnpm graph mutation under one realization policy
  -> root-local projection
```

No registry of roots is required: the Store Cache is disposable and does not
own graph identity.

## Host Lifecycle

The host cache owner periodically measures the whole pnpm Store Cache and may
trigger pnpm-native `store prune` on schedule or under disk pressure only
after host-specific evidence proves that the effective import method exposes
live-root reachability to pnpm's pruning semantics. Measured hardlink hosts may
enable destructive pruning; clone, copy, CoW, and unproven hosts remain
measurement-only. Maintenance takes the exclusive Store Cache lease, then
reports bytes before, bytes after, reclaimed bytes, outcome, and dry-run mode.
Root-scoped repair never invokes this operation.

The cache owner does not enumerate Materialization Roots and never deletes
individual pnpm internals itself. Eviction may make a future offline install
miss; it cannot change a declared graph or an already-materialized root.

Legacy external `v11/files` bridges are not followed by managed installs. The
explicit `pnpm:store:migrate-legacy` operation takes the exclusive maintenance
lease, accepts only the declared historical files-pool target, and resets the
disposable v11 metadata inside the selected Store Cache. It preserves the store
root and maintenance-lock inode and leaves the external historical pool
untouched. An already self-contained cache is a successful no-op; any unknown
bridge fails closed.

## Health And Repair

Store health checks verify:

- declared inputs and root install evidence agree;
- root-owned graph metadata exists;
- dependency data referenced by the current graph is present;
- projection health checks pass;
- Linux zero-copy preconditions hold before materialization.

These checks establish current root health, not Store Cache completeness for a
future reinstall. Offline readiness is separate evidence produced by a
no-network reinstall for named declared inputs.

Root repair discards only that root's graph and projections, then reruns strict
pure materialization. Repair may not run lifecycle scripts, mutate sibling
roots, sweep the host Store Cache, or rewrite lockfiles. A low-disk gate runs
before a replacement realization is created so repair does not require an
unbounded overlap of old and new roots.
