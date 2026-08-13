{
  pkgs,
  inputs,
  config,
  lib,
  ...
}:
let
  repoFlake = builtins.getFlake (toString ./.);
  currentSystem = pkgs.stdenv.hostPlatform.system;
  flakePkgs = import repoFlake.inputs.nixpkgs { system = currentSystem; };
  # `restate` ships under BSL-1.1; scope allowUnfree to just that package so the
  # rest of the closure stays free-only.
  restatePkgs = import repoFlake.inputs.nixpkgs {
    system = currentSystem;
    config.allowUnfreePredicate = pkg: builtins.elem (pkgs.lib.getName pkg) [ "restate" ];
  };
  restate = import ./nix/restate.nix { pkgs = restatePkgs; };
  cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
  # Use npm oxlint with NAPI bindings to enable JavaScript plugin support
  oxlintNpm = import ./nix/oxlint-npm.nix {
    pkgs = flakePkgs;
    bun = flakePkgs.bun;
    src = repoFlake;
  };
  oxlintWithPlugins = import ./nix/oxlint-with-plugins.nix {
    inherit pkgs oxlintNpm;
  };
  nodePtyNative = import ./nix/node-pty-native.nix { inherit pkgs; };
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./nix/devenv-modules/tasks/shared/pnpm-task-helpers.sh
  );
  rustCrates = [
    {
      name = "otelite";
      path = "packages/@overeng/otelite";
    }
    {
      name = "otel-scrape";
      path = "packages/@overeng/otel-scrape";
    }
  ];
  grep = "${pkgs.gnugrep}/bin/grep";
  head = "${pkgs.coreutils}/bin/head";
  rg = "${pkgs.ripgrep}/bin/rg";
  tail = "${pkgs.coreutils}/bin/tail";
  trace = import ./nix/devenv-modules/tasks/lib/trace.nix { inherit lib; };

  # Shared task modules (from shared/ directory)
  taskModules = {
    genie = ./nix/devenv-modules/tasks/shared/genie.nix;
    ts = import ./nix/devenv-modules/tasks/shared/ts.nix;
    worktree-guard = import ./nix/devenv-modules/tasks/shared/worktree-guard.nix;
    setup = import ./nix/devenv-modules/tasks/shared/setup.nix;
    check = import ./nix/devenv-modules/tasks/shared/check.nix;
    clean = import ./nix/devenv-modules/tasks/shared/clean.nix;
    test = import ./nix/devenv-modules/tasks/shared/test.nix;
    test-playwright = import ./nix/devenv-modules/tasks/shared/test-playwright.nix;
    storybook = import ./nix/devenv-modules/tasks/shared/storybook.nix;
    netlify = import ./nix/devenv-modules/tasks/shared/netlify.nix;
    workflow-report = import ./nix/devenv-modules/tasks/shared/workflow-report.nix;
    lint-genie = ./nix/devenv-modules/tasks/shared/lint-genie.nix;
    lint-nix = import ./nix/devenv-modules/tasks/shared/lint-nix.nix;
    lint-oxc = import ./nix/devenv-modules/tasks/shared/lint-oxc.nix;
    bun = import ./nix/devenv-modules/tasks/shared/bun.nix;
    pnpm = import ./nix/devenv-modules/tasks/shared/pnpm.nix;
    megarepo = import ./nix/devenv-modules/tasks/shared/megarepo.nix;
    nix-cli = import ./nix/devenv-modules/tasks/shared/nix-cli.nix;
    secretspec = import ./nix/devenv-modules/tasks/shared/secretspec.nix;
    bootstrap-closure = import ./nix/devenv-modules/tasks/shared/bootstrap-closure.nix;
    weaver = import ./nix/devenv-modules/tasks/shared/weaver.nix;
    weaver-diff = import ./nix/devenv-modules/tasks/shared/weaver-diff.nix;
    weaver-live-check = import ./nix/devenv-modules/tasks/shared/weaver-live-check.nix;
    weaver-version-smoke = import ./nix/devenv-modules/tasks/shared/weaver-version-smoke.nix;
    context = ./nix/devenv-modules/tasks/shared/context.nix;
    devenv-module-tests = ./nix/devenv-modules/tasks/local/devenv-module-tests.nix;
    asset-import-type-reference = ./nix/devenv-modules/tasks/local/asset-import-type-reference.nix;
  };
  # Use bun source entrypoints for in-repo CLIs in devenv (flake builds stay strict).
  mkSourceCli = import ./nix/devenv-modules/lib/mk-source-cli.nix { inherit pkgs; };

  # Real packages backing guarded command names. The cli-guards own bin/<name>
  # and exec these via absolute store path under passthrough, so they are passed
  # as `*Pkg` reals to the task modules instead of also being top-level profile
  # providers (which would collide with the guards in buildEnv). See cli-guard.nix.
  effectTsgo = inputs.tsgo.packages.${currentSystem}.effect-tsgo;
  pnpmPkg = import ./nix/pnpm.nix { inherit pkgs; };
  genieSourceCli = mkSourceCli {
    name = "genie";
    entry = "packages/@overeng/genie/bin/genie.tsx";
  };
  mrSourceCli = mkSourceCli {
    name = "mr";
    entry = "packages/@overeng/megarepo/bin/mr.ts";
  };
  ciToolsSourceCli = mkSourceCli {
    name = "ci-tools";
    entry = "packages/@overeng/ci-tools/bin/ci-tools.ts";
  };
  buck2Machine = pkgs.buck2;
  buck2SourceCli = mkSourceCli {
    name = "buck2-task";
    entry = "packages/@overeng/buck2-launcher/src/cli.ts";
  };
  buck2Task = "${buck2SourceCli}/bin/buck2-task";
  buck2Stage0Resolver = mkSourceCli {
    name = "buck2-stage0-config";
    entry = "packages/@overeng/buck2-tools/src/stage0-config-cli.ts";
  };
  buck2Stage0Definition = import ./nix/buck2-stage0-tools.nix { inherit pkgs; };
  buck2Stage0SemanticArgs = lib.concatMapStringsSep " " (
    path:
    let
      repositoryPrefix = "${toString ./.}/";
      absolute = toString path;
      relative = lib.removePrefix repositoryPrefix absolute;
    in
    assert lib.assertMsg (
      relative != absolute && relative != ""
    ) "Buck stage-0 semantic inputs must be files below the repository root";
    # Contents are runtime fingerprint inputs, not Nix inputs of the shell.
    # The resolver independently validates repository containment at runtime.
    "--semantic-input ${lib.escapeShellArg (builtins.unsafeDiscardStringContext relative)}"
  ) buck2Stage0Definition.semantic-inputs;
  buck2Stage0SemanticTreeArgs = lib.concatMapStringsSep " " (
    path:
    let
      repositoryPrefix = "${toString ./.}/";
      absolute = toString path;
      relative = lib.removePrefix repositoryPrefix absolute;
    in
    assert lib.assertMsg (
      relative != absolute && relative != ""
    ) "Buck stage-0 semantic input trees must be below the repository root";
    "--semantic-input-tree ${lib.escapeShellArg (builtins.unsafeDiscardStringContext relative)}"
  ) buck2Stage0Definition.semantic-input-trees;
  buck2Stage0Resolve = ''
    cache_root="''${XDG_CACHE_HOME:-''${HOME:?HOME is required}/.cache}/effect-utils/buck2-stage0"
    ${buck2Stage0Resolver}/bin/buck2-stage0-config \
      --repo-root "$root" \
      --cache-root "$cache_root" \
      --nix-bin ${pkgs.nix}/bin/nix \
      --flock-bin ${pkgs.flock}/bin/flock \
      --bun-bin ${pkgs.bun}/bin/bun \
      ${buck2Stage0SemanticArgs} \
      ${buck2Stage0SemanticTreeArgs}
  '';
  # CLI packages built with Nix (for hash management)
  nixCliPackages = [
    {
      name = "genie";
      flakeRef = ".#genie";
      hashSource = "packages/@overeng/genie/nix/build.nix";
      lockfile = "pnpm-lock.yaml";
      packageJson = "packages/@overeng/genie/package.json";
    }
    {
      name = "megarepo";
      flakeRef = ".#megarepo";
      hashSource = "packages/@overeng/megarepo/nix/build.nix";
      lockfile = "pnpm-lock.yaml";
      packageJson = "packages/@overeng/megarepo/package.json";
    }
    {
      name = "tui-stories";
      flakeRef = ".#tui-stories";
      hashSource = "packages/@overeng/tui-stories/nix/build.nix";
      lockfile = "pnpm-lock.yaml";
      packageJson = "packages/@overeng/tui-stories/package.json";
    }
    {
      name = "oxlint-npm";
      flakeRef = ".#oxlint-npm";
      hashSource = "nix/oxc-config-plugin.nix";
      lockfile = "pnpm-lock.yaml";
      packageJson = "packages/@overeng/oxc-config/package.json";
    }
    {
      name = "notion-cli";
      flakeRef = ".#notion-cli";
      hashSource = "packages/@overeng/notion-cli/nix/build.nix";
      lockfile = "pnpm-lock.yaml";
      packageJson = "packages/@overeng/notion-cli/package.json";
    }
    {
      name = "notion-md";
      flakeRef = ".#notion-md";
      hashSource = "packages/@overeng/notion-md/nix/build.nix";
      lockfile = "pnpm-lock.yaml";
      packageJson = "packages/@overeng/notion-md/package.json";
    }
  ];

  # Explicit workspace members for the repo-root pnpm workspace.
  # NOTE: Using pnpm temporarily due to bun bugs. Plan to switch back once fixed.
  # See: context/workarounds/bun-issues.md
  allPackages = [
    "packages/@overeng/agent-session-ingest"
    "packages/@overeng/buck2-launcher"
    "packages/@overeng/buck2-tools"
    "packages/@overeng/content-address"
    "packages/@overeng/utils"
    "packages/@overeng/utils-dev"
    "packages/@overeng/effect-ai-claude-cli"
    "packages/@overeng/effect-distributed-lock"
    "packages/@overeng/effect-path"
    "packages/@overeng/effect-react"
    "packages/@overeng/effect-rpc-tanstack"
    "packages/@overeng/effect-rpc-tanstack/examples/basic"
    "packages/@overeng/effect-schema-form"
    "packages/@overeng/effect-schema-form-aria"
    "packages/@overeng/genie"
    "packages/@overeng/kdl"
    "packages/@overeng/kdl-effect"
    "packages/@overeng/megarepo"
    "packages/@overeng/notion-cli"
    "packages/@overeng/notion-core"
    "packages/@overeng/notion-datasource-sync"
    "packages/@overeng/notion-effect-client"
    "packages/@overeng/notion-effect-schema"
    "packages/@overeng/notion-md"
    "packages/@overeng/notion-property-write"
    "packages/@overeng/notion-react"
    "packages/@overeng/npm-release"
    "packages/@overeng/otel-contract"
    "packages/@overeng/oxc-config"
    "packages/@overeng/pty-effect"
    "packages/@overeng/react-inspector"
    "packages/@overeng/restate-effect"
    "packages/@overeng/tui-core"
    "packages/@overeng/tui-react"
    "packages/@overeng/tui-stories"
    "packages/@overeng/ci-tools"
    "context/opentui"
    "context/effect/socket"
  ];

  packageTestQuarantine = { };
  validatedPackageTestQuarantine = lib.mapAttrs (
    name: quarantine:
    if quarantine ? reason && quarantine ? issue then
      quarantine
    else
      throw "packageTestQuarantine.${name} must include reason and issue"
  ) packageTestQuarantine;
  packageTestOverrides = {
    megarepo = {
      vitestArgs = "--exclude src/cli/store-gc-cold.integration.test.ts";
    };
    pty-effect = {
      after = [ "pnpm:link-native-node-packages" ];
    };
  };
  packagesRoot = ./. + "/packages/@overeng";
  hasTestFiles =
    root:
    let
      scan =
        dir:
        if builtins.pathExists dir then
          let
            entries = builtins.readDir dir;
            names = builtins.attrNames entries;
          in
          builtins.any (
            name:
            let
              entryType = entries.${name};
              child = dir + "/${name}";
            in
            if entryType == "regular" then
              builtins.match ".*\\.test\\.tsx?" name != null
            else if entryType == "directory" then
              scan child
            else
              false
          ) names
        else
          false;
    in
    scan (root + "/src") || scan (root + "/test");
  # Packages that have Vitest tests are discovered from the filesystem. If a
  # package with tests is excluded, it must be visible debt in packageTestQuarantine.
  packagesWithTests =
    let
      packageNames = builtins.filter (
        name:
        let
          root = packagesRoot + "/${name}";
        in
        (builtins.readDir packagesRoot).${name} == "directory"
        && builtins.pathExists (root + "/package.json")
        && hasTestFiles root
        && !(builtins.hasAttr name validatedPackageTestQuarantine)
      ) (builtins.attrNames (builtins.readDir packagesRoot));
    in
    map (
      name:
      {
        path = "packages/@overeng/${name}";
        inherit name;
      }
      // (packageTestOverrides.${name} or { })
    ) packageNames;
  baselineTestTaskRegistry = pkgs.writeText "effect4-baseline-test-task-registry.json" (
    builtins.toJSON (
      map (pkg: {
        packagePath = pkg.path;
        taskName = "test:${pkg.name}";
      }) packagesWithTests
    )
  );

  # Packages that have storybook (subset of allPackages)
  packagesWithStorybook = [
    {
      path = "packages/@overeng/tui-react";
      name = "tui-react";
      port = 6006;
    }
    {
      path = "packages/@overeng/megarepo";
      name = "megarepo";
      port = 6007;
    }
    {
      path = "packages/@overeng/genie";
      name = "genie";
      port = 6008;
    }
    {
      path = "packages/@overeng/effect-react";
      name = "effect-react";
      port = 6009;
    }
    {
      path = "packages/@overeng/effect-schema-form-aria";
      name = "effect-schema-form-aria";
      port = 6010;
    }
    {
      path = "packages/@overeng/react-inspector";
      name = "react-inspector";
      port = 6011;
    }
    {
      path = "packages/@overeng/notion-cli";
      name = "notion-cli";
      port = 6012;
    }
    {
      path = "packages/@overeng/tui-stories";
      name = "tui-stories";
      port = 6013;
    }
    {
      path = "packages/@overeng/notion-react";
      name = "notion-react";
      port = 6014;
    }
    {
      path = "packages/@overeng/notion-md";
      name = "notion-md";
      port = 6015;
    }
  ];
  packagesWithNetlifyPreview = lib.filter (pkg: pkg.name != "tui-stories") packagesWithStorybook;
  # Repository-specific semantic inputs read by Genie sources. The shared
  # Genie module already owns the direct and nested `.genie.ts` census; this
  # single list is composed into both its warm fingerprint and lint freshness.
  genieExtraInputGlobs = [
    "context/otel-scrape/telemetry-registry.json"
    "genie/buck2/*.ts"
    "packages/@overeng/buck2-tools/src/**/*.ts"
    "packages/@overeng/tui-core/buck2/target.ts"
    "packages/@overeng/tui-core/src/**/*.ts"
    "packages/@overeng/tui-core/src/**/*.tsx"
    "packages/@overeng/tui-core/src/**/*.cts"
    "packages/@overeng/tui-core/src/**/*.mts"
    "packages/@overeng/tui-core/test/**/*.ts"
    "packages/@overeng/tui-core/test/**/*.tsx"
    "packages/@overeng/tui-core/test/**/*.cts"
    "packages/@overeng/tui-core/test/**/*.mts"
    "pnpm-lock.yaml"
    "pnpm-workspace.yaml"
  ];
