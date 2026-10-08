# Task Organization

This directory contains devenv task modules organized by reusability.

## `shared/` - Reusable Tasks

These tasks are meant to be imported by other repos via the flake input:

```nix
# In another repo's devenv.nix
imports = [
  (inputs.effect-utils.devenvModules.tasks.check {
    checkQuickTypecheckTask = "repo:typecheck";
  })
  (inputs.effect-utils.devenvModules.tasks.lint-oxc {
    lintPaths = [ "src" "test" ];
    geniePatterns = [ "*.genie.ts" ];
    genieCoverageDirs = [ "." ];
  })
  (inputs.effect-utils.devenvModules.tasks.flake-lock-duplicates {
    lockfiles = [ "flake.lock" ];
  })
];

tasks."repo:typecheck".exec = "pnpm exec tsc --noEmit";
```

`checkQuickTypecheckTask` must name a task defined by the consuming repository;
`checkAllTypecheckTask` defaults to the same task. The module retains
`ts:check` as its compatibility default, while Buck-owned repositories should
select their own aggregate explicitly (for example, `buck2:quick` and
`buck2:all`).

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
do not depend on ambient `PATH`; capture tasks also prefer otelite's
invocation-scoped HTTP endpoint over a repository's ambient collector endpoint.
The module intentionally avoids the full local observability stack. Override
`profile` to capture a different task graph, or set `profile = null` when only
the packages and project attribution are needed. Use `profile.prerequisiteTasks`
for outer tasks that must complete before the nested devenv process can evaluate.

### Characteristics:

- **Configurable** via function parameters
- **No repo-specific assumptions** (paths, package names, etc.)
- **Exported** in `flake.nix` under `devenvModules.tasks`
- **Documented** with clear usage examples

### Available Modules:

- `check.nix` - Aggregate check tasks (check:quick, check:all, configurable strict typecheck gate)
- `devenv-eval-input-budget.nix` - Per-attribute recursive eval-cache input budget,
  wired into `check:quick` and `check:all` by default
- `clean.nix` - Clean tasks
- `worktree-teardown.nix` - Explicit offline `worktree:teardown` before worktree
  removal; inherited by setup, check, clean, and worktree-guard imports. Stops
  every root-owned Buck isolation, releases reachable Watchman and root-keyed
  admission state, calls `buck2:editor:release` when defined, and makes real
  directories owner-writable. Never auto-scheduled; indirect Nix gcroots are
  left to become dangling and be pruned by Nix GC.
- `genie.nix` - Genie config generation tasks
- `lint-oxc.nix` - Linting tasks (oxlint, oxfmt)
  - `lintPaths` are Git pathspecs. The lint tasks enumerate tracked and untracked
    non-ignored files through `git ls-files` before calling oxlint/oxfmt, and do
    not use devenv's `execIfModified` glob walker.
  - `lint:check:no-tailwind` runs within `lint:check` (and `check:quick`) by
    default. It scans tracked and non-ignored untracked package manifests,
    JS/TS imports, Tailwind config filenames, and CSS/Astro/Svelte/Vue style
    directives. Each violation includes a file, line, and StyleX remedy.
  - Approved exceptions live in a consumer-owned `.no-tailwind-exceptions.json`
    containing an array of `{ "path": "examples/**", "reason": "Standalone example apps" }`.
    The file is optional, so existing consumers can declare exceptions before
    repinning effect-utils; the older lint module does not need to parse them.
    Paths are anchored; `packages/@local/**/example/**` covers nested example
    apps, while `"**"` explicitly exempts an entire repository. A reason is
    required; other library paths remain guarded.
- `megarepo.nix` - Megarepo workspace tasks
- `flake-lock-duplicates.nix` - Exact duplicate flake lock-node policy
  - `(taskModules.flake-lock-duplicates { lockfiles = [ "flake.lock" ... ]; })`
    selects the lockfiles and only defines `nix:flake-lock:check-duplicates`.
    Each consumer explicitly attaches that task to its authoritative aggregate
    gate.
  - Lockfile paths are resolved relative to the task working directory.
  - Each lockfile is checked independently. Complete `.locked` identities are
    never compared across files. The task reports every within-file duplicate
    group in deterministic order and fails for missing or invalid lockfiles;
    similar but non-identical identities are allowed.
