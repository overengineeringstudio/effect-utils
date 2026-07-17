# Store Authority Spec

This document specifies store authority. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Requirement Trace

| Section            | Requirements                                |
| ------------------ | ------------------------------------------- |
| Ownership          | DMP.STORE-R01, DMP.STORE-R02                |
| Shared Pool GC     | DMP.STORE-R03, DMP.STORE-R04                |
| Health And Repair  | DMP.STORE-R05, DMP.STORE-R06, DMP.STORE-R07 |
| Benchmark evidence | DMP.STORE-R08, DMP.STORE-R09                |

## Ownership

```text
Materialization Root
  owns writable Dependency Graph and Projection State
  may reference Shared Content Pool

Shared Content Pool
  contains immutable content-addressed Dependency Data only
  has no effect-utils-managed GC without a pool-wide authority
```

CI keeps both writable state and package content job-local. Local development
keeps graph and projection state root-local and may share immutable package
content. Nix prepared dependency data is an immutable build output. These are
independent placement facts, not members of one preset taxonomy.

## Shared Pool GC

```text
active Materialization Roots
  -> enumerate referenced metadata roots
  -> mark referenced package content
  -> sweep only unmarked content
```

effect-utils currently provides no managed Shared Content Pool GC. A future GC
operation requires an authority that can enumerate every active root that
references the pool. An effect-utils-managed root operation refuses to sweep
the pool without that authority; this contract does not claim to intercept
raw package-manager or filesystem commands outside effect-utils.

## Health And Repair

Store health checks verify:

- declared inputs and install evidence agree;
- root-owned graph metadata exists;
- dependency data referenced by the current graph is present;
- projection health checks pass;

These checks establish current root health, not Shared Content Pool completeness
for a future reinstall. Offline readiness is separate evidence produced by a
no-network reinstall for named declared inputs.

Root repair discards only that root's graph and projections, then reruns strict
pure materialization. Repair may not run lifecycle scripts, mutate sibling
roots, sweep the Shared Content Pool, or rewrite lockfiles.
