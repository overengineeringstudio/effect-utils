# Store Authority Spec

This document specifies store authority. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Scope

This spec defines steady-state storage placement, graph isolation, package
import selection, root-repair boundaries, and legacy host-store retirement.
It does not define a persistent root registry, named storage profiles, all-root
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
  immutable per-package archives
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
| Nix archives      | immutable digest  | Nix store            | Nix               |

The local Store Cache path is configurable so operators can place it on an
appropriate volume. Storage placement is excluded from Materialization Profile
identity: moving or discarding a cache does not change dependency identity.

Live pnpm tasks select a job-local Store Cache only when `GITHUB_ACTIONS=true`
or `PNPM_JOB_LOCAL_STORE=1`. Its path is `<root>/.devenv/pnpm-store-pure-v1`,
with a workspace suffix for nested Materialization Roots. Other CI runners must
set the explicit opt-in to preserve job isolation. `CI=1` alone is a non-watch
execution flag, not a Store Cache ownership boundary; dev-host tasks retain the
same-user shared store. `PNPM_SHARED_STORE_DIR` overrides the shared path;
otherwise both root-local and opted-in global virtual stores use the
`storeContract.localDevelopment.defaultPath` from the generated
`pnpm-install-contract.json` (`~/.local/share/pnpm/store-shared-v1`), whose source
is `genie/external.ts`. GVS changes graph placement, not the shared CAS namespace.
Job-local mode disables global virtual store reuse regardless of local opt-ins.

Frozen lockfile verification (`lint:check:lockfile`) resolves storage independently
using the same selection prologue as `pnpm:install`; task-local exports are not
inherited between tasks. It uses the selected store and import method under the
same Materialization-Root mutex and shared Store Cache admission lease, while
`--lockfile-only --frozen-lockfile`
leaves the materialized dependency graph untouched.

## Import Policy

| Context          | Import method   | Gate                                      |
| ---------------- | --------------- | ----------------------------------------- |
| Linux local dev  | `auto`          | cache files and root have equal device ID |
| Darwin local dev | `auto`          | pnpm filesystem-capability selection      |
| CI               | `auto`          | job-local Store Cache                     |
| Nix archives     | no pnpm install | independent of live-install policy        |

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

Normal installs require no registry of roots: the Store Cache is disposable
and does not own graph identity. Host-store retirement explicitly enumerates
registered worktrees before discarding a complete legacy namespace.

## Host Lifecycle

The host cache owner periodically measures the whole pnpm Store Cache and may
trigger pnpm-native `store prune` on schedule or under disk pressure only
after host-specific evidence proves that the effective import method exposes
live-root reachability to pnpm's pruning semantics. Measured hardlink hosts may
enable destructive pruning; clone, copy, CoW, and unproven hosts remain
measurement-only. Maintenance takes the exclusive Store Cache lease, then
reports bytes before, bytes after, reclaimed bytes, outcome, and dry-run mode.
Root-scoped repair never invokes this operation.

pnpm-native pruning does not enumerate Materialization Roots or delete individual
pnpm internals itself. Eviction may make a future offline install miss; it
cannot change a declared graph or an already-materialized root.

Legacy external `v11/files` bridges are not followed by managed installs. The
explicit `pnpm:store:migrate-legacy` operation takes the exclusive maintenance
lease, accepts only the declared historical files-pool target, and resets the
disposable v11 metadata inside the selected Store Cache. It preserves the store
root and maintenance-lock inode and leaves the external historical pool
untouched. An already self-contained cache is a successful no-op; any unknown
bridge fails closed.

### Legacy Host Store Retirement

```text
explicit legacy store -> exclusive maintenance lease -> registered-root census
  -> symlink / inode / link-count proof -> dry-run verdict
  -> explicit apply -> sibling tombstone rename -> tombstone deletion
```

`pnpm:store:retire` owns complete legacy host Store Cache retirement; it is
distinct from `pnpm-store-gc`, which covers historical worktree-local pure
stores. The target must be explicit. The contract shared store and the
`PNPM_SHARED_STORE_DIR` override remain protected, including resolved aliases.
Only a self-contained `v11/files` layout is eligible.

The census uses `git worktree list --porcelain -z` in the current repository.
When `mr` is available, it also lists repositories with `mr store ls --output
json` and runs the same git enumeration against each
`<basePath>/<relativePath>/.bare`. Bare records are excluded; canonical root
paths are deduplicated. Prunable, missing, unreadable, or unsuccessfully
enumerated registrations refuse retirement. This is an enumeration of
registered worktrees, not a scan of every directory on the host.

Every enumerated root is inspected recursively for root and nested workspace
`node_modules`. Discovery skips only `.git` and follows directory aliases,
including linked workspace packages; consumer scans follow all directory
symlinks. Unresolvable links and filesystem-read errors fail closed. Symlinks
resolving into the target, including `.pnpm` and GVS links, refuse retirement
and identify every offending root. Package-file `(st_dev, st_ino)` identities
are compared with the target's CAS `files` tree; any match refuses retirement.
Unaccounted hardlink counts also refuse retirement even when the owning root
is not registered. Internal GVS links are allowed only within the target;
external store bridges are not eligible.

The default is a non-destructive eligibility verdict and size report; deletion
requires explicit `pnpm-store-retire --apply` or `PNPM_RETIRE_APPLY=1` for the
devenv task. Select its target with `PNPM_RETIRE_STORE_DIR`; the CLI also accepts
a positional target. Dry-run may create the maintenance-lock file. The exclusive
`acquire_pnpm_store_cache_lease` admission lease covers census, proof, rename,
and deletion. Apply first atomically renames the complete store to a sibling
tombstone, then removes only that tombstone. Interruption during deletion
therefore leaves a tombstone, not a half-deleted live namespace. Unmanaged
writers do not participate in the lease and must be quiesced by the owner.

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