- `nix-cli.nix` - Nix CLI build/check tasks
- `pnpm.nix` - pnpm install tasks
  - Local development shares one complete pnpm Store Cache between trusted
    roots of the same OS user; CI uses a job-local Store Cache.
  - By default dependency graphs and `node_modules/.pnpm` remain
    Materialization-Root-owned. Pass `globalVirtualStore = true;` to opt local
    development into pnpm's graph-hashed shared projections with the isolated
    linker. Genie authors `enableGlobalVirtualStore: true` in workspace YAML.
    Hoisted linking does not use GVS.
  - GVS uses `PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=true`, not the ineffective
    pnpm 12 kebab-case `--config` spelling, and leaves `virtual-store-dir` unset.
    The default complete store is `$HOME/.local/share/pnpm/store` in GVS mode
    versus `$HOME/.local/share/pnpm/store-shared-v1` otherwise;
    `PNPM_SHARED_STORE_DIR` overrides either local store.
  - CI explicitly disables GVS (including inherited environment/YAML opt-ins)
    and uses the job-local store and projection. Fixed-output preparation stays
    root-local and GVS-disabled.
  - Install, update, dedupe, status, doctor, and shell setup share the selected
    policy. Readiness receipts include effective GVS/store policy. Health and
    projection fingerprints visit only this root's reachable shared instances,
    not unrelated graphs. Repair removes only root-owned links, never shared
    graph instances. Stores are writable state for trusted same-user consumers;
    verify tools that depend on package realpaths or implicit dependencies
    before opting in.
  - Managed installs use pnpm's `auto` import policy and reject cross-device
    Linux storage before materialization.
  - `pnpm:store:migrate-legacy` explicitly replaces only the recognized
    historical `v11/files` bridge under the exclusive cache lease; normal
    installs and unknown bridges fail closed.
  - Frozen installs and `pnpm:update` both use the current guarded pnpm
    runtime: pnpm 12 is outside the 11.5.2-11.14.0 `hasBin` window that
    required a separate lock mutator, so the dedicated pin is retired while
    `pnpmLockMutatorPkg` remains available for a future divergence. Root
    updates generate projections with validation deferred, repair the lock,
    then require `genie --check`; retained package records are rejected
    transactionally if they lose `hasBin` metadata.
- `setup.nix` - Setup tasks
  - `skipNonInteractive = true` keeps automatic shell entry cheap for
    non-interactive callers; `DEVENV_FORCE_SETUP=1` explicitly overrides it.
- `test.nix` - Test tasks
  - A package's `installTask` overrides the shared installer for direct
    `test:<name>` execution. `test:run` batches use execution aliases with the
    shared installer and ordered barriers; direct tasks never run earlier
    batches. Package-specific `after` prerequisites apply to both paths.
- `test-playwright.nix` - Playwright e2e tasks
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

- `devenv-module-tests.nix` - CI task that runs shell tests for reusable task modules

## `lib/` - Shared Utilities

Helper functions used by task modules:

- `cache.nix` - Task caching utilities
- `cli-guard.nix` - Guarded task-owned CLI wrappers
- `trace.nix` - Task tracing wrappers

## Task Output

devenv renders a task's **stderr** by default. Its **stdout** is rendered only
when the run opts in — `showOutput = true` on the task, `--show-output`, or
`--verbose`.

That is about what devenv prints to a console, not about what escapes the
process. **Both streams reach a GitHub runner.** Measured on `ubuntu-latest`
with devenv 2.1.2: a `::warning::` emitted from a task became an annotation from
stdout with no opt-in, from stdout with `showOutput = true`, and from stderr —
all three indistinguishable from one emitted by the step itself. So workflow
commands work from either stream, and log grouping does too.

One caveat worth knowing when debugging locally: devenv selects quiet verbosity
when it detects `CLAUDECODE` / `OPENCODE_CLIENT` / `AI_AGENT`, and up to 2.2.x
that also suppressed `showOutput`
([cachix/devenv#3038](https://github.com/cachix/devenv/issues/3038)), so a
task's stdout could look missing inside a coding agent while being perfectly
visible in CI. Fixed upstream in 2.3: explicit `showOutput = true` /
`--show-output` now streams even at quiet verbosity. On older CLIs, use
`DEVENV_NO_AI_AGENT=1` or `--verbose` when measuring.

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
