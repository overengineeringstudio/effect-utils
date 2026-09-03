# `tui-core` input-plan benchmark

Date: 2026-08-11

## Question

What does the first generated `tui-core` Buck input-plan target cost under
controlled local cache states, and does it invalidate exactly when a declared
source changes?

This experiment measures the generated Buck target
`//packages/@overeng/tui-core:typescript_input_plan`. It does **not** compare
equivalent Buck and Devenv work: the Buck target creates dependency/input-plan
evidence, while the available Devenv task performs a repository TypeScript
check. Consequently this experiment makes no Buck-versus-Devenv speedup claim.

## Method

| Axis                        | Contract                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notify snapshot             | synthetic clean snapshot `f3276df82c1207767845fe03bb49da8433644f45` (tree `0844af08cab5823c15ad61c8dc188114d28c84b6`) over base `a155f7554def68e0862f2942f10525a53f226f21` |
| Hash-crawler snapshot       | synthetic clean snapshot `a4ce14e155a6169ccd3cddf66dba865b626fc80c` (tree `36eac6d9463f6f231a0084b198519160fea012a7`) over the same base                                   |
| Watchman snapshot           | committed foundation `fa52bb9b4603bbef6cf3011c4ac0dd6b1a16cf32`                                                                                                            |
| Buck work                   | build `//packages/@overeng/tui-core:typescript_input_plan`                                                                                                                 |
| Devenv end-user context     | `devenv tasks run ts:check --show-output --no-tui`                                                                                                                         |
| Devenv compute-only context | `devenv tasks run ts:check --mode single --show-output --no-tui`                                                                                                           |
| Equivalence declaration     | none; contract ID `tui-core-typescript-input-plan/no-equivalent-devenv-lane/v1`                                                                                            |
| Buck binary                 | Nix-pinned Buck2 `2026-04-14-7600cb80070a88b88be67aa5d20d6a93cffa0223`                                                                                                     |
| Execution/cache             | local execution only; remote cache and remote execution disabled                                                                                                           |
| Sampling                    | 1 unreported warmup, 5 measured runs; nearest-rank percentiles; filesystem page cache uncontrolled. Crawler and Watchman reruns were incremental-only.                     |
| Host class                  | Linux 6.18.33, Ryzen 9 7950X3D, 32 logical CPUs, 128 GiB RAM                                                                                                               |

The snapshot commit was created from the reviewed staged/worktree state solely
to obtain a clean detached benchmark input. Raw command logs and local cache
directories are intentionally not retained.

## Result

### Notify result (RED retained)

| Buck phase                                         |       min |       p50 |       p95 | actions p50 | materializations p50 | Verdict                   |
| -------------------------------------------------- | --------: | --------: | --------: | ----------: | -------------------: | ------------------------- |
| action-cold                                        |  39.759 s |  41.415 s |  41.925 s |           5 |                    9 | measured                  |
| same-daemon warm no-op                             | 15.606 ms | 16.746 ms | 17.967 ms |           0 |                    0 | measured                  |
| daemon restart, outputs retained                   |  40.818 s |  42.409 s |  44.040 s |           5 |                    0 | measured                  |
| mtime-only source change                           | 15.217 ms | 17.181 ms | 19.954 ms |           0 |                    0 | measured                  |
| declared-source content edit, default Linux notify | 16.897 ms | 17.253 ms | 18.540 ms |           0 |                    0 | RED; stale declared input |
| unrelated Markdown edit                            | 15.190 ms | 15.773 ms | 16.329 ms |           0 |                    0 | measured                  |

The warm no-op path is cheap while the daemon remains alive. With remote cache
disabled, restarting the daemon retained materialized outputs but still ran five
actions, so local action reuse is currently daemon-scoped for this experiment.

The declared-source edit result was RED, not evidence of correct invalidation.
`src/mod.ts` is passed as an action input by `package_task`, yet the default
Linux notify watcher reported its pnpm directory-symlink alias beneath ignored
`node_modules` rather than refreshing the canonical source node. The action ran
zero times and DICE reused stale state.

### Hash-crawler incremental result (GREEN)

| Buck phase                   |        min |        p50 |        p95 | actions p50 | materializations p50 | Verdict            |
| ---------------------------- | ---------: | ---------: | ---------: | ----------: | -------------------: | ------------------ |
| same-daemon warm no-op       |  41.330 ms |  42.408 ms |  43.353 ms |           0 |                    0 | measured           |
| mtime-only source change     |  41.597 ms |  42.848 ms |  48.978 ms |           0 |                    0 | measured           |
| declared-source content edit | 119.802 ms | 123.945 ms | 129.004 ms |           1 |                    0 | GREEN; invalidated |
| unrelated Markdown edit      |  69.214 ms |  69.726 ms |  71.363 ms |           0 |                    0 | measured           |

Against notify, the crawler adds 25.662 ms to the warm no-op p50 (2.53x) and
25.667 ms to the mtime-only p50 (2.49x). An unrelated edit adds 53.953 ms
(4.42x) because the crawler must rediscover that it is outside this target's
dependency graph. The relevant-edit latency is not a valid speed comparison:
notify returned stale state, while the crawler correctly executed one action.
Cold and daemon-restart phases were intentionally not repeated; the rerun
isolates the steady-state correctness/latency tradeoff.

### Watchman concurrency admission

