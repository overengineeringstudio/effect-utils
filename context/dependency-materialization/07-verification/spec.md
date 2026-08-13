# Dependency Materialization Verification Spec

This document specifies dependency materialization verification. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Requirement Trace

| Section             | Requirements                                       |
| ------------------- | -------------------------------------------------- |
| Evidence Tiers      | DMP.VER-R01, DMP.VER-R02, DMP.VER-R03, DMP.VER-R04 |
| Benchmark Matrix    | DMP.VER-R05, DMP.VER-R06, DMP.VER-R07              |
| Evidence Records    | DMP.VER-R08, DMP.VER-R09                           |
| Evidence Intake     | DMP.VER-R10                                        |
| Dependency Identity | DMP.VER-R11                                        |
| Topology Reuse      | DMP.VER-R12                                        |

## Evidence Tiers

```text
fixture checks
  -> synthetic proofs
     -> real-workload benchmarks
        -> cross-system/default gate
```

| Tier                      | Purpose                                                 | Typical cadence                        | Examples                                             |
| ------------------------- | ------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| Fixture checks            | Fast contract regressions                               | change/CI                              | policy audit, helper tests, prepared scan fixtures   |
| Synthetic proofs          | Reproduce failure modes and decision logic              | change or targeted                     | shared prune repro, lifecycle sentinel, doctor model |
| Real-workload benchmarks  | Measure correctness and cache efficiency on real graphs | before defaults                        | isolated vs shared APFS/ext4 profiles                |
| Cross-system/default gate | Prevent unsafe platform generalization                  | before default or shared hash collapse | Darwin/Linux FOD evidence, pending-system markers    |

## Correctness Matrix

| Surface                | Required evidence                                                                                        | Owning subsystem                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Strict pnpm policy     | Reject lifecycle/build override flags before pnpm runs; prove sentinel scripts do not run.               | [01-live-pnpm](../01-live-pnpm/spec.md)                                                                 |
| Dependency identity    | Install incompatible peer graphs in both orders; prove pnpm-selected edges and type identity are stable. | [01-live-pnpm](../01-live-pnpm/spec.md)                                                                 |
| Bin projection         | Manifest fixture plus pnpm-linker oracle cases; prove missing/stale bins are repaired without scripts.   | [02-projections](../02-projections/spec.md)                                                             |
| Prepared deps          | Scan fixtures for `.bin`, leaked state, unexpected `*.node`, and known platform dirs.                    | [03-nix-prepared-deps](../03-nix-prepared-deps/spec.md)                                                 |
| Native packages        | Lockfile-policy audit and graft-file existence checks.                                                   | [03-nix-prepared-deps/02-native-node-packages](../03-nix-prepared-deps/02-native-node-packages/spec.md) |
| Shared store authority | Root-local topology proof, shared-content immutability, and raw-prune refusal.                           | [04-store-authority](../04-store-authority/spec.md)                                                     |
| External build adapter | Stable declared-input evidence; no live pnpm mutation.                                                   | Consumer-owned; Buck adapters are specified in [`context/buck2`](../../buck2/spec.md)                   |
| Observability          | Fixture records for phase, timing, size, reuse, profile link, and safe paths.                            | [06-observability](../06-observability/spec.md)                                                         |

## Benchmark Matrix

Benchmark records use JSON lines so CI logs, automation comments, and local
runs can share one parser:

```json
{
  "schema": "dependency-materialization-verification/v0",
  "kind": "benchmark",
  "surface": "storage-sharing",
  "workspace": "effect-utils",
  "platform": "aarch64-darwin",
  "stateScope": "materialization-root",
  "contentPoolScope": "host-shared",
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
  "surface": "storage-sharing",
  "status": "skipped",
  "reason": "low-disk",
  "availableGiB": 31,
  "requiredGiB": 35
}
```

Default changes require same-workload comparisons against the current default
and an isolated baseline. Cache-efficiency claims must report bytes and file
counts, not only timing.

To quantify repeated topology work and evaluate a future Hermetic Dependency
Artifact, the same commit, graph, and machine class must compare:

1. shared Store Cache with root-local virtual stores;
2. shared Store Cache with one shared Global Virtual Store;
3. shared Store Cache with Global Virtual Stores partitioned by declared graph
   or lock identity;
4. isolated Store Cache with root-local virtual stores.

The matrix runs on effect-utils and the real dotfiles/Vista graph across ext4
and APFS. It records extent-aware physical allocation where available, apparent
bytes, files/inodes, downloads, cold/second/warm/offline/repair/concurrent
latency, lock wait, peer/Package Instance identity, injected missing/corrupt
edges, and the scope required to repair one root. Options that fail purity,
identity, data-safety, concurrency, or bounded-repair gates are inadmissible
regardless of their byte or latency result.

The measured package-store policy evidence is recorded in
[`evidence/storage-sharing-default-v2.json`](./evidence/storage-sharing-default-v2.json).
It is pinned to its recorded implementation head and harness checksum rather
than silently acting as a current-head performance baseline. It is
machine-validated against committed raw JSONL records and records
separate real-workload Linux/ext4 and Darwin/APFS cold, warm, isolated,
second-root, and concurrent phase matrices. The same evidence bundle carries
per-host hardlink/prune capability records for hosts that enable destructive
maintenance. Results remain platform- and host-specific: neither platform's
timing, allocation, effective import behavior, nor prune safety may be
generalized to another filesystem or host.

## Evidence Intake And Graduation

Verification may import evidence from prototype branches, downstream
repositories, local experiments, CI artifacts, and historical change records.
Imported evidence is not normative by itself. It graduates into the DMP
verification system only when its durable finding maps to one of these
outcomes:

1. a fixture, smoke test, or policy audit that protects a correctness
   invariant;
2. a synthetic proof that reproduces a known failure mode or decision boundary;
3. a real-workload benchmark with comparable timing, byte, file-count, and
   platform records;
4. a pending evidence marker that prevents overgeneralized default changes;
5. a rejected finding with enough rationale to prevent re-importing the same
   obsolete assumption.

Research may be retired once every durable finding has one of those outcomes.
Historical source material belongs in `.reference/`; project-generated
validation evidence belongs in focused `.experiments/` records.
