# Devenv Tasks Requirements

## Context

Devenv tasks are the standard task runner across our repos. They provide a consistent interface for installs, codegen, linting, testing, and setup. The goal is to keep tasks fast, predictable, and reusable across standalone and megarepo workflows.

## Assumptions

- A1 - These requirements build on [Nix & Devenv Specification](../requirements.md).
- A2 - Devenv tasks are the primary task runner; `dt` is the preferred entrypoint for dependency resolution.
- A3 - Common task modules live in `effect-utils/devenvModules/tasks` and are reused across repos.
- A4 - Devenv task constraints/limitations: (a) task names are namespaces (`devenv tasks run check` runs `check:*`), (b) tasks don’t accept custom CLI flags beyond the task name (use separate tasks or wrappers).

## Requirements

### Must be consistent

- R1 - Use shared task modules from `effect-utils` for common workflows; avoid ad-hoc re-implementations.
- R2 - Task names must be namespaced (e.g. `pnpm:install`, `ts:check`, `lint:fix`).
- R3 - All repos should expose the `dt` wrapper for consistent task invocation.
- R4 - Task design must account for namespace auto-runs (`devenv tasks run check` runs all `check:*`). Avoid mixing slow or destructive tasks into namespaces intended for quick iteration.

Example:

Bad (slow task unintentionally runs when someone expects a quick check):

```nix
tasks."check:quick" = { exec = "echo quick"; };
tasks."check:full" = { exec = "pnpm test"; };
```

Good (separate namespaces for different intent):

```nix
tasks."check:quick" = { exec = "echo quick"; };
tasks."verify:full" = { exec = "pnpm test"; };
```

### Must be clean and deterministic

- R5 - Tasks must be safe to re-run and deterministic given the same inputs, regardless of local cache state. A fresh `git clone` followed by task execution must produce the same result as execution on a warmed environment (CI failures that pass locally indicate a caching/state bug).
- R6 - Setup tasks must not mutate watched `.devenv/*` files (prevents direnv reload loops).
- R7 - Generated files must be written only when content changes (use compare + atomic replace).

### Must be fast

- R8 - Prefer `status` and `execIfModified` to skip up-to-date work.
- R9 - Avoid scanning large trees (e.g. `node_modules`) in task globs.
- R10 - Task execution must produce detailed traces for debugging and performance analysis:
  - (a) Per-task timing: start time, duration, and end time for each task
  - (b) Dependency visualization: which tasks blocked on which, critical path identification
  - (c) Stdout/stderr capture: full output preserved and attributable to specific tasks
  - (d) Structured output format: traces should be exportable (JSON/OTLP) for external analysis
  - (e) Summary statistics: total wall time, parallelism efficiency, cache hit rates
  - (f) Metrics over time: track key metrics (task durations, cache hit rates, total CI time) across runs to identify regressions and trends
  - (g) Observability must be transparent: tracing instrumentation must not alter user-visible output (no extra diagnostics noise on success; errors must still surface clearly on failure)
  - (h) Observability overhead must stay below 10% wall-time compared to uninstrumented execution; when tracing is unavailable, tasks must run with zero overhead (no conditional flags, no parsing)
- R11 - Prefer deterministic, principled caching over ad-hoc shortcuts.
- R12 - Provide a go-to quick check command that runs warm in under 5 seconds.
- R13 - Maximize CPU utilization through optimal parallelism. When running parallel tasks that each spawn workers (e.g., vitest), configure worker limits to avoid over-subscription (total workers across all tasks should approximate available cores).

### Must be resilient

- R14 - Shell entry should provide a working environment on fresh checkout (auto-setup where useful, e.g. dependency installs) while keeping entry time reasonable and avoiding reload loops.
- R15 - Task failures must not block entering the shell; failures should be visible and easy to rerun.
- R16 - Strict mode (`DEVENV_STRICT=1`) should enforce failures for CI or explicit runs.

### Must be clear

- R17 - User-facing tasks must have concise descriptions.
- R18 - Failures must surface actionable context (what failed, how to rerun/fix).
- R19 - Task execution must be visible to users (auto and manual runs), including progress indication.
- R20 - Task dependency graphs must be explicit via `after`/`before`.
- R21 - Task names should appear in shell completions with descriptions.

### Must be verified

- R22 - Task modules must have minimal smoke coverage in the test suite.

## See Also

- [tasks.md](./tasks.md)