The crawler's incremental mutation matrix was GREEN, but the full concurrent
repository gate falsified it: a file deleted while the crawler initialized its
whole-tree snapshot caused `DAEMON_STATE_INIT_FAILED` in
`fs_hash_crawler.rs`. Stabilizing oxlint's injected config removed one producer
race but could not make arbitrary concurrent repository tooling safe.

The follow-up therefore configured `[buck2] file_watcher = watchman`, supplied
Watchman from the Nix dev environment, and retained the root/nested
`node_modules` and Cargo `target` ignores. It then used a fresh isolation
directory and the deterministic
package-evidence target for a baseline, delayed declared-source mutation, and
exact byte restoration. The control asserted Buck's `what-ran` count and the
materialized artifact digest at every transition:

| Transition                       | Observed actions | Artifact digest | Verdict                  |
| -------------------------------- | ---------------: | --------------- | ------------------------ |
| baseline                         |    initial build | `4df43c...`     | reference                |
| declared-source content mutation |                1 | `bb404c...`     | GREEN; changed           |
| exact source restoration         |                1 | `4df43c...`     | GREEN; baseline restored |

This resolves the local declared-source correctness defect for the admitted
Watchman configuration. It does not prove the default Linux notify backend or
the whole-tree crawler safe.
The repeatable `scripts/buck2-invalidation-e2e.sh` gate applies the same
baseline/mutate/restore contract to `//buck2/evidence:package_evidence` in an
isolated daemon and restores the fixture bytes through an exit trap.
The same full `check:all` run exercised Watchman concurrently with oxlint,
Cargo, Genie, Buck tests, platform rejection, and the TUI Buck-to-Nix E2E lane.
The committed-tree incremental benchmark produced:

| Buck phase                   |       min |       p50 |       p95 | actions p50 | materializations p50 | Verdict            |
| ---------------------------- | --------: | --------: | --------: | ----------: | -------------------: | ------------------ |
| same-daemon warm no-op       | 14.501 ms | 15.767 ms | 16.654 ms |           0 |                    0 | measured           |
| mtime-only source change     | 15.425 ms | 15.813 ms | 17.353 ms |           0 |                    0 | measured           |
| declared-source content edit | 59.930 ms | 64.324 ms | 66.081 ms |           1 |                    0 | GREEN; invalidated |
| unrelated Markdown edit      | 15.079 ms | 16.189 ms | 17.469 ms |           0 |                    0 | measured           |

Watchman's warm p50 is 0.979 ms lower than the rejected notify snapshot and
26.641 ms lower than the crawler snapshot on this host. These are
within-workload measurements from separate snapshots, not a general performance
claim. Cross-platform admission remains tracked in issue #1055.

The generated `tui-core` target also now carries an explicit
`x86_64-linux` requirement. A fake `aarch64-linux` target control on the x86_64
analysis host failed before execution with the expected platform mismatch. This
proves the local bootstrap fail-closed check, not remote configured-platform
selection; that binding remains an admission gate.

### Devenv context and comparison verdict

The Devenv end-user preparation reached `ts:check` but failed on existing
TypeScript project-boundary errors (`TS6059` and `TS6307`) in this snapshot.
Compute-only samples failed on the same baseline. These lanes therefore have no
timing verdict. They also are not equivalent to the Buck input-plan target, so
even a green run would be contextual overhead data rather than a cross-engine
comparison.

### Limitations

- Five samples make nearest-rank p95 equal to the maximum; treat tail estimates
  as directional only.
- The host was shared and filesystem page cache state was not controlled.
- Cold timing includes first-use external-cell/tool startup costs.
- Remote-cache and remote-execution behavior remain unmeasured.
- Cold and daemon-restart hash-crawler timings were not rerun; only incremental
  overhead and invalidation were measured in the follow-up matrix.
- No claim about TypeScript compilation speed follows from an input-plan target.

The retained machine-readable summary is
`2026-08-11-tui-core-input-plan-benchmark.summary.jsonl` with SHA-256
`965e54d17483f8f3dd1fe58b6ddfab41d04c04473e1becf603afcc3a06e0a7b5`.
Its 26 records retain both runs and tag each record with `buckFileWatcher` and
`benchmarkScope`. The 13-record committed-tree Watchman summary is
`2026-08-11-tui-core-input-plan-watchman.summary.jsonl` with SHA-256
`b0f6e899f42cec700935a0fe413b4b5b156e1aed04fef1c2320d1d8b328dac0d`.

## Conclusion

The target's warm no-op is cheap, but it is not equivalent to TypeScript
checking and makes no cross-engine speed claim. Default Linux notify is rejected
for this pnpm workspace because the declared-source control was stale. Watchman
plus ignored `node_modules` resolves the local correctness seam with exactly one
mutation action, a changed artifact digest, exactly one restoration action,
restoration of the baseline digest, and a GREEN concurrent repository gate. The
rejected hash crawler cost roughly 27 ms more than Watchman on a warm no-op for
these repository snapshots. Cross-platform Watchman admission and remote
configured platforms remain follow-up experiments.

## VRS Impact

- Requires Watchman for the current local pnpm workspace; notify and the hash
  crawler retain their RED evidence.
- Requires package evidence to declare an explicit platform and fail local
  analysis when it differs from the analysis host.
- Does not admit authoritative dependency materialization, remote cache access,
  remote execution, or a Buck-versus-Devenv performance claim.
