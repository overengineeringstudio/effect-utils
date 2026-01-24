# Devenv Tasks Requirements

## Context

Devenv tasks are the standard task runner across our repos. They provide a consistent interface for installs, codegen, linting, testing, and setup. The goal is to keep tasks fast, predictable, and reusable across standalone and megarepo workflows.

## Assumptions

- A1 - These requirements build on [Nix & Devenv Specification](../requirements.md).
- A2 - Devenv tasks are the primary task runner; `dt` is the preferred entrypoint for dependency resolution.
- A3 - Common task modules live in `effect-utils/devenvModules/tasks` and are reused across repos.
- A4 - Devenv treats task names as namespaces: `devenv tasks run check` runs `check:*` tasks (and does not run a plain `check` task), so commands must be hierarchical (e.g. `check:quick`).

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

- R5 - Tasks must be safe to re-run and deterministic given the same inputs.
- R6 - Setup tasks must not mutate watched `.devenv/*` files (prevents direnv reload loops).
- R7 - Generated files must be written only when content changes (use compare + atomic replace).

### Must be fast

- R8 - Prefer `status` and `execIfModified` to skip up-to-date work.
- R9 - Avoid scanning large trees (e.g. `node_modules`) in task globs.
- R10 - Task performance bottlenecks must be easy to identify (timings/logs/traces, clear task names).
- R11 - Prefer deterministic, principled caching over ad-hoc shortcuts.
- R12 - Provide a go-to quick check command that runs warm in under 5 seconds.

### Must be resilient

- R13 - Task failures must not block entering the shell; failures should be visible and easy to rerun.
- R14 - Strict mode (`DEVENV_STRICT=1`) should enforce failures for CI or explicit runs.

### Must be clear

- R15 - User-facing tasks must have concise descriptions.
- R16 - Failures must surface actionable context (what failed, how to rerun/fix).
- R17 - Task dependency graphs must be explicit via `after`/`before`.

### Must be verified

- R18 - Task modules must have minimal smoke coverage in the test suite.

## See Also

- [tasks.md](./tasks.md)
