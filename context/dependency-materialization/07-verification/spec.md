# Dependency Materialization Verification Spec

This document specifies dependency materialization verification. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Requirement Trace

| Section                | Requirements                                       |
| ---------------------- | -------------------------------------------------- |
| Evidence Tiers         | DMP.VER-R01, DMP.VER-R02, DMP.VER-R03, DMP.VER-R04 |
| Benchmark Matrix       | DMP.VER-R05, DMP.VER-R06, DMP.VER-R07              |
| Evidence Records       | DMP.VER-R08, DMP.VER-R09                           |
| Research Consolidation | DMP.VER-R10                                        |

## Evidence Tiers

```text
fixture checks
  -> synthetic proofs
     -> real-workload benchmarks
        -> cross-system/default gate
```

| Tier                      | Purpose                                                 | Typical cadence                        | Examples                                             |
| ------------------------- | ------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| Fixture checks            | Fast contract regressions                               | PR/CI                                  | policy audit, helper tests, prepared scan fixtures   |
| Synthetic proofs          | Reproduce failure modes and decision logic              | PR or targeted                         | shared prune repro, lifecycle sentinel, doctor model |
| Real-workload benchmarks  | Measure correctness and cache efficiency on real graphs | before defaults                        | isolated vs shared APFS/ext4 profiles                |
| Cross-system/default gate | Prevent unsafe platform generalization                  | before default or shared hash collapse | Darwin/Linux FOD evidence, pending-system markers    |

## Correctness Matrix

| Surface                | Required evidence                                                                                      | Owning subsystem                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Strict pnpm policy     | Reject lifecycle/build override flags before pnpm runs; prove sentinel scripts do not run.             | [01-live-pnpm](../01-live-pnpm/spec.md)                                                                 |
| Bin projection         | Manifest fixture plus pnpm-linker oracle cases; prove missing/stale bins are repaired without scripts. | [02-projections](../02-projections/spec.md)                                                             |
| Prepared deps          | Scan fixtures for `.bin`, leaked state, unexpected `*.node`, and known platform dirs.                  | [03-nix-prepared-deps](../03-nix-prepared-deps/spec.md)                                                 |
| Native packages        | Lockfile-policy audit and graft-file existence checks.                                                 | [03-nix-prepared-deps/02-native-node-packages](../03-nix-prepared-deps/02-native-node-packages/spec.md) |
| Shared store authority | Raw-prune failure repro, doctor refusal, all-root repair plan.                                         | [04-store-authority](../04-store-authority/spec.md)                                                     |
| Buck2 evidence         | Stable declared-input evidence; no live pnpm mutation.                                                 | [05-buck2-evidence](../05-buck2-evidence/spec.md)                                                       |
| Observability          | Fixture records for phase, timing, size, reuse, profile link, and safe paths.                          | [06-observability](../06-observability/spec.md)                                                         |

## Benchmark Matrix

Benchmark records use JSON lines so CI logs, PR comments, and local runs can
share one parser:

```json
{
  "schema": "dependency-materialization-verification/v0",
  "kind": "benchmark",
  "surface": "store-trait",
  "workspace": "effect-utils",
  "platform": "aarch64-darwin",
  "storeTrait": "darwinSplitCas",
  "phase": "offline-reinstall",
  "status": "ok",
  "timingsMs": { "coldA": 1234, "coldB": 640, "offline": 410 },
  "sizes": { "bytes": 973762560, "files": 37887 },
  "downloads": 0
}
```

Skip records are first-class evidence when they are deterministic and explain
why work did not run:

```json
{
  "schema": "dependency-materialization-verification/v0",
  "kind": "benchmark",
  "surface": "store-trait",
  "status": "skipped",
  "reason": "low-disk",
  "availableGiB": 31,
  "requiredGiB": 35
}
```

Default changes require same-workload comparisons against the current default
and an isolated baseline. Cache-efficiency claims must report bytes and file
counts, not only timing.

## Research Consolidation

The dotfiles draft PR
`schickling/dotfiles#1126` is superseded by the effect-utils DMP PR once:

1. shared-store prune/status/repair is represented by store-authority evidence;
2. Buck2 profile evidence is represented by the Buck2 evidence subsystem;
3. store-trait benchmark categories are represented by this verification
   subsystem;
4. remaining platform gaps are tracked as pending evidence rather than as a
   dotfiles-owned VRS.

Research scripts may remain useful as references, but production verification
belongs in effect-utils fixtures, checks, and reusable proof harnesses.
