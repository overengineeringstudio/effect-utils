# Devenv evaluation budget

Date: 2026-09-14
Host: dev3 (x86_64-linux)

## Question

Does effect-utils meet the warm shell-entry budget of 20 seconds and the no-op
task-run overhead budget of 2 seconds? Which recursive eval-cache inputs and
task-closure edges account for any remaining cost?

## Method

The method follows the dotfiles devenv RCA rather than treating total command
wall time as devenv overhead. Every timed sample records the command, repetition
count, the one-minute load average from `uptime`, and `/proc/pressure/cpu`
immediately before the command. Absolute measurements run only while the
one-minute load average is below 32. The acceptance comparison uses at least
three samples taken below load 16.

Four probes separate the relevant regimes:

1. Warm shell entry: run `devenv shell -- true` at least three times after one
   untimed warm-up. This measures shell capture plus entry hooks with an existing
   eval cache.
2. Forced eval-cache miss: move `.devenv/nix-eval-cache.db` aside for one
   `devenv shell -- true`, then restore or retain the resulting database after
   the sample. This measures the configuration and lock-change regime that a
   fresh CI checkout also encounters.
3. No-op task dispatch: add a temporary local no-op task, warm shell and task
   state, then run `devenv tasks run <no-op>` at least three times. The task's
   own work is `true`, so elapsed time beyond that command is task-run overhead.
4. Eval-cache surface: query `file_input`, `eval_input_path`, and `cached_eval`
   in `.devenv/nix-eval-cache.db`. For each cached attribute, retain only
   recursive directory inputs attached to that current cached evaluation and
   count regular files and bytes below each root. Stale `file_input` rows without
   an `eval_input_path` edge are excluded.

One shell-entry sample also uses devenv's native `--trace-to` path. The retained
`.otel/` trace is reduced to a span tree by pairing span start and end records.
The trace establishes phase structure and shares; the untraced samples establish
absolute wall time because verbose tracing adds overhead.

Source reading before measurement found:

| Structural fix from dotfiles decision 0027                         | effect-utils state | Source evidence                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use a guarded `git+file://` flake reference instead of a bare path | Present            | `devenv.nix` asserts that `.git` exists before it calls `builtins.getFlake "git+file://…"`.                                                                      |
| Keep repository mutation out of shell entry                        | Present            | `devenv.nix` sets `runOnEnterShell = false` and leaves `requiredTasks` empty.                                                                                    |
| Keep derivation references out of task `env`                       | Fixed              | `test:buck2-tools` now resolves its three tool paths in `exec`; a source test rejects derivation interpolation in that task's `env`.                             |
| Replace wide source coercion roots with per-subtree roots          | Fixed              | Buck stage-zero and shared Rust sources stage narrow filesets, bootstrap closure reads individual paths, and workflow reports use the flake-packaged `ci-tools`. |
| Gate recursive eval-cache inputs                                   | Fixed              | `check:devenv-eval-inputs` joins current cache edges and is a member of `check:quick` and `check:all`.                                                           |

## Result

All accepted timing samples ran with one-minute load below 16. Every preamble
also recorded CPU pressure; `full avg10` was 0.00 for every sample.

| Probe                                                                     | Repetitions | Wall time                                 | Start load          | CPU `some avg10`   | Result                                    |
| ------------------------------------------------------------------------- | ----------: | ----------------------------------------- | ------------------- | ------------------ | ----------------------------------------- |
| Warm shell, `devenv shell -- true`                                        |           3 | 3.454 s, 0.316 s, 0.316 s; median 0.316 s | 13.18, 13.09, 13.09 | 1.67, 1.48, 1.48   | PASS: all samples are below 20 s          |
| Warm no-op dispatch, `DEVENV_TUI=false devenv tasks run measurement:noop` |           3 | 0.272 s, 0.219 s, 0.200 s; median 0.219 s | 13.74 for all three | 1.17 for all three | PASS: all samples are below 2 s           |
| Forced eval-cache miss before the final source-root fixes                 |           1 | 326.412 s                                 | 11.71               | 3.44               | Diagnostic baseline                       |
| Forced eval-cache miss after the final source-root fixes                  |           1 | 58.177 s                                  | 15.37               | 1.90               | 82.2% lower, but not an acceptance budget |

