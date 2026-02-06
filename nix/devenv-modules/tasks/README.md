# Task Organization

This directory contains devenv task modules organized by reusability.

## `shared/` - Reusable Tasks

These tasks are meant to be imported by other repos via the flake input:

```nix
# In another repo's devenv.nix
imports = [
  (inputs.effect-utils.devenvModules.tasks.check {})
  (inputs.effect-utils.devenvModules.tasks.ts {})
  (inputs.effect-utils.devenvModules.tasks.lint-oxc {
    execIfModifiedPatterns = [ "src/**/*.ts" ];
  })
];
```

### Characteristics:

- **Configurable** via function parameters
- **No repo-specific assumptions** (paths, package names, etc.)
- **Exported** in `flake.nix` under `devenvModules.tasks`
- **Documented** with clear usage examples

### Available Modules:

- `check.nix` - Aggregate check tasks (check:quick, check:all)
- `clean.nix` - Clean tasks
- `genie.nix` - Genie config generation tasks
- `lint-oxc.nix` - Linting tasks (oxlint, oxfmt)
  - Note: `lint:check:format`/`lint:fix:format` run oxfmt on an explicit file list
    (git-tracked files) instead of `oxfmt <dir>...` directory walking. This avoids
    flaky "File not found" errors when pnpm is concurrently mutating/symlinking
    `node_modules` during CI.
- `megarepo.nix` - Megarepo workspace tasks
- `nix-cli.nix` - Nix CLI build tasks (nix:hash, nix:build, nix:flake:check)
- `pnpm.nix` - pnpm install tasks
- `setup.nix` - Setup tasks
- `test.nix` - Test tasks
- `test-playwright.nix` - Playwright e2e tasks
- `ts.nix` - TypeScript tasks
- `bun.nix` - Bun tasks (legacy)
- `context.nix` - Context directory tasks
- `lint-genie.nix` - Genie lint tasks
- `git-hooks-fix.nix` - Workaround for [cachix/devenv#2455](https://github.com/cachix/devenv/issues/2455)

## `local/` - Effect-Utils Specific

These tasks are **local to the effect-utils repo** and NOT meant for reuse.
They assume the effect-utils repo structure and are not exported in flake.nix.

### Characteristics:

- **Hardcoded paths** (e.g., `packages/@overeng/*`, `devenv.nix` location)
- **No parameters** - simple inline definitions
- **Not exported** in flake.nix
- **Repo-specific logic** that wouldn't make sense elsewhere

### Available Modules:

- `workspace-check.nix` - Validates `allPackages` in devenv.nix matches filesystem

## `lib/` - Shared Utilities

Helper functions used by task modules:

- `cache.nix` - Task caching utilities

## Adding New Tasks

### For Shared Tasks:

1. Create file in `shared/<name>.nix`
2. Make it a function that accepts configuration parameters
3. Document usage in this README
4. Export in `flake.nix` under `devenvModules.tasks.<name>`
5. Keep it generic - no hardcoded paths

### For Local Tasks:

1. Create file in `local/<name>.nix`
2. Define tasks directly (no parameterization needed)
3. Import directly in `devenv.nix` via relative path:
   ```nix
   imports = [ ./nix/devenv-modules/tasks/local/my-task.nix ];
   ```
4. Do NOT export in flake.nix
