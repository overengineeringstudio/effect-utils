# Devenv Tasks

Devenv tasks are the primary task runner. Use the `dt` wrapper for dependency resolution and shared task modules from `effect-utils/devenvModules` for common patterns.

Upstream behavior reference: https://devenv.sh/tasks/

## The `dt` Wrapper

The `dt` command runs devenv tasks with automatic dependency resolution:

```bash
dt pnpm:install          # Runs pnpm:install and its dependencies
dt check:quick           # Runs quick checks (ts:check, lint:check, etc.)
dt lint:fix              # Runs lint fixes
```

**Import in devenv.nix:**

```nix
imports = [ inputs.effect-utils.devenvModules.dt ];
```

Under the hood, `dt` runs `devenv tasks run "$@" --mode before`, which executes all tasks listed in the target's `after` dependencies first.

## Task Naming Convention

Use namespaced names consistently across repos:

| Namespace | Examples                                         |
| --------- | ------------------------------------------------ |
| `pnpm:`   | `pnpm:install`, `pnpm:install:app`, `pnpm:clean` |
| `bun:`    | `bun:install`, `bun:install:scripts`             |
| `ts:`     | `ts:check`, `ts:build`, `ts:watch`, `ts:clean`   |
| `genie:`  | `genie:run`, `genie:check`, `genie:watch`        |
| `lint:`   | `lint:check`, `lint:fix`, `lint:check:format`    |
| `test:`   | `test:run`, `test:watch`, `test:unit`            |
| `check:`  | `check:quick`, `check:all`                       |
| `setup:`  | `setup:run`, `setup:gate`, `setup:save-hash`     |
| `nix:`    | `nix:build`, `nix:hash`, `nix:check`             |

Reminder: `devenv tasks run check` executes all `check:*` tasks and does not run a plain `check` task.

## Task Mechanics (Upstream Behavior)

Use task dependencies (`before`/`after`), `status` checks, and `execIfModified` in shared task modules. Avoid re-implementing basic task patterns per repo.

Notes from the upstream docs:

- `status` output is cached and reused for dependent tasks.
- `execIfModified` uses timestamps plus content hashing to avoid false positives.
- Namespaces can be executed as a group (e.g. `devenv tasks run lint`).

## Setup Tasks (Shell Entry)

Wire tasks to run automatically when entering the devenv shell:

```nix
imports = [
  (inputs.effect-utils.devenvModules.tasks.setup {
    tasks = [ "megarepo:generate" "pnpm:install" "genie:run" "ts:build" ];
    completionsCliNames = [ "genie" "mr" ];
  })
];
```

This creates:

- `devenv:enterShell` depends on your tasks
- `setup:gate` blocks during git rebase
- `setup:save-hash` caches git hash to skip unchanged setups
- `setup:run` forces re-run with `FORCE_SETUP=1`
- Shell entry is non-blocking by default; failures print warnings
- Set `DEVENV_STRICT=1` to enforce setup tasks and fail fast

For warm shells (< 500ms), the git hash check skips setup when HEAD hasn't changed.
Strict mode (`DEVENV_STRICT=1`) makes setup tasks fail fast.

## Available Task Modules

Import from `inputs.effect-utils.devenvModules.tasks`:

| Module     | Type          | Tasks Provided                                         |
| ---------- | ------------- | ------------------------------------------------------ |
| `genie`    | Simple        | `genie:run`, `genie:watch`, `genie:check`              |
| `megarepo` | Simple        | `megarepo:sync`, `megarepo:generate`, `megarepo:check` |
| `ts`       | Parameterized | `ts:check`, `ts:watch`, `ts:build`, `ts:clean`         |
| `setup`    | Parameterized | `devenv:enterShell` wiring, `setup:run`, `setup:gate`  |
| `check`    | Parameterized | `check:quick`, `check:all`                             |
| `clean`    | Parameterized | `build:clean`                                          |
| `test`     | Parameterized | `test:run`, `test:watch`, `test:<name>`                |
| `lint-oxc` | Parameterized | `lint:check`, `lint:fix`, `lint:check:format`          |
| `bun`      | Parameterized | `bun:install`, `bun:install:<name>`, `bun:clean`       |
| `pnpm`     | Parameterized | `pnpm:install`, `pnpm:install:<name>`, `pnpm:clean`    |
| `nix-cli`  | Parameterized | `nix:hash`, `nix:build`, `nix:check`                   |

## Repo-Specific Tasks

Keep custom tasks minimal and repo-specific. Use shared task modules for common flows and prefer small, focused task definitions when you do need custom tasks.

## Debugging Tasks

```bash
# List all available tasks
devenv tasks list

# Run with verbose output
devenv tasks run ts:check --verbose

# See what would run (dry run)
devenv tasks run check:all --mode before --dry-run
```
