# Store Authority Spec

This document specifies store authority. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Scope

This spec defines steady-state storage placement, graph isolation, package
import selection, and root-repair boundaries. It does not define transitional
legacy-store migration, a root registry, named storage profiles, all-root
repair, or host Store Cache garbage collection.

## Requirement Trace

| Section              | Requirements                                           |
| -------------------- | ------------------------------------------------------ |
| Ownership model      | DMP.STORE-R01, DMP.STORE-R02, DMP.STORE-R03            |
| Placement            | DMP.STORE-R03, DMP.STORE-R11, DMP.STORE-R12            |
| Import policy        | DMP.STORE-R09, DMP.STORE-R10                            |
| Concurrency          | DMP.STORE-R08                                           |
| Health and repair    | DMP.STORE-R04, DMP.STORE-R05, DMP.STORE-R06, DMP.STORE-R07 |
| Benchmark evidence   | DMP.STORE-R13, DMP.STORE-R14                            |

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
availability authority. Its mutable index is safe to share inside the same-user
trust boundary because pnpm owns its format and managed installs synchronize
mutation internally. Dependency edges and peer-context topology remain in each root's
`node_modules/.pnpm` with `enable-global-virtual-store=false`.

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

## Concurrency

pnpm owns concurrency inside its Store Cache. Materialization-root locks remain
independent and protect each root's graph and projection. Installation therefore
composes as:

```text
Materialization-Root lock
  -> pnpm install
  -> root-local projection
```

No registry of roots is required: the Store Cache is disposable and does not
own graph identity.

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
