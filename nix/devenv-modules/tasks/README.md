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

pnpm source-input staging resolves `repos/<member>/...` with genie's
bootstrap-safe member resolver. The initiating workspace's `megarepo.lock`
selects the member source, not the potentially newer tracking symlink.
Explicit `GENIE_MEMBER_OVERRIDE_MAP` overrides have the same precedence as
genie imports. Materialize pinned sources with
`mr apply --worktree-mode commit --lock-sync off` before staging.

`mr:lock-sync-check` matches named Nix lock inputs to their exact same-repository
megarepo members. An unnamed input is accepted when its revision matches any
member of that repository, including several members at the same revision.
If none match, it reports `no-declared-revision`.

The check module also exports `config.effectUtils.buck2.aggregateExec`, taking
a task name and a list of Buck2 arguments (including the subcommand). Existing
consumers of `tasks/shared/check.nix` need no additional import:

```nix
env.BUCK2_BIN = "${inputs.effect-utils.packages.${pkgs.stdenv.hostPlatform.system}.buck2}/bin/buck2";
env.OTEL_SPAN_BIN = "${inputs.effect-utils.packages.${pkgs.stdenv.hostPlatform.system}.otel-span}/bin/otel-span";
tasks."bird:build".exec = config.effectUtils.buck2.aggregateExec "bird:build" [
  "build"
  "//flakes/bird:dist-package"
  "//flakes/bird:bird-candidate"
];
```

