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
  Its live shell fixture also runs through `devenv-modules:test`; the repository's
  aggregate runner supplies pinned fingerprint, copy, move, and JSON tools rather
  than relying on a developer's ambient tool-input environment. The fixture uses
  ordinary glob expansion compatible with the runner's `bashNonInteractive`,
  which omits shell-completion builtins.
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
  - `(taskModules.megarepo { setupCommitMembers = [ "livestore" ]; })` makes
    `mr:setup` prepare those members' nested megarepo trees in fresh commit
    worktrees (readiness via `mr status --all`); unlisted members stay on
    tracking worktrees. Default `[ ]` keeps the plain tracking setup.
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
    `test:<name>` execution. `test:run` uses weighted execution chains with the
    shared installer: a chain advances independently when its preceding task
    finishes, without a whole-batch barrier. Direct tasks never pull other
    packages into their closure. Package-specific `after` prerequisites apply
    to both paths; the aggregate waits for every chain tail and extra test.
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
- **Repository-owned parameters** - local policy stays in this checkout
- **Not exported** in flake.nix
- **Repo-specific logic** that wouldn't make sense elsewhere

### Available Modules:

- `devenv-module-tests.nix` - CI task that runs shell tests for reusable task modules

### Module shell-test scheduling

`devenv-modules:test` discovers every `shared/tests/*.test.sh`; it does not
filter the suite. `local/devenv-module-tests.sh` runs unaudited and shared-checkout
state scripts serially before starting a bounded worker pool for explicitly
admitted scripts. Only admitted scripts are ordered longest-first, with lexical
ties and weight one for scripts without a declared duration. Both phases keep
running after failures. The aggregate fails if any script fails, and stderr
records each script's UTC start/end timestamp, scheduling class, and original
exit status. Stdout and stderr are not discarded. The Nix task pins Bash,
GNU date, jq, and xargs; the runner uses the GNU/BSD common
`xargs -0 -n 1 -P <workers>` interface rather than Bash-version-specific `wait -n`.
Worker failures, including exit 255, are normalized only at the xargs boundary
so xargs cannot stop dispatching the remaining scripts. The supervisor waits
for the complete pool on ordinary failures and on INT/TERM to the supervisor.

#### Isolation admission audit

