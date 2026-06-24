# Store Authority Spec

This document specifies store authority. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Requirement Trace

| Section | Requirements |
| --- | --- |
| Traits | DMP.STORE-R01, DMP.STORE-R02 |
| Shared Pool GC | DMP.STORE-R03, DMP.STORE-R04 |
| Health And Repair | DMP.STORE-R05, DMP.STORE-R06, DMP.STORE-R07 |
| Benchmark evidence | DMP.STORE-R08, DMP.STORE-R09 |

## Traits

| Trait | Use | Writable state | Shared content | GC authority |
| --- | --- | --- | --- | --- |
| `ciJobLocal` | CI/disposable tasks | job-local | none | profile |
| `darwinSplitCas` | macOS local development | profile-local metadata/projection | shared pnpm files pool | shared-pool coordinator |
| `linuxSharedHardlink` | Linux local development after proof | host-local metadata | hardlink-friendly store | shared-pool coordinator |
| `isolated` | fallback/debug | profile-local | none | profile |
| `nixPreparedDeps` | Nix prepared data | immutable Nix store output | Nix store | Nix store |
| `frozenSeed` | future seed | writable overlay if proven | immutable seed | seed owner plus profile |

## Shared Pool GC

```text
active profiles
  -> enumerate referenced metadata roots
  -> mark referenced package content
  -> sweep only unmarked content
```

A command that can see only one profile's metadata must not sweep a shared
content pool.

## Health And Repair

Store health checks verify:

- profile evidence matches selected inputs;
- metadata exists for the selected trait;
- shared package content referenced by the profile is present;
- projection health checks pass;
- offline/no-network checks pass when promised by the trait.

Repair may rerun strict pure materialization, rebuild projection, or ask the
shared-pool coordinator to repair/GC. Repair may not run lifecycle scripts or
rewrite lockfiles.
