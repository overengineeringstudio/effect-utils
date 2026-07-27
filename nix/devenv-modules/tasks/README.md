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
    lintPaths = [ "src" "test" ];
    geniePatterns = [ "*.genie.ts" ];
    genieCoverageDirs = [ "." ];
  })
];
```

## Observability

Import the sibling observability module once to capture native devenv spans
and effect-utils task spans as one otelite trace:

```nix
imports = [
  (inputs.effect-utils.devenvModules.observability {
    project = "my-repo";
    # Optional: compose the full Collector/Tempo/Grafana stack.
    backend = "auto";
    # Optional: gate an existing aggregate task on the hermetic shape check.
    wireInto = [ "check:all" ];
  })
];
```

The default `backend = "ambient"` adds only `otel-span`, otelite, and the
`otel:profile:setup` / `otel:verify:setup` tasks. Task wrappers resolve the
module-owned bridge through `OTEL_SPAN_BIN`, so nested devenv task environments
do not depend on ambient `PATH`. The module intentionally avoids the full local
observability stack. Override `profile` to capture a different task graph, or
set `profile = null` when only the packages and project attribution are needed.

### Characteristics:

- **Configurable** via function parameters
- **No repo-specific assumptions** (paths, package names, etc.)
- **Exported** in `flake.nix` under `devenvModules.tasks`
- **Documented** with clear usage examples

### Available Modules:

- `check.nix` - Aggregate check tasks (check:quick, check:all, configurable strict typecheck gate)
- `clean.nix` - Clean tasks
- `genie.nix` - Genie config generation tasks
- `lint-oxc.nix` - Linting tasks (oxlint, oxfmt)
  - `lintPaths` are Git pathspecs. The lint tasks enumerate tracked and untracked
    non-ignored files through `git ls-files` before calling oxlint/oxfmt, and do
    not use devenv's `execIfModified` glob walker.
- `megarepo.nix` - Megarepo workspace tasks
- `nix-cli.nix` - Nix CLI build/check tasks
- `pnpm.nix` - pnpm install tasks
  - Local development shares one complete pnpm Store Cache between trusted
    roots of the same OS user; CI uses a job-local Store Cache.
  - Dependency graphs, `node_modules/.pnpm`, projections, and repair remain
    Materialization-Root-owned.
  - Managed installs use pnpm's `auto` import policy and reject cross-device
    Linux storage before materialization.
  - `pnpm:store:migrate-legacy` explicitly replaces only the recognized
    historical `v11/files` bridge under the exclusive cache lease; normal
    installs and unknown bridges fail closed.
  - Frozen installs use the current guarded pnpm runtime, while `pnpm:update`
    uses a separate pnpm 11.5.1 lock mutator. Root updates generate projections
    with validation deferred, repair the lock, then require `genie --check`;
    retained package records are rejected transactionally if they lose
    `hasBin` metadata.
- `setup.nix` - Setup tasks
  - `skipNonInteractive = true` keeps automatic shell entry cheap for
    non-interactive callers; `DEVENV_FORCE_SETUP=1` explicitly overrides it.
- `test.nix` - Test tasks
- `test-playwright.nix` - Playwright e2e tasks
- `ts.nix` - TypeScript tasks (`ts:check`, `ts:check:strict`, build/watch/clean helpers)
  - `ts:check`, `ts:check:strict`, `ts:build`, `ts:build-watch`, `ts:emit`, and `ts:clean` default to the Nix-managed `tsgo` binary; `ts:emit` uses a dedicated emit graph for no-check emit.
  - `ts:check:strict` inherits repo-local `ts:check.after` hooks so strict CI stays aligned with consumer generators
- `vercel.nix` - Vercel deploy tasks
  - Static and build-mode deploys delegate provider behavior to `ci-tools deploy vercel`.
  - Build-mode tasks pass root-directory/build-env config to `ci-tools`; `ci-tools`
    owns `vercel pull`, `vercel build`, prebuilt output validation, deploy,
    aliasing, workflow-report records, and GitHub outputs.
- `workflow-report.nix` - Workflow-report tasks
  - Provides `workflow-report:collect-bundle`,
    `workflow-report:render-comment-body`, and `workflow-report:publish`.
  - CI should pass event context and paths through environment variables while
    these tasks own `ci-tools workflow-report ...` invocation and PR comment
    lookup/publication behavior.
- `bun.nix` - Bun tasks (legacy)
- `context.nix` - Context directory tasks
- `lint-genie.nix` - Genie lint tasks
- `worktree-guard.nix` - Git hook: prevent commits on default branch (optionally enforce linked worktrees)

## `local/` - Effect-Utils Specific

These tasks are **local to the effect-utils repo** and NOT meant for reuse.
They assume the effect-utils repo structure and are not exported in flake.nix.

### Characteristics:

- **Hardcoded paths** (e.g., `packages/@overeng/*`, `devenv.nix` location)
- **No parameters** - simple inline definitions
- **Not exported** in flake.nix
- **Repo-specific logic** that wouldn't make sense elsewhere

### Available Modules:

- `asset-import-type-reference.nix` - effect-utils package export policy check for asset side-effect imports
- `devenv-module-tests.nix` - CI task that runs shell tests for reusable task modules
- `workspace-check.nix` - Validates `allPackages` in devenv.nix matches filesystem

## `lib/` - Shared Utilities

Helper functions used by task modules:

- `cache.nix` - Task caching utilities
- `cli-guard.nix` - Guarded task-owned CLI wrappers
- `trace.nix` - Task tracing wrappers

## Task Output

devenv does not forward a task's **stdout** to the caller — on success or on
failure, and regardless of `--show-output` or `DEVENV_TASK_PASSTHROUGH`. Its
**stderr** is forwarded in every case.

So anything a task emits for the operator, and every GitHub workflow command,
must go to stderr:

```nix
echo "::warning::pnpm store was rebuilt from scratch" >&2
```

On stdout the same line is silently discarded: it never reaches the job log, and
GitHub never turns it into an annotation or a log group. `lint:nix:workflow-commands`
fails the build on any `echo "::…"` here that is missing `>&2`.

Stdout is not a reliable channel in either direction: a direct `devenv tasks run`
of a failing task discarded its stdout too, while a failing *dependency* task's
stdout does appear in devenv's error summary in CI. Rather than depend on which
case applies, put anything you need to read on stderr.

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