The admission list is fail-closed: a new script still runs, but runs serially
until its side effects have been reviewed. The audit at
[`1f4b2947`](https://github.com/overengineeringstudio/effect-utils/commit/1f4b2947b8cfe2617e34ade8e5fafb63fd2c5587)
admitted 42 of the original 43 scripts. Every admitted script runs in a
separate Bash process, preserving cwd/environment isolation. Their ownership
boundaries are:

- **Read-only checkout policy/inventory:** `buck2-no-python-actions`,
  `buck2-stage0-source-inputs`, `devenv-eval-source-roots`,
  `devenv-task-env-boundary`, `nix-cli-no-hash-refresh`, and
  `observability-capture`. Negative controls, when present, write only mktemp
  fixtures; none starts a checkout-owned Buck daemon.
- **Nix evaluation/copied sources:** `buck2-capability-source`,
  `buck2-rules-source`, `check-module-options`, `setup-module-options`, and
  `workflow-report-module-source`. Source mutations affect copies under
  mktemp, not the checkout. Store realization uses `--no-link`; concurrent Nix
  store access remains Nix-daemon-owned, with no store GC or checkout result link.
- **Private state/fixtures:** `buck2-rust-deps`, `changeset-check-bodies`,
  `devenv-eval-input-budget`, `megarepo-lock-sync`, `megarepo-status`,
  `pnpm-source-input-staging`, and `setup-cache`. Generated graphs, fake Cargo
  homes, SQLite databases, manifests, caches, and source staging all live below
  each script's mktemp root.
- **pnpm behavior:** `pnpm-gvs`, `pnpm-nested-roots-and-source-inputs`,
  `pnpm-shared-store-reuse`, `pnpm-source-input-refresh.integration`,
  `pnpm-task-smoke`, `pnpm`, and `test-task-smoke`. Stores and projections are
  fixture-local, including the deliberately shared/concurrent pnpm store:
  "shared" means shared between that script's fixtures, not between scripts.
  Smoke installs use private homes and fake providers; no repository install
  or repository node_modules mutation is scheduled.
- **Genie:** `genie-compiled-staging` and `genie-module-options`. Compiled output,
  generated JSON, task receipts, and scratch Git repositories are private.
  The compiled fixture reads repository node_modules through a symlink but
  writes its compilation/import staging into mktemp.
- **Lint/plugin fixtures:** `lint-no-tailwind`, `lint-oxc-file-list`,
  `oxlint-plugin-injection`, and `oxlint-rule-policy`. Repository policies and
  immutable plugin products are read; malformed inputs, generated task code,
  argument captures, and plugin overrides are private fixture files.
- **Trace adapters:** `otel-instr-gating`, `otel-run`, and
  `otel-scrape-oxfmt-wrap`. Adapters/providers are fixture stubs; capture files,
  homes, spools, and summaries are private, not the live observability backend.
- **Lock checking:** `flake-lock-duplicates` builds a no-output-link task wrapper
  and checks lockfiles inside its private workspace.
- **Pipeline/report/provider fixtures:** `pipeline-run`,
  `workflow-report-task-e2e`, and `deploy-task-e2e`. Git state, OTLP spools,
  GitHub outputs, summaries, and provider logs are private. The deploy fixture
  binds its local API to port 0 and stops its owned API process; it does not
  claim a fixed port or call a live deploy provider.
- **SecretSpec:** `secretspec-native-tasks` realizes a no-output-link stub
  package environment and uses a private home/repository/capture per fixture;
  it does not call a real provider or fetch secrets.

The three native lifecycle fixtures are also admitted. Starting daemons is not
itself shared-state access; ownership of their mutations is what matters:

- `buck2-capability-daemon.test.sh` owns a private HOME, temporary Buck roots,
  explicit isolation names, and a short private Watchman socket. Every Buck
  startup, migration stop, and cleanup names that private HOME/root/isolation.
  Every Watchman operation names its private socket; startup, state, config,
  log, PID file, and native shutdown are fixture-owned.
- `buck2-capability-publish.test.sh` owns its publication roots, lock files,
  synthetic Buck state, and HOME. The five competing publishers and crash
  victim all use those roots; signals/cleanup address only captured fixture
  PIDs. Failure diagnostics read native process metadata without mutating
  other processes. Retention writes/prunes only `capability-publisher.*`
  evidence directories, not any other suite script's fixtures or evidence.
  Nix GC-root queries/registrations name that fixture's own absolute root links.
- `worktree-teardown.test.sh` has a unique canonical mktemp parent for all Git
  worktrees, editor publications, and nested-checkout/collision probes. Although
  Buck state is under the caller's `$HOME/.buck/buckd`, its keys include those
  unique absolute checkout paths. The production teardown kills only the
  selected root's direct isolations and deletes only their shallow files/root
  leaf, never a shared ancestor directory. Cache entries use fixture-specific
  root hashes below its private `XDG_CACHE_HOME`. Watchman startup/shutdown uses
  the fixture's private socket; production release performs only `watch-del`
  for the selected fixture root, even if its no-spawn client reaches an ambient
  service in the fixture's no-Watchman branch. No whole-service/global watch
  deletion is issued.

The remaining original serial script is `devenv-task-graph.test.sh`: it invokes
`devenv tasks list --json` at the real checkout, using that checkout's Devenv
evaluation/cache state. All unaudited additions also remain serial.

`devenv-module-tests-runner.test.sh` is also serial. Its FIFO-gated fixtures
exercise the actual runner, including explicit daemon/publisher/teardown
admission and the graph-check serial barrier: four-worker bounds, the
three-worker fallback, longest-first dispatch, continued
dispatch after either worker or the serial phase fails, exit-255 coverage,
per-script verdicts, cwd/environment isolation, complete child cleanup/reaping,
unknown filenames with spaces, empty/missing suites, and draining after
supervisor TERM.

#### Declared scheduling policy and evidence

[`genie/ci-workflow/test-scheduling.json`](../../../genie/ci-workflow/test-scheduling.json)
is the checked-in scheduling authority. Its `workers` setting defaults to four
for both source-task chains and module-test workers. Change this one setting
to three for the lower-concurrency fallback; no runtime timing download or
environment-dependent worker override changes the CI policy.

The table's positive integer weights round up observed Darwin seconds from
[run 37886131764](https://github.com/overengineeringstudio/effect-utils/actions/runs/37886131764).
Missing weights use one, so newly selected tasks still execute. Source tasks
are assigned longest-first to the least-loaded chain; ties are deterministic.
Editor publication starts the longest declared views first in its existing
four-worker publisher, without changing authority, snapshot validation, or
commit serialization.

| Observed Darwin phase/script | Seconds |
| ---------------------------- | ------: |
| Module task, two workers     | 162.926 |
| `worktree-teardown`          |  50.859 |
| `buck2-capability-publish`   |  46.243 |
| `buck2-capability-daemon`    |  36.662 |
| `pnpm-task-smoke`            |  35.419 |
| `pnpm-gvs`                   |  21.660 |
| `pipeline-run`               |  18.069 |
| Source whole-batch chain     | 135.347 |
| Editor test publication      | 164.919 |
| Final Buck collector         |   1.642 |

**[INFERENCE]** Holding these observed durations fixed, four longest-first
module workers give about 77 seconds including the serial prefix, and four
weighted source chains give about 72 seconds. Together they could shorten the
critical test tail by about 86 seconds. This is a scheduling model, not a
measured four-worker speedup: increased CPU, Nix evaluation, filesystem, or
daemon contention can lengthen individual tasks. Changing only one branch
cannot realize their combined modeled saving.

The run's host sampler saw a peak summed process RSS of 15.66 GiB on 28 GiB,
no observed compression/pageouts, and peak summed process lifetime-average
CPU of 1164.9% on 12 CPUs. CPU is not interval utilization, and peaks have no
phase timestamps. The four-worker choice requires an actual merge-group
observation; use the declared three-worker fallback if contention warrants it.

Focused verification (inside the pinned development shell):

```sh
bash nix/devenv-modules/tasks/shared/tests/devenv-module-tests-runner.test.sh
devenv tasks run devenv-modules:test --mode single
```

The aggregate command also retains all real Buck daemon, publisher, and
worktree-teardown scenarios. Compare complete start/end verdict records and
the task duration on both Linux and Darwin; do not infer performance from the
focused scheduler fixture alone.

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