in
{
  imports = [
    # Git hook: prevent commits on default branch + enforce linked worktrees
    (taskModules.worktree-guard { })
    # OpenTelemetry observability stack (Collector + Tempo + Grafana)
    (import ./nix/devenv-modules/otel.nix { traceShellEntry = false; })
    # Hermetic native-devenv + effect-utils task-tree capture. Ambient mode
    # composes with the full stack above without importing it a second time.
    (import ./nix/devenv-modules/observability.nix {
      project = "effect-utils";
      # Shell-entry setup is intentionally absent. Profile an instantiated,
      # non-mutating task so check:all retains its trace integrity gate.
      profile = {
        name = "genie-check";
        task = "genie:check";
        mode = "single";
        smokeTask = "genie:check";
        smokeMode = "single";
        bridgeTask = "genie:check";
      };
      wireInto = [ "check:all" ];
    })
    # gh:apply-labels / gh:check-labels — reconcile .github/labels.json with live labels
    (import ./nix/devenv-modules/gh-labels.nix { repo = "overengineeringstudio/effect-utils"; })
    # Playwright browser drivers and environment setup
    inputs.playwright.devenvModules.default
    # Shared task modules
    taskModules.genie
    (taskModules.ts { tsBinPkg = effectTsgo; })
    (taskModules.megarepo { mrPkg = mrSourceCli; })
    (taskModules.lint-nix { })
    (taskModules.check {
      extraChecks = [
        "devenv:trace-audit"
        "workspace:check"
        "lint:nix"
      ];
      checkAllTypecheckTask = "ts:check:strict";
    })
    (taskModules.weaver { })
    # Wire the additive weaver gate into `check:all` only (not `check:quick`, which stays fast):
    # `after` list options merge across modules, so this appends without redefining check:all.
    { tasks."check:all".after = [ "weaver:check" ]; }
    # Bootstrap-safe import-closure gate (issue #884): fast local feedback for the bootstrap contract.
    # Fails (zero-tolerance, no baseline) on ANY `// @genie-bootstrap` generator whose transitive
    # runtime closure reaches a runtime-only package (which would break `genie --phase bootstrap` on a
    # fresh pre-install clone). Wired into `check:all` only (kept out of `check:quick`). The empirical
    # authority is `bootstrap:cold-proof` (R32); this static gate is its cheap pre-check.
    (taskModules.bootstrap-closure { })
    { tasks."check:all".after = [ "bootstrap-closure:check" ]; }
    # Compat-diff gate (SC-R11): blocks a PR that REMOVES a shipped registry attribute/signal.
    # PR-scoped (needs a merge-base baseline) — degrades to a warning locally on a fresh clone with
    # no `origin/main` merge-base; its load-bearing home is the CI `weaver` lane.
    (taskModules.weaver-diff { })
    { tasks."check:all".after = [ "weaver:diff" ]; }
    # Live-check e2e (SC-R12): emits registry-conformant OTLP from a first-party site, captures it,
    # and asserts `weaver registry live-check` accepts it (exit 0). Runs the scoped vitest e2e with
    # the hermetic weaver + semconv-model on env; degrades to a warning if weaver is unavailable.
    # Defined here so the CI `weaver` lane can invoke it, but deliberately NOT wired into `check:all`:
    # unlike the deterministic check/diff runs, this is a subprocess e2e (spawns otelite, binds an
    # ephemeral port, depends on export-flush timing), so it lives in CI rather than gating every
    # local `check:all` on capture reliability.
    (taskModules.weaver-live-check { })
    # Version-pin consistency smoke (SC-DQ4): catches weaver/semconv pin drift the content
    # gate (weaver:check) silently degrades past (a bumped version with a stale FOD hash).
    (taskModules.weaver-version-smoke { })
    { tasks."check:all".after = [ "weaver:version-smoke" ]; }
    (taskModules.clean { packages = allPackages; })
    # Repo-root pnpm install task
    # NOTE: Using pnpm temporarily. See: context/workarounds/bun-issues.md
    (taskModules.pnpm {
      packages = allPackages;
      inherit pnpmPkg;
    })
    # Self-contained test tasks: each package uses its own vitest from node_modules
    (taskModules.test {
      packages = packagesWithTests;
      extraTests = [ "devenv-modules:test" ];
      packageConcurrency = 4;
      retainVitestJson = true;
    })
    (taskModules.storybook {
      packages = packagesWithStorybook;
    })
    (taskModules.netlify {
      siteName = "overeng-utils";
      siteId = "462d2440-fb38-4e69-8023-9c425d1e2132";
      ciToolsBin = "${ciToolsSourceCli}/bin/ci-tools";
      deployments = map (pkg: {
        name = pkg.name;
        staticDir = "${pkg.path}/storybook-static";
        afterTask = "storybook:build:${pkg.name}";
        workspaceFilter = true;
      }) packagesWithNetlifyPreview;
    })
    # Workflow reports run as standalone CI control-plane steps, including when
    # a deploy is skipped. Use the hermetic package instead of relying on an
    # ambient source-workspace node_modules projection.
    (taskModules.workflow-report { })
    (taskModules.lint-oxc {
      oxlintPkg = oxlintWithPlugins;
      lintPaths = [
        "packages"
        "scripts"
        "context"
      ];
      # Match both repo-root and nested Genie sources explicitly, then compose
      # the same repository-specific semantic inputs used by the warm-state
      # fingerprint. This is freshness scheduling, not output admission.
      geniePatterns = [
        "*.genie.ts"
        "**/*.genie.ts"
      ]
      ++ genieExtraInputGlobs;
      genieCoverageDirs = [ "packages" ];
      # Type-aware linting for typescript/no-deprecated rule
      tsconfig = "tsconfig.check.json";
      # Warning cleanup is complete: every oxlint rule is at zero repo-wide
      # (swept + key rules promoted to error; non-API surfaces exempted by
      # override). Lint is now fatal on ANY warning so the gate can never
      # silently regress — enforced identically in CI and the local pre-commit
      # gate (both run `lint:check`).
      denyWarnings = true;
    })
    # Setup task (auto-runs in enterShell)
    # Context example tasks
    taskModules.context
    (taskModules.setup {
      # Repository mutation is explicit. Shell entry activates only the Nix
      # environment, so its latency and availability are independent of Buck,
      # pnpm, Genie, megarepo state, and the repository revision.
      runOnEnterShell = false;
      requiredTasks = [ ];
      # Reuse the Genie semantic-input SSOT in the cheap Git-index outer
      # fingerprint so a warm shell cannot bypass projection invalidation.
      extraFingerprintGlobs = genieExtraInputGlobs;
      # Keep shell entry resilient (R12): optional tasks run via @complete.
      # Ordering ensures source CLIs have deps before use.
      optionalTasks = [
        "pnpm:install"
        "genie:run"
        "mr:apply"
      ];
      completionsCliNames = [
        "genie"
        "mr"
      ];
    })
    # Nix CLI build and hash management
    (taskModules.nix-cli { cliPackages = nixCliPackages; })
    (taskModules.secretspec { })
    # Local task: Validate allPackages matches filesystem packages (effect-utils specific)
    ./nix/devenv-modules/tasks/local/workspace-check.nix
    taskModules.devenv-module-tests
    taskModules.asset-import-type-reference
    # Notion integration tests (requires NOTION_API_TOKEN)
    ./nix/devenv-modules/tasks/local/notion-integration-test.nix
    # Restate integration tests (native restate-server via RESTATE_SERVER_BIN)
    ./nix/devenv-modules/tasks/local/restate-integration-test.nix
  ];

  # The guarded `genie` command dispatches to the source-mode CLI in this repo;
  # downstream consumers should normally set this to the packaged effect-utils
  # Genie derivation.
  effectUtils.genie.package = genieSourceCli;

  # Non-`.genie.ts` sources share one list with the lint freshness scheduler.
  effectUtils.genie.extraInputGlobs = genieExtraInputGlobs;

  packages = [
    pkgs.nodejs_24
    pkgs.bun
    pkgs.typescript
    pkgs.flock # Cross-process locking for setup tasks (see setup.nix)
    # Buck's admitted event backend; avoids pnpm alias staleness and whole-tree
    # crawler races under concurrent repository tools.
    pkgs.watchman
    # restate-server (+ restate CLI) on $PATH for restate-effect integration tests.
    restate
    # Use the packaged wrapper so `notion db ...` runs on Node 24 with node:sqlite.
    repoFlake.packages.${currentSystem}.notion-cli
    # Rust binaries on PATH for local smoke tests and downstream wrappers.
    repoFlake.packages.${currentSystem}.otelite
    repoFlake.packages.${currentSystem}.otel-scrape
    # Nix-distributed direct Buck launcher; its wrapper pins the Buck binary.
    buck2Machine
    buck2SourceCli
    buck2Stage0Resolver
    cliBuildStamp.package
    ciToolsSourceCli
    (mkSourceCli {
      name = "tui-stories";
      entry = "packages/@overeng/tui-stories/bin/tui-stories.tsx";
    })
    # Rust toolchain for the standalone Rust crates.
    # Nix builds use pkgs.rustPlatform; these give local dev + the cargo CI lane
    # cargo/clippy/rustfmt/rust-analyzer matching nixpkgs' stable rust.
    pkgs.cargo
    pkgs.rustc
    pkgs.clippy
    pkgs.rustfmt
    pkgs.rust-analyzer
  ];

  # actionlint binary path for genie's workflow validation (also used by tests)
  env.GENIE_ACTIONLINT_BIN = "${pkgs.actionlint}/bin/actionlint";
  env.BUCK2_BIN = "${buck2Machine}/bin/buck2";
  env.BUCK2_MACHINE_VERSION = buck2Machine.version;

  # restate-server binary path for restate-effect integration tests (test/test-utils.ts
  # reads RESTATE_SERVER_BIN to locate the native server, else falls back to $PATH).
  env.RESTATE_SERVER_BIN = "${restate}/bin/restate-server";

  # Source-mode CLIs need pnpm install before running.
  # (The shared modules don't assume this — they work with Nix packages too.)
  tasks."genie:run".after = [ "pnpm:install" ];
  tasks."genie:watch".after = [ "pnpm:install" ];
  tasks."genie:check".after = [ "pnpm:install" ];
  tasks."lint:check:genie".after = [ "pnpm:install" ];
  tasks."mr:bootstrap".after = [ "pnpm:install" ];
  tasks."mr:setup".after = [ "pnpm:install" ];
  tasks."mr:fetch-apply".after = [ "pnpm:install" ];
  tasks."mr:lock".after = [ "pnpm:install" ];
  tasks."mr:apply".after = [ "pnpm:install" ];
  tasks."mr:check".after = [ "pnpm:install" ];
  tasks."mr:source-policy-check".after = [ "pnpm:install" ];

  # NOTE (decision 0004): there is deliberately NO `genie:bootstrap`-before-`pnpm:install` edge.
  # An earlier form wired `pnpm:install.after = [ "genie:bootstrap" ]` so install would run
  # `genie --phase bootstrap` first. Verified during implementation that this does NOT arbitrate
  # bootstrap-safety: the source-mode `genie` on PATH needs `node_modules` (it cold-guarded to a
  # no-op on a fresh clone), and committed outputs (T01) mean install succeeds with the on-disk
  # `package.json` regardless — so the edge enforced nothing while adding cost to every warm install
  # and a new failure mode. Bootstrap-safety is instead demonstrated empirically by
  # `bootstrap:cold-proof` (R32, below), with `bootstrap-closure:check` as fast local feedback.

  # bootstrap:cold-proof (R32) — the EMPIRICAL bootstrap-safety authority. In a fresh, no-node_modules
  # tree of the committed source it runs the self-contained packaged Genie CLI
  # (`.#genie`, deps baked into the store) with `--phase bootstrap`, then
  # `pnpm install --frozen-lockfile`, asserting both succeed.
  # This exercises the exact pre-install path and turns bootstrap-safety from asserted into
  # demonstrated. Heavy (nix build + full install) so it is a dedicated task/CI lane, NOT in
  # `check:all`. Set GENIE_COLD_PROOF_BIN to reuse an already-built genie and skip the nix build.
  tasks."bootstrap:cold-proof" = {
    description = "Prove bootstrap-phase genie + pnpm install run cold (no node_modules) — R32 authority";
    exec = trace.exec "bootstrap:cold-proof" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      exec bash "$root/genie/ci-scripts/bootstrap-cold-proof.sh"
    '';
  };

  tasks."pnpm:link-native-node-packages" = {
    after = [ "pnpm:install" ];
    description = "Link Nix-built native Node packages into the pnpm projection";
    exec = trace.exec "pnpm:link-native-node-packages" ''
      set -euo pipefail
      source ${lib.escapeShellArg pnpmTaskHelpersScript}

      link_native_package() {
        local package_name="$1"
        local package_path="$2"
        local rel_path="$package_name"
        local search_roots=(node_modules)

        if [[ "$package_name" == @*/* ]]; then
          rel_path="$(dirname "$package_name")/$(basename "$package_name")"
        fi

        find "''${search_roots[@]}" \
          -path "*/node_modules/$rel_path" \
          -exec sh -c 'package_path="$1"; shift; for target do rm -rf "$target"; ln -s "$package_path" "$target"; done' sh "$package_path" {} +
      }

      link_native_package "node-pty" "${nodePtyNative}/node_modules/node-pty"
    '';
  };

  tasks."test:megarepo-cold-gc" = {
    after = [ "pnpm:install" ];
    description = "Run isolated megarepo cold-GC integration tests";
    cwd = "packages/@overeng/megarepo";
    exec = trace.exec "test:megarepo-cold-gc" ''
      set -euo pipefail
      source ${lib.escapeShellArg pnpmTaskHelpersScript}
      run_package_bin vitest vitest run src/cli/store-gc-cold.integration.test.ts --reporter verbose --testTimeout 240000
    '';
    execIfModified = [
      "packages/@overeng/megarepo/src/**/*.ts"
      "packages/@overeng/megarepo/src/**/*.tsx"
      "packages/@overeng/megarepo/vitest.config.ts"
    ];
  };

  tasks."bundle:smoke" = {
    after = [ "pnpm:install" ];
    description = "Bundle representative public entries with Vite/Rollup dependency resolution";
    exec = trace.exec "bundle:smoke" ''
      set -euo pipefail
      DEVENV_TASK_PASSTHROUGH=1 pnpm --dir packages/@overeng/pty-effect run bundle:smoke
    '';
  };

  tasks."gh:apply-settings" = {
    after = [ "genie:run" ];
    exec = trace.exec "gh:apply-settings" ''
      set -euo pipefail
      ruleset_id=$(gh api repos/overengineeringstudio/effect-utils/rulesets --jq '.[0].id')
      gh api "repos/overengineeringstudio/effect-utils/rulesets/$ruleset_id" --method PUT --input .github/repo-settings.json
      echo "Applied repo-settings.json to ruleset $ruleset_id"
    '';
    description = "Apply .github/repo-settings.json to GitHub ruleset";
  };

  tasks."devenv:trace-audit" = {
    description = "Check active devenv task modules route every exec/status through trace.* (otel-span task span; concrete commands opt into otel-scrape via trace.instr)";
    exec = trace.exec "devenv:trace-audit" ''
      set -euo pipefail
      # Every active devenv task exec/status must route through the trace.nix
      # helpers (trace.exec / trace.status / trace.withStatus) so the otel-span
      # task span owns task identity. This audit greps for raw `exec =`/`status =`
      # attributes that do NOT go through trace.*.
      #
      # Every pattern uses POSIX bracket classes ([[:space:]], [.]) and NEVER a
      # backslash escape. A literal backslash-s / backslash-dot inside this Nix
      # indented string becomes a double-backslash that matches nothing, which
      # silently turns the whole audit vacuous (it always exits 0) — the exact
      # failure this rewrite fixes.
      #
      # A few raw exec/status lines are legitimately allowed and are annotated
      # with a `trace-audit-allow` marker comment IMMEDIATELY ABOVE the line:
      #   - the raw string is an argument passed INTO trace.* a few lines below
      #     (restate integration test, ts:emit).
      # A deliberately-untraced task would also qualify, but there are currently
      # none: every thin `ci-tools` delegation task (netlify/vercel deploys,
      # workflow-report) routes through trace.exec for a task span.
      # The marker is matched in a 2-line window (the line plus the one above),
      # so this stays robust to line shifts — no fragile file:line pins.
      marker='trace-audit-allow'
      violations=0
      while IFS= read -r hit; do
        file="''${hit%%:*}"
        rest="''${hit#*:}"
        lineno="''${rest%%:*}"
        if ${head} -n "$lineno" "$file" | ${tail} -n 2 | ${grep} -q "$marker"; then
          continue
        fi
        violations=1
        echo "BYPASS: $hit" >&2
      done < <(
        ${rg} -n '^[[:space:]]*(exec|status) = ' \
          devenv.nix \
          nix/devenv-modules/tasks/shared \
          nix/devenv-modules/tasks/local \
          -g '*.nix' \
          | ${rg} -v 'trace[.](exec|status)|exec = null|exec = if hasPackages then null else trace[.]exec|trace[.]withStatus'
      )
      if [ "$violations" -ne 0 ]; then
        echo "Found task exec/status scripts that bypass the trace.nix task span (trace.exec/status/withStatus)." >&2
        echo "Route them through trace.* or, if intentionally raw, add a 'trace-audit-allow' marker comment above the line with justification." >&2
        exit 1
      fi
    '';
  };

  tasks."cargo:test:buck2-foundation" = {
    description = "Run the Rust tests for the Buck2 foundation tools";
    exec = trace.exec "cargo:test:buck2-foundation" ''
      set -euo pipefail
      (
        cd rust
        cargo test --locked --package 'buck2-*'
      )
    '';
  };

  tasks."cargo:check" = {
    description = "Validate the shared Cargo workspace, then build, test, lint, and format-check each member";
    after = [ "cargo:test:buck2-foundation" ];
    exec = trace.exec "cargo:check" ''
      set -euo pipefail
      ${pkgs.bash}/bin/bash rust/workspace-contract.test.sh "$PWD"
      (
        cd rust
        cargo build --release --locked --workspace
        cargo test --locked --workspace --exclude 'buck2-*'
        cargo clippy --locked --workspace --all-targets -- -D warnings
        cargo fmt --all --check
      )
    '';
  };

  tasks."dependency-materialization:evidence:check" = {
    description = "Validate committed dependency-materialization benchmark and host-capability evidence";
    exec = trace.exec "dependency-materialization:evidence:check" ''
      ${pkgs.nodejs}/bin/node \
        context/dependency-materialization/07-verification/evidence/validate-storage-sharing-default.mjs
    '';
  };

  tasks."buck2:build:foundation" = {
    description = "Build exact-closure and portable-toolchain Buck2 evidence with remote execution/cache disabled";
    exec = trace.exec "buck2:build:foundation" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      buck2_stage0_config="$(${buck2Stage0Resolve})"
      exec ${buck2Task} \
        --evidence-dir "$root/tmp/buck2-evidence" \
        --print-command \
        -- build --config-file "$buck2_stage0_config" //:buck2_foundation //:portable_toolchain_evidence --local-only --no-remote-cache
    '';
  };

  tasks."buck2:test:foundation" = {
    description = "Run strict Buck2 closure, package-evidence, and portable-toolchain tests locally";
    after = [ "cargo:test:buck2-foundation" ];
    exec = trace.exec "buck2:test:foundation" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      buck2_stage0_config="$(${buck2Stage0Resolve})"
      exec ${buck2Task} \
        --evidence-dir "$root/tmp/buck2-evidence" \
        --print-command \
        -- build --config-file "$buck2_stage0_config" \
          //:buck2_foundation \
          //:portable_toolchain_evidence \
          --local-only --no-remote-cache
    '';
  };

  tasks."buck2:e2e:tui-core" = {
    description = "Generate, build, and observe the provisional tui-core Buck input-plan evidence";
    after = [ "genie:run" ];
    exec = trace.exec "buck2:e2e:tui-core" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      buck2_stage0_config="$(${buck2Stage0Resolve})"
      export AWK_BIN=${pkgs.gawk}/bin/awk
      export JQ_BIN=${pkgs.jq}/bin/jq
      export NIX_BIN=${pkgs.nix}/bin/nix
      export BUCK2_STAGE0_CONFIG="$buck2_stage0_config"
      exec ${pkgs.bash}/bin/bash scripts/buck2-package-e2e.sh \
        "$root" ${buck2Task} //packages/@overeng/tui-core:typescript_input_plan
    '';
  };

  tasks."buck2:nix-bridge:check" = {
    description = "Check the strict build-product contract, Nix tool export, and fail-closed artifact importer";
    exec = trace.exec "buck2:nix-bridge:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      buck2_stage0_config="$(${buck2Stage0Resolve})"
      export BUCK2_BIN=${buck2Machine}/bin/buck2
      export BUCK2_STAGE0_CONFIG="$buck2_stage0_config"
      ${pkgs.bash}/bin/bash nix/workspace-tools/lib/tests/buck2-build-product-contract.sh "$PWD"
      exec ${pkgs.bash}/bin/bash nix/workspace-tools/lib/tests/buck2-bridge.sh "$PWD"
    '';
  };

  tasks."buck2:foundation:graph-check" = {
    description = "Prove the Buck2 foundation has no repo-owned Python or CPython graph edges";
    exec = trace.exec "buck2:foundation:graph-check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      buck2_stage0_config="$(${buck2Stage0Resolve})"
      export BUCK2_STAGE0_CONFIG="$buck2_stage0_config"
      exec ${pkgs.bash}/bin/bash scripts/buck2-foundation-graph-check.sh \
        "$PWD" ${pkgs.buck2}/bin/buck2
    '';
  };

  tasks."buck2:benchmark:check" = {
    description = "Validate the Buck2 benchmark parser, immutable evidence, and non-mutating dry-run contract";
    exec = trace.exec "buck2:benchmark:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      ${pkgs.nodejs}/bin/node --test \
        scripts/buck2-benchmark/lib.unit.test.mjs \
        scripts/buck2-benchmark/evidence-integrity.unit.test.mjs \
        scripts/buck2-benchmark/dry-run.integration.test.mjs
      ${pkgs.nodejs}/bin/node scripts/buck2-benchmark/benchmark.mjs \
        --output "$root/tmp/buck2-benchmark/dry-run.jsonl"
    '';
  };

  tasks."buck2:invalidation:e2e" = {
    description = "Prove canonical source mutation invalidates Buck2 through the configured file watcher";
    exec = trace.exec "buck2:invalidation:e2e" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      buck2_stage0_config="$(${buck2Stage0Resolve})"
      export AWK_BIN=${pkgs.gawk}/bin/awk
      export SHA256_BIN=${pkgs.coreutils}/bin/sha256sum
      export BUCK2_STAGE0_CONFIG="$buck2_stage0_config"
      exec ${pkgs.bash}/bin/bash scripts/buck2-invalidation-e2e.sh \
        "$root" ${pkgs.buck2}/bin/buck2
    '';
  };

  tasks."buck2:platform:check" = {
    description = "Reject a Buck2 package target whose declared platform differs from the local-only host";
    exec = trace.exec "buck2:platform:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      buck2_stage0_config="$(${buck2Stage0Resolve})"
      isolation="platform-check-$$-$RANDOM"
      stderr_file="$(${pkgs.coreutils}/bin/mktemp "''${TMPDIR:-/tmp}/buck2-platform-check.XXXXXX")"
      cleanup() {
        ${pkgs.buck2}/bin/buck2 --isolation-dir "$isolation" kill >/dev/null 2>&1 || true
        ${pkgs.coreutils}/bin/rm -f "$stderr_file"
      }
      trap cleanup EXIT
      trap 'exit 130' INT
      trap 'exit 143' TERM

      if ${pkgs.buck2}/bin/buck2 \
        --isolation-dir "$isolation" \
        build --config-file "$buck2_stage0_config" --fake-arch aarch64 \
        //packages/@overeng/tui-core:typescript_input_plan \
        --local-only --no-remote-cache \
        >/dev/null 2>"$stderr_file"; then
        echo "buck2:platform:check: mismatched platform unexpectedly built" >&2
        exit 1
      fi
      actual="$(${pkgs.gawk}/bin/awk '
        /error: fail: package_task platform mismatch:/ {
          sub(/^.*error: fail: package_task platform mismatch: /, "")
          print
          exit
        }
      ' "$stderr_file")"
      expected="target requires x86_64-linux, local-only execution host is aarch64-linux"
      if [ "$actual" != "$expected" ]; then
        echo "buck2:platform:check: unexpected diagnostic: $actual" >&2
        exit 1
      fi
      echo "buck2:platform:check: PASS diagnostic=$actual"
    '';
  };

  tasks."buck2:rust-musl:check" = lib.mkIf (currentSystem == "x86_64-linux") {
    description = "Prove the Nix-authored Rust toolchain, target, and execution-platform contract";
    exec = trace.exec "buck2:rust-musl:check" ''
      set -euo pipefail
      isolation="rust-musl-check-$$-$RANDOM"
      stderr_file="$(${pkgs.coreutils}/bin/mktemp "''${TMPDIR:-/tmp}/buck2-rust-musl-check.XXXXXX")"
      toolchain_root_dir=""
      cleanup() {
        ${pkgs.buck2}/bin/buck2 --isolation-dir "$isolation" kill >/dev/null 2>&1 || true
        if [ -n "$toolchain_root_dir" ]; then
          ${pkgs.coreutils}/bin/rm -f "$toolchain_root_dir/toolchain"
          ${pkgs.coreutils}/bin/rmdir "$toolchain_root_dir" 2>/dev/null || true
        fi
        ${pkgs.coreutils}/bin/rm -f "$stderr_file"
      }
      trap cleanup EXIT
      trap 'exit 130' INT
      trap 'exit 143' TERM

      # Keep the large cross-toolchain out of the default devenv closure. This
      # explicit task boundary realizes it only when the Rust probe is run. The
      # temporary out-link roots the config and its transitive toolchain closure
      # until every Buck invocation has finished, including under concurrent GC.
      toolchain_root_dir="$(${pkgs.coreutils}/bin/mktemp -d "''${TMPDIR:-/tmp}/buck2-rust-musl-root.XXXXXX")"
      toolchain_config="$(${pkgs.nix}/bin/nix build \
        --out-link "$toolchain_root_dir/toolchain" \
        --print-out-paths \
        .#buck2-rust-musl-toolchain-config)"

      buck2_with_toolchain_root() {
        if [ ! -L "$toolchain_root_dir/toolchain" ] || \
          [ "$(${pkgs.coreutils}/bin/readlink -f "$toolchain_root_dir/toolchain")" != "$toolchain_config" ] || \
          [ ! -e "$toolchain_config" ]; then
          echo "buck2:rust-musl:check: toolchain GC root disappeared before Buck completed" >&2
          return 1
        fi
        ${pkgs.buck2}/bin/buck2 "$@"
      }

      common=(
        --isolation-dir "$isolation"
        build
        --config-file "$toolchain_config"
        --target-platforms //buck2/platforms:target_x86_64_linux_musl_static
        //buck2/rust:static_hello
        --local-only
        --no-remote-cache
      )

      if buck2_with_toolchain_root "''${common[@]}" \
        --config build.execution_platforms=prelude//platforms:default \
        >/dev/null 2>"$stderr_file"; then
        echo "buck2:rust-musl:check: default execution platform unexpectedly admitted" >&2
        exit 1
      fi
      ${pkgs.gnugrep}/bin/grep -F "No compatible execution platform" "$stderr_file" >/dev/null || {
        echo "buck2:rust-musl:check: missing execution-platform rejection" >&2
        exit 1
      }

      if buck2_with_toolchain_root "''${common[@]}" \
        --config rust_toolchain.target_platform=//buck2/platforms:target_x86_64_linux_glibc_dynamic \
        >/dev/null 2>"$stderr_file"; then
        echo "buck2:rust-musl:check: mismatched Nix toolchain metadata unexpectedly admitted" >&2
        exit 1
      fi
      ${pkgs.gnugrep}/bin/grep -F "Rust toolchain target platform mismatch" "$stderr_file" >/dev/null || {
        echo "buck2:rust-musl:check: missing toolchain-metadata rejection" >&2
        exit 1
      }

      buck2_with_toolchain_root "''${common[@]}"
      identity="$(${pkgs.gawk}/bin/awk '$1 == "toolchain_identity" { print $3 }' "$toolchain_config")"
      echo "buck2:rust-musl:check: PASS identity=$identity"
    '';
  };

  tasks."buck2:check" = {
    description = "Run Buck2 foundation, invalidation, platform, Nix bridge, and benchmark gates";
    after = [
      "buck2:build:foundation"
      "buck2:test:foundation"
      "buck2:foundation:graph-check"
      "buck2:e2e:tui-core"
      "buck2:nix-bridge:check"
      "buck2:benchmark:check"
      "buck2:invalidation:e2e"
      "buck2:platform:check"
    ]
    ++ lib.optionals (currentSystem == "x86_64-linux") [
      "buck2:rust-musl:check"
    ];
  };

  tasks."check:all".after =
    lib.optionals (currentSystem == "x86_64-linux") [
      "buck2:check"
    ]
    ++ [
      "cargo:check"
      "dependency-materialization:evidence:check"
    ];

  # `test:run` executes after its package-task dependencies, so both Effect 4
  # gates see the complete managed-test summary directory in CI.
  tasks."test:run".exec = lib.mkForce (
    trace.exec "test:run" ''
      set -euo pipefail
      ${pkgs.bun}/bin/bun context/effect-4/check-baseline-migration-markers.ts
      ${pkgs.bun}/bin/bun context/effect-4/check-baseline-test-collection.ts \
        --task-registry ${baselineTestTaskRegistry}
    ''
  );

  # Keep git-hook installation out of the shell-entry path.
  # If needed, install with `devenv tasks run devenv:git-hooks:install`.
  # TODO(cachix/git-hooks.nix#688): remove this once the upstream git-hooks.nix issue
  # is fixed; currently this workaround prevents shell-entry failures with core.hooksPath.
  tasks."devenv:git-hooks:install".before = lib.mkForce [ ];

  # Repo-local pnpm store for consistent local installs (not used by Nix builds).
  env.PNPM_STORE_DIR = "${config.devenv.root}/.devenv/pnpm-store-pure-v1";

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
    ${cliBuildStamp.shellHook}
  '';

  git-hooks.enable = true;
  git-hooks.hooks.check-quick = {
    enable = true;
    entry = "DEVENV_TUI=false devenv tasks run check:quick";
    stages = [ "pre-commit" ];
    always_run = true;
    pass_filenames = false;
  };
}