The helper preserves task tracing, the caller-root command span, event logs/build
IDs, pipeline spooling versus standalone ingest/export, and the Buck2 exit status.
`effectUtils.buck2.eventsPackage` defaults to the consumer's effect-utils input;
`effectUtils.buck2.prepare` optionally supplies repository-specific setup before
the command (for example, effect-utils' capability publication).

## Observability

Aggregate tasks replace (never prepend to) `PATH` with nixpkgs Watchman's bin
directory by default. To use a signed host Watchman on macOS, explicitly declare
the executable in the ignored `devenv.local.nix`:

```nix
{
  effectUtils.buck2.watchmanBin = "/usr/local/bin/watchman";
}
```

The override must be absolute. A task-local `watchman` launcher executes that
exact binary without copying or modifying it. Buck2's Watchman client discovers
the CLI as `watchman` through `PATH`; it does not support a
`BUCK2_WATCHMAN_BIN`/`WATCHMAN_BINARY` selector. There is no ambient PATH probing.
Restart an existing Buck2 daemon (`buck2 kill`) after changing the selection;
an already-running Watchman server retains its original executable/permissions.

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
  The repository's pre-commit entry launches the entire task graph through
  `scripts/without-git-local-env.sh`. It removes the variables reported by
  `git rev-parse --local-env-vars` before starting devenv, so fixture Git
  commands resolve their own repositories instead of the caller's staged index.
  This affects only the child task process, not the committing Git process.
  `git-hooks:environment:test` checks this boundary using disposable repositories
  and a staged sentinel index; it is part of `check:quick`.
- `devenv-eval-input-budget.nix` - Per-attribute recursive eval-cache input budget,
  wired into `check:quick` and `check:all` by default
- `clean.nix` - Clean tasks
- `worktree-teardown.nix` - Explicit offline `worktree:teardown` before worktree
  removal; inherited by setup, check, clean, and worktree-guard imports. Stops
  every root-owned Buck isolation, releases reachable Watchman and root-keyed
  admission state, calls `buck2:editor:release` when defined, and makes real
  directories owner-writable using NUL-delimited find scans and a sorted streaming
  ownership-prefix filter before batched chmod. It never follows symlinks or
  chmods nested Git/megarepo ownership boundaries. Both scans prune unreadable
  directories; owned unreadable roots still receive owner-write permission.
  Never auto-scheduled; indirect Nix gcroots are left to become dangling and be
  pruned by Nix GC.
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
  - `effectUtils.megarepo.setup.mode` is a typed `"tracking" | "locked"` option,
    defaulting to `"tracking"` to preserve local development. Set it to
    `"locked"` in consumer configuration for reproducible setup, or opt in per
    invocation with `MR_SETUP_MODE=locked devenv tasks run check:quick` (likewise
    `check:all`). The process-level override reaches setup dependencies;
    setting environment only on the aggregate check task does not. `CI=true`
    always selects locked commits, even if the override requests tracking.
    Locked setup materializes `megarepo.lock` commits without fetching refs or
    rewriting locks. Canonical non-CI runners must explicitly select locked mode;
    invoking a task named `check:*` alone does not change the setup policy.
    Status validates the effective mode before checking readiness. Successful
    setup records its mode under `.devenv/task-cache/mr-apply/setup-mode`;
    switching between tracking and locked invalidates readiness, including
    outer setup cache hits, so apply materializes the requested worktree policy.
    Every shared apply path (`mr:setup`, `mr:bootstrap`, `mr:apply`, and
    `mr:fetch-apply`) removes that proof before mutating member mounts, so an
    explicit remount or failed apply cannot leave stale setup readiness.
  - `(taskModules.megarepo { setupCommitMembers = [ "livestore" ]; })` additionally
    prepares those members' nested megarepo trees in fresh commit worktrees.
    Local readiness checks every non-skipped root member with `mr status`
    (without `--all`), then runs `mr status --all` inside only the listed,
    non-skipped members that have their own megarepo config. Unlisted nested
    trees do not block readiness; ordinary listed repos need no nested check.
    These exact-lock checks also run on the outer setup cache-hit path.
    Default `[ ]` prepares and checks root members only.
    With `CI=true`, a non-empty list passes `mr apply --commit-all-members`,
    preparing every root member's nested tree to match the root-level
    `mr status --all` readiness check.
  - Setup probes `mr apply --help` before using `--verify-shared`, keeping
    older published products usable without passing an unsupported flag.
    Failed probes stop setup; legacy canonical-mutation refusal remains
    fail-closed. The probe never changes the selected setup mode.
  - Shared `genie:prepare` waits for `mr:setup` when that task exists, so Genie
    run/check/watch and `lint:check:genie` in both lint modules await member
    sources before their status or execution scripts. Concrete Buck task
    dependencies remain consumer-owned; shared `buck2.nix` exposes execution
    helpers rather than defining a generic typecheck task.
  - `megarepo-product-flags.test.sh` evaluates these task scripts with optional
    member preparation enabled and checks every emitted command/flag against
    the manifest-backed Nix `megarepo` product's help. The `pr/quality` gate runs
    this contract on pull requests and rejects task/source changes that outrun
    the published CLI; source CLI tests alone cannot prove the consumer contract.
    Extraction must find flags and include CI nested setup's
    `mr apply --commit-all-members`, so empty/partial extraction fails closed.
    Product refreshes come from the protected-main `publish-products` job in
    `ci.yml` (push or `workflow_dispatch`), which proposes
    `automation/buck2-products-manifest`. Land its manifest PR before consumers
    repin task modules requiring new flags; never hand-edit product provenance.
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
    roots of the same OS user. `GITHUB_ACTIONS=true` or the explicit opt-in
    `PNPM_JOB_LOCAL_STORE=1` selects the job-local Store Cache under
    `<root>/.devenv/pnpm-store-pure-v1` (with a workspace suffix for nested roots).
    `CI=1` alone keeps shared storage, so non-watch dev-host tasks reuse the cache.
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
  - Job-local mode explicitly disables GVS (including inherited environment/YAML
    opt-ins) and uses the job-local store and projection. Other CI runners must
    set `PNPM_JOB_LOCAL_STORE=1` to obtain that isolation. Fixed-output preparation
    stays root-local and GVS-disabled.
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
  - `pnpm-store-gc --git-dir /path/to/repo/.bare --root /path/to/worktree`
    reports historical root-local store retirement in a read-only dry-run.
    The collector supports Linux x86/x86_64 and ARM/aarch64, selecting each
    architecture's directory and no-follow open flags. Other Linux architectures
    fail at compile time rather than assuming compatible flags.
    On other platforms it exits nonzero before
    filesystem input access with `pnpm-store-gc: unsupported platform (Linux only; Darwin census not implemented)`.
    Repeat `--root` for explicitly selected worktrees; there is no fleet traversal.
    It never targets `$HOME/.local/share/pnpm` or `PNPM_SHARED_STORE_DIR`.
    Before ownership admission or lease creation, resolved paths and inode
    identities reject candidates overlapping either default shared store or
    `PNPM_SHARED_STORE_DIR`. Mount inventory also rejects mount points at the
    candidate root or below it, including same-filesystem bind mounts.
    Directory mount IDs define traversal containment; `st_dev` remains part of
    inode accounting only. Overlayfs payloads can expose differing backing
    device IDs without crossing a mount, so device-number inequality is not
    grounds to reject an otherwise contained historical cache.
    `--observe` records eligible roots without deleting payloads; after 24 hours,
    repeat the dry-run, then opt in to `--apply` to retire eligible payloads.
    An initial `--apply` only establishes the observation, never skips grace.
  - Eligibility requires the root to be absent from Git's worktree registry
    **and** have no `.git` marker, or its own checkout to have stopped owning
    the historical store. For effect-utils this is proved by HEAD containing
    `727cb7544bea32ec031c9f6e5e840cbe717e772a` (#1794). Consumer checkouts can
    prove resolved selection through matching `pnpm-storage-state` receipts
    and `.modules.yaml` metadata naming the default shared store (or the
    operator's `PNPM_SHARED_STORE_DIR`). Any projection still naming a
    worktree-local store protects the cache. Unknown metadata, incomplete
    ownership evidence, and Git worktree locks fail closed; PR closure alone
    does not prove a checkout stopped referencing its store.
  - The collector requires no own-UID cwd/open-fd references under the
    historical **store**, not the entire checkout, using Linux `/proc`.
    Other-UID processes are outside the normal
    user-owned-cache flow; the CLI states this assumption explicitly. Unreadable
    own-UID processes fail closed, except the explicit Linux privileged-broker
    allowlist. SSH brokers (`sshd-session`, Tailscale SSH's
    `.tailscaled-wrapped` executable or truncated `.tailscaled-wra` comm)
    require a root-owned fd directory. The `systemd` user-manager exception
    requires `PPid=1` and nonzero permitted capabilities. Its `(sd-pam)` child
    shares the same exception only when its PPid identifies that same approved,
    same-UID manager. Only `ESRCH` or disappearance of the PID directory proves
    a process gone. A live PID with missing leader cwd/fd evidence requires
    inventory of its remaining tasks; unreadable task evidence fails closed.
    Other unreadable process classes fail closed. Every exception prints the PID,
    comm, executable
    (or its read error), parent, permitted capabilities, and the normal-flow
    assumption that privileged brokers do not use pnpm stores. The invoking UID
    must own the store; no privileged observer or GitHub/API access is needed.
    It rechecks checkout ownership, process references, and every payload inode's
    size/link-count/mtime/ctime under a proved exclusive Store Cache lease before
    retirement. Changed observed eligibility resets the 24-hour grace.
    The candidate is opened once at admission: its directory descriptor and
    inode/mount identity remain held through lease acquisition, proofs, and
    retirement. The lease is opened relative to that descriptor, and its locked
    open-file description remains held in the same collector process. Pathname
    replacement aborts rather than admitting a replacement directory; deletion
    never reopens the root path and verifies its identity again at the end.
    Linux retirement walks held directory descriptors with `O_NOFOLLOW` and
    compares each opened directory's mount ID before descending or unlinking;
    a newly inserted mount or replacement symlink cannot redirect the walk.
    Observations live in `$XDG_STATE_HOME/effect-utils/pnpm-store-gc` (default
    `$HOME/.local/state/...`); the stable store directory and maintenance-lock
    inode remain, so cooperating pnpm mutations cannot bypass the lease.
  - Output lists `would-free`, `grace`, `protected`, or `absent` per root and a
    `would-free-total` in bytes. Reclaim estimates count allocated blocks once
    per inode and exclude payload inodes still hardlinked outside the selected
    store; `allocated=` also reports the gross store footprint. These are not
    physical reclaim guarantees on compressed, snapshotted, or clone-sharing
    filesystems. Unmanaged processes can start after a census: stop/unpin root
    users first; process evidence does not replace lifecycle ownership.
  - Historical attribution: `8c5bc8e6be49440f03b9b0bb9504264352d47bd8`
    (#692) introduced the `pure-v1` namespace for lifecycle-free, integrity-
    checked frozen installs, not because Buck/Nix required worktree-local CAS.
    `4514099e0` (#922) selected a complete shared Store Cache with root-owned
    topology. `727cb7544bea32ec031c9f6e5e840cbe717e772a` (#1794) stopped
    treating ambient `CI=1` as job isolation; ordinary dev-host tasks now share
    the cache even in non-watch CI mode. Copies created before that selection
    change can be historical, but age alone does not authorize their retirement.
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

`devenv-modules:test` discovers every `shared/tests/*.test.sh` and requires each
script to appear exactly once in `genie/ci-workflow/test-platforms.json`'s
`moduleScripts` classification. The Nix import and shell dispatcher both reject
missing, stale, duplicate or overlapping entries before dispatch. Darwin runs
only Darwin-sensitive scripts; Linux and an unset platform run the complete
catalog, except entries marked `fullProfileOnly: true` are excluded when
`EFFECT_UTILS_CI_TEST=1`. In particular, `notion-integration-ci.test.sh` needs
the full profile's Notion task definitions: full-profile `check:quick` and
`check:all` run it through `test:notion-integration:ci-skip`, independently of
the platform-selected module-test aggregate.
The unit graph guard checks direct `devenv tasks run` lines in unit-selected
scripts, including literal shell-array task arguments, against evaluated task
names before executing tests. This cheap scan is not a general shell parser;
embedded fixture/stub strings and dynamically computed task names are outside
its scope. Platform/profile classification is independent of parallel-safety
admission.
`local/devenv-module-tests.sh` runs selected unaudited and shared-checkout state
scripts serially before starting a bounded worker pool for explicitly admitted
scripts. Only admitted scripts are ordered longest-first, with lexical
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

The parallel admission list is fail-closed: a newly platform-classified script
runs serially until its side effects have been reviewed. The audit at
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