The no-op task existed only in ignored `devenv.local.nix` during measurement and
was removed afterward. Its own recorded execution was 5.99–6.40 ms.

The initial cache query found 83,376 recursive files for each of `bash:build`,
`devenv.config.dotenv`, `devenv.config.task.config:build`, and `shell`.
The repository root alone contributed 83,365 files. The wide roots came from
Buck stage-zero, bootstrap closure, shared Rust packaging, and the default
workflow-report package. Narrow staging preserved each derivation's required
layout without retaining the repository root as an eval-cache input.

The final cache contains the same four narrow roots for each current attribute:

| Cached attribute                  | Recursive roots | Files | Regular-file bytes |
| --------------------------------- | --------------: | ----: | -----------------: |
| `devenv.config.dotenv`            |               4 |   100 |          1,082,499 |
| `devenv.config.task.config:build` |               4 |   100 |          1,082,499 |
| `shell`                           |               4 |   100 |          1,082,499 |

The roots are `nix/devenv-modules/otel/dashboards` (8 files),
`nix/provider-clis/netlify-cli` (3), `packages/@overeng/otelite` (50), and
`rust` (39). The production checker completed in 90 ms at load 9.71 and passed
the 50,000-file limit. Its synthetic control proves the over-budget diagnostic
names `shell`, the exact-budget case passes, orphaned historical inputs are
excluded, and newline-bearing paths remain intact.

The retained native trace at `.otel/devenv-entry.json` used
`devenv --trace-to json:file:.otel/devenv-entry.json shell -- true`. It ran in
3.292 s at load 19.33 (`some avg10=1.51`, `full avg10=0.00`), so it is structural
evidence rather than an acceptance sample. Paired start/end records give this
top-level tree:

```text
validating lock                         0.032 s
initializing Nix backend                0.042 s
configuring shell                       2.806 s
  reading config.cachix.enable          1.093 s
  evaluating shell                     1.686 s
    checking shell evaluation cache    1.686 s
capturing shell environment subprocess 0.040 s
loading tasks                           0.020 s
running tasks                           0.064 s
```

The trace shows that cached configuration reads, not shell hooks, dominate the
warm traced sample. The shell command returns zero, although the existing
git-hooks task logs a refused installation because policy configures
`core.hooksPath` outside the repository. The warm trace spent 39 ms in that
failed task.

## Conclusion

The warm shell and no-op dispatch budgets pass with three eligible samples each.
The cache guard passes with 100 recursive files per current attribute, down from
83,376. The task environment has no derivation-valued local overrides, and the
wide source roots are replaced without weakening standalone workflow-report
packaging.

The proposed residual-complexity row is:

| ID                               | Status   | Producer |            Machinery change | Dissolution check                                                                                                                                                                                  |
| -------------------------------- | -------- | -------- | --------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect-utils/devenv-eval/shell` | residual | devenv   | +282 / -38 lines (net +244) | Delete the custom guard and staging only when an upstream mechanism enforces the recursive-input budget and the warm-shell ≤20 s and no-op ≤2 s budgets still pass with `n >= 3` at load below 16. |

The line count excludes VRS documents, tests, generated files, and lockfiles.
The +216-line guard is reusable policy and diagnostics; the source staging is
net +28 lines; task-environment decoupling is net -2 lines; and the local-trace
ignore is +2 lines. The row remains open because current runtime evidence proves
the budget, but does not replace the regression guard with a smaller upstream
mechanism.

## VRS Impact

This experiment exercises the existing developer-entry contract: devenv remains
the check verb, while its shell-entry and dispatch costs become explicit
budgets. It does not change Buck authority, task semantics, cache trust, or the
repository's check interface.
