# Dependency Profile Proof Catalog

This catalog records the durable proof and benchmark findings imported into the
DMP verification VRS. It is non-normative evidence; requirements and specs state
the current contract.

## Shared Store Authority

### Split store prune hazard

Hypothesis: a macOS-style split store with profile-local metadata and shared
`v11/files` can be corrupted by running `pnpm store prune` through only one
profile store.

Method: create two pnpm 11 projects with separate metadata stores whose
`v11/files` symlink to one shared files pool; install overlapping dependencies;
prune store A; attempt offline reinstall for project B.

Result:

- profile-local prune removed every file in the shared pool in the tracked
  proof run;
- project B offline reinstall failed with `ERR_PNPM_NO_OFFLINE_TARBALL`;
- an isolated-store control passed after pruning store A;
- Darwin teardown exits such as 137 could appear after materialization and had
  to be classified by checking install state.

Conclusion: per-store prune is not a valid maintenance operation for a shared
files pool. Shared-pool GC must mark from every active profile root or refuse to
sweep.

### Store status false clean

Hypothesis: `pnpm store status` is insufficient health evidence for split
shared-files pools.

Result:

- shared files after install: 12;
- shared files after profile A prune: 0;
- profile B `pnpm store status` before prune: exit 0;
- profile B `pnpm store status` after prune: exit 0;
- profile B offline reinstall after prune: exit 1 with missing offline tarball.

Conclusion: shared-pool health must check required package files or an
equivalent offline fetch/projection probe. Store status alone can be falsely
clean for sibling roots.

### Guard, doctor, and repair

Guard proof:

- profile-local files pool: allow;
- shared or indirect files pool: refuse;
- broken shared files link: refuse;
- missing files pool: refuse.

Doctor/repair fixture:

```json
{"profile":"profile-a","phase":"doctor","status":"refuse-raw-prune","reason":"shared-files-pool"}
{"profile":"profile-b","phase":"doctor","status":"refuse-raw-prune","reason":"shared-files-pool"}
{"profile":"shared","phase":"files-after-unsafe-prune","status":"ok","files":0}
{"profile":"profile-b","phase":"offline-after-unsafe-prune","status":"fail_1"}
{"profile":"profile-a","phase":"repair","status":"ok"}
{"profile":"profile-b","phase":"repair","status":"ok"}
{"profile":"profile-b","phase":"offline-after-coordinated-repair","status":"ok"}
```

Registry model:

```json
{"phase":"shared-doctor","status":"refuse-raw-prune","reason":"shared-files-pool","siblings":["profile-a","profile-b"]}
{"phase":"isolated-doctor","status":"allow-profile-local-prune","reason":"profile-local-files-pool","siblings":["profile-c"]}
{"phase":"broken-doctor","status":"refuse-raw-prune","reason":"invalid-files-pool","siblings":["profile-d"]}
{"phase":"shared-repair-plan","status":"repair-all-roots"}
{"phase":"empty-repair-plan","status":"refuse","reason":"no-registered-roots"}
```

Conclusion: production repair can be a deterministic registry lookup,
files-pool classification, sibling enumeration, and all-roots repair plan.

## Store-Trait Benchmarks

### Synthetic overlap baseline

| Trait        |   Host-wide size |   File count |
| ------------ | ---------------: | -----------: |
| isolated     | about 94,260 KiB | about 20,041 |
| split files  | about 35,676 KiB |  about 2,157 |
| shared store | about 35,676 KiB |  about 2,157 |

Conclusion: removing sharing would be a correctness simplification but would
discard a large cache-efficiency win.

### Linux ext4 copy versus hardlink smoke

| Import   | Trait        | Store KiB | Files KiB | File count |
| -------- | ------------ | --------: | --------: | ---------: |
| copy     | isolated     |    96,876 |    96,876 |     20,037 |
| copy     | split files  |    85,528 |    36,704 |      2,157 |
| copy     | shared store |    37,116 |    36,704 |      2,157 |
| hardlink | isolated     |    49,512 |    49,512 |     20,037 |
| hardlink | split files  |    38,156 |    36,704 |      2,157 |
| hardlink | shared store |    37,116 |    36,704 |      2,157 |

All copy and hardlink phases passed offline reinstall. Total benchmark tree
footprint dropped from 273 MiB with copy import to 135 MiB with hardlink
import.

Conclusion: `linuxSharedHardlink` is a first-class candidate trait, but it
still needs real-repo and concurrent-run proof before becoming a default.

