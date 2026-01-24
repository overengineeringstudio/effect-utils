# Devenv Tasks

Devenv tasks are the primary task runner. Use the `dt` wrapper for dependency resolution and shared task modules from `effect-utils/devenvModules` for common patterns.

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

| Namespace | Examples |
|-----------|----------|
| `pnpm:` | `pnpm:install`, `pnpm:install:app`, `pnpm:clean` |
| `bun:` | `bun:install`, `bun:install:scripts` |
| `ts:` | `ts:check`, `ts:build`, `ts:watch`, `ts:clean` |
| `genie:` | `genie:run`, `genie:check`, `genie:watch` |
| `lint:` | `lint:check`, `lint:fix`, `lint:check:format` |
| `test:` | `test:run`, `test:watch`, `test:unit` |
| `check:` | `check:quick`, `check:all` |
| `setup:` | `setup:run`, `setup:gate`, `setup:save-hash` |
| `nix:` | `nix:build`, `nix:hash`, `nix:check` |

## Task Options

### `after` - Declare Dependencies

Run this task after the listed tasks complete:

```nix
tasks = {
  "ts:check" = {
    exec = "tsc --build tsconfig.json";
    after = [ "genie:run" "pnpm:install" ];
  };
};
```

### `before` - Inject as Dependency

Make this task run BEFORE the listed tasks (useful for gates):

```nix
tasks = {
  "setup:gate" = {
    exec = ''
      if [ -d "$(git rev-parse --git-dir)/rebase-merge" ]; then
        echo "Skipping setup during rebase"
        exit 1
      fi
    '';
    before = [ "pnpm:install" "genie:run" "ts:build" ];
  };
};
```

### `status` - Skip If Up-to-Date

Task is skipped if `status` exits 0. Run if non-zero:

```nix
tasks = {
  "pnpm:install:app" = {
    exec = "pnpm install";
    cwd = "./app";
    status = ''
      # Skip if node_modules exists
      [ -d "./app/node_modules" ]
    '';
  };
};
```

### `execIfModified` - File-Based Conditional

Task runs only if specified files changed since last run:

```nix
tasks = {
  "bun:install:scripts" = {
    exec = "bun install";
    cwd = "./scripts";
    execIfModified = [
      "./scripts/package.json"
      "./scripts/bun.lock"
    ];
  };

  "lint:check:format" = {
    exec = "oxfmt --check .";
    execIfModified = [
      "./**/*.ts"
      "./**/*.tsx"
      "!./**/node_modules/**"
    ];
  };
};
```

## Aggregate Tasks

Tasks with no `exec` that just declare dependencies:

```nix
tasks = {
  "check:quick" = {
    description = "Run quick checks";
    after = [ "ts:check" "lint:check" "megarepo:check" ];
  };

  "check:all" = {
    description = "Run all checks including tests";
    after = [ "check:quick" "test:run" ];
  };
};
```

## Setup Tasks (Shell Entry)

Wire tasks to run automatically when entering the devenv shell:

```nix
imports = [
  (inputs.effect-utils.devenvModules.tasks.setup {
    tasks = [ "megarepo:generate" "pnpm:install" "genie:run" "ts:build" ];
    completionsCliNames = [ "genie" "mono" "mr" ];
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

| Module | Type | Tasks Provided |
|--------|------|----------------|
| `genie` | Simple | `genie:run`, `genie:watch`, `genie:check` |
| `megarepo` | Simple | `megarepo:generate`, `megarepo:check` |
| `ts` | Parameterized | `ts:check`, `ts:watch`, `ts:build`, `ts:clean` |
| `setup` | Parameterized | `devenv:enterShell` wiring, `setup:run`, `setup:gate` |
| `check` | Parameterized | `check:quick`, `check:all` |
| `clean` | Parameterized | `build:clean` |
| `test` | Parameterized | `test:run`, `test:watch`, `test:<name>` |
| `lint-oxc` | Parameterized | `lint:check`, `lint:fix`, `lint:check:format` |
| `bun` | Parameterized | `bun:install`, `bun:install:<name>`, `bun:clean` |
| `pnpm` | Parameterized | `pnpm:install`, `pnpm:install:<name>`, `pnpm:clean` |
| `nix-cli` | Parameterized | `nix:hash`, `nix:build`, `nix:check` |

## Example: Full devenv.nix

```nix
{ pkgs, inputs, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
  taskModules = inputs.effect-utils.devenvModules.tasks;
in
{
  imports = [
    inputs.effect-utils.devenvModules.dt
    taskModules.genie
    taskModules.megarepo
    (taskModules.pnpm { packages = [ "." "./app" "./scripts" ]; })
    (taskModules.ts { tsconfigFile = "tsconfig.all.json"; })
    (taskModules.lint-oxc {
      oxlintConfig = "./oxlint.json";
      oxfmtConfig = "./oxfmt.json";
    })
    (taskModules.test { packages = [ "." ]; })
    (taskModules.check {
      lintDeps = [ "lint:check" ];
      testDeps = [ "test:run" ];
    })
    (taskModules.setup {
      tasks = [ "megarepo:generate" "pnpm:install" "genie:run" "ts:build" ];
      completionsCliNames = [ "genie" "mono" "mr" ];
    })
  ];

  packages = [
    pkgs.nodejs_22
    inputs.effect-utils.packages.${system}.genie
  ];
}
```

## Writing Custom Tasks

For repo-specific tasks, define them directly in `devenv.nix`:

```nix
tasks = {
  "deploy:staging" = {
    description = "Deploy to staging";
    exec = "fly deploy --config fly.staging.toml";
    after = [ "check:quick" ];
  };

  "db:migrate" = {
    description = "Run database migrations";
    exec = "bun run migrate";
    cwd = "./app";
  };
};
```

## Debugging Tasks

```bash
# List all available tasks
devenv tasks list

# Run with verbose output
devenv tasks run ts:check --verbose

# See what would run (dry run)
devenv tasks run check:all --mode before --dry-run
```