### Downstream monorepo APFS real profile

| Trait        |                            cold-a |                            cold-b |     offline-b |
| ------------ | --------------------------------: | --------------------------------: | ------------: |
| isolated     |                    `ok` / 34.674s | `materialized_exit_134` / 24.467s | `ok` / 9.408s |
| split-files  |                    `ok` / 30.680s |                    `ok` / 24.171s | `ok` / 9.775s |
| shared-store | `materialized_exit_134` / 24.963s |                    `ok` / 17.402s | `ok` / 8.147s |

Footprint after two cold materializations:

| Trait        |  Store KiB | Shared/files KiB | Project KiB | node_modules KiB | File count |
| ------------ | ---------: | ---------------: | ----------: | ---------------: | ---------: |
| isolated     | 10,752,160 |       10,752,160 |   2,798,472 |        2,678,284 |    445,794 |
| split files  |  8,127,804 |        2,517,760 |   2,872,860 |        2,752,672 |     61,481 |
| shared store |  2,533,060 |        2,517,760 |   2,872,860 |        2,752,672 |     61,481 |

Offline reinstall reused 998 packages, downloaded 0 packages, and completed for
all traits.

Conclusion: the sharing motivation holds at real graph scale. The correct
direction is coordinated all-roots authority for shared content, not a blanket
fallback to isolated stores.

### effect-utils APFS real profile

Split-files and shared-store passed cold materialization and offline reinstall
with 0 downloads. Shared-store cold B took 0.634s. Both shared traits used about
950,940 KiB and 37,887 package files.

Conclusion: the same sharing shape works for a linked external workspace, not
only a root monorepo projection.

### LiveStore-scale partial benchmark

Split-files passed cold A/B plus offline reinstall. Shared-store cold A passed,
then the harness stopped before cold B because the disk guard reported
`skipped_low_disk` at 31 GiB available against a 35 GiB floor.

Conclusion: skip records are valid evidence. Low disk must stop broad
benchmarks before mutation rather than producing partial or misleading results.

## CI And Low-Disk Proofs

### CI job-local isolation

Two concurrent job-local installs used distinct `HOME`, `PNPM_HOME`,
`XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, npm config, and store directories. Pruning
job A did not break job B offline reinstall.

```json
{"job":"all","phase":"authority","status":"job_local"}
{"job":"job-a","phase":"prune-own-store","status":"done"}
{"job":"job-b","phase":"offline-after-job-a-prune","status":"ok","rc":0}
```

Conclusion: `ciJobLocal` preserves the simple CI invariant that one job cannot
delete another job's required blobs.

### Low-disk guard

Forced disk floor result:

```json
{
  "trait": "all",
  "phase": "disk-floor",
  "status": "skipped_low_disk",
  "ms": 0,
  "availableGiB": 76,
  "floorGiB": 999999
}
```

The command exited 75 before install work started.

Conclusion: benchmarks and repair commands need machine-readable skip records
and must fail before mutation when disk floors are not met.

## Native And Lifecycle Proofs

### Optional native packages with lifecycle policy

Packages: `esbuild@0.27.7`, `sharp@0.34.5`, `lightningcss@1.30.2`.

| Trait        | cold-a                  | cold-b                  | offline-b | Runtime probe                           |
| ------------ | ----------------------- | ----------------------- | --------- | --------------------------------------- |
| isolated     | `materialized_exit_134` | `materialized_exit_137` | `ok`      | `ok` before and after offline reinstall |
| split files  | `materialized_exit_137` | `ok`                    | `ok`      | `ok` before and after offline reinstall |
| shared store | `materialized_exit_134` | `materialized_exit_134` | `ok`      | `ok` before and after offline reinstall |

Footprint after two cold materializations:

| Trait        | Store KiB | Files KiB | File count |
| ------------ | --------: | --------: | ---------: |
| isolated     |   144,380 |   144,380 |      1,896 |
| split files  |   109,516 |    36,196 |        165 |
| shared store |    36,496 |    36,196 |        165 |

Conclusion: native package behavior can preserve offline correctness with
shared package files, but pnpm build approvals are dependency profile inputs.

### Native binding fixture

`better-sqlite3@12.5.0` was installed in an isolated temporary workspace
outside the parent repo. Runtime probes passed after cold install and offline
reinstall, and the native `.node` binding existed.

```json
{"phase":"cold","status":"materialized_exit_134","ms":1842}
{"phase":"probe-cold","status":"ok","probe":{"value":42}}
{"phase":"offline","status":"ok","ms":344}
{"phase":"probe-offline","status":"ok","probe":{"value":42}}
{"phase":"native-binding","status":"present"}
{"phase":"build-mode","status":"source-build-not-observed"}
```

Conclusion: native binding runtime/offline behavior is covered, but this did
not close the true source-build gate.

### Local source-built native addon

A generated local `node-gyp` addon under `$TMPDIR` compiled from source with
`CC=clang` and `CXX=clang++`.

```json
{"phase":"cold","status":"materialized_exit_134","ms":4444,"rc":134}
{"phase":"probe-cold","status":"ok","probe":{"value":42}}
{"phase":"native-binding","status":"present"}
{"phase":"build-mode","status":"source-build-observed"}
{"phase":"offline","status":"ok","ms":1367,"rc":0}
{"phase":"probe-offline","status":"ok","probe":{"value":42}}
```

Compile evidence included `node-gyp rebuild`, `CXX(target)`, `SOLINK_MODULE`,
and `gyp info ok`.

Conclusion: source-built native compilation is covered by an explicit local
fixture. Native build toolchain selection belongs in the profile policy surface.

## Profile Evidence, Nix, And FOD Freshness

### Profile evidence determinism

```json
{"phase":"same-inputs","status":"stable"}
{"phase":"lockfile-mutation","status":"profile_changed"}
{"phase":"trait-mutation","status":"authority_changed"}
{"phase":"summary","status":"ok","inputCount":445,"manifestCount":401,"patchCount":41}
```

Conclusion: profile identity can exclude local output paths, remain stable for
same inputs, and change for lockfile or store-trait mutations.

### Topology planner and Nix CLI evidence

```json
{"phase":"linked-root-symlinked-inputs","status":"covered","manifestCount":401,"patchCount":41,"opProxyClosureMembers":26}
{"phase":"source-only-mutation","status":"ignored"}
{"phase":"manifest-mutation","status":"profile_changed"}
{"phase":"nix-authority","status":"encoded"}
{"phase":"summary","status":"ok","closureMembers":26,"fodInputs":29}
```

Conclusion: Nix-contained TypeScript CLI prepared deps can use the same
topology/profile identity without source-only CLI edits invalidating dependency
preparation.

### FOD freshness profile model

```json
{"phase":"same-inputs","status":"fresh"}
{"phase":"source-only-mutation","status":"fresh"}
{"phase":"manifest-mutation","status":"refresh-fod"}
{"phase":"invalid-record","status":"refused"}
```

Conclusion: FOD freshness can be driven by shared profile evidence. Source-only
edits stay fresh, dependency manifest edits request refresh, and contradictory
metadata is refused.

## Buck2 Evidence Boundary

Prototype target shape:

```json
{
  "schema": "dependency-profile-evidence/v0",
  "inputs": [
    { "path": "buck2-research/profile-inputs/package.json", "sha256": "..." },
    { "path": "buck2-research/profile-inputs/pnpm-lock.yaml", "sha256": "..." },
    { "path": "buck2-research/profile-inputs/pnpm-workspace.yaml", "sha256": "..." },
    { "path": "buck2-research/profile-inputs/toolchain.json", "sha256": "..." }
  ],
  "materializationStrategy": "local-profile-managed-pnpm",
  "buckAuthority": "prototype"
}
```

Clean-root watch comparison:

| Scenario               | Follow-up action                                          | Buck watch events |
| ---------------------- | --------------------------------------------------------- | ----------------: |
| repo-like source root  | add 200 generated files under source root                 |               619 |
| ignored in-source path | add 200 generated files under ignored-looking source path |               608 |
| minimal clean root     | repeat no-op build                                        |                19 |
| external output root   | add 200 generated files outside source root               |                 0 |

Evidence oracle:

```json
{"phase":"first","status":"ok"}
{"phase":"schema","status":"ok"}
{"phase":"external-root","status":"mutated"}
{"phase":"after-external-mutation","status":"ok"}
{"phase":"stable-after-external-mutation","status":"ok","sha256":"1f60cf12facf78150d7372ea0490471a5c5f5580fa8a32a1da52a2e2184b554e"}
```

Conclusion: Buck2 should consume deterministic profile evidence while mutable
pnpm materialization remains outside watched source roots and outside cacheable
Buck2 actions.
