{ pkgs, inputs, config, ... }:
let
  cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
  # Use npm oxlint with NAPI bindings to enable JavaScript plugin support
  oxlintNpm = import ./nix/oxlint-npm.nix {
    inherit pkgs;
    bun = pkgs.bun;
  };

  # Shared task modules (from shared/ directory)
  taskModules = {
    genie = ./nix/devenv-modules/tasks/shared/genie.nix;
    ts = import ./nix/devenv-modules/tasks/shared/ts.nix;
    setup = import ./nix/devenv-modules/tasks/shared/setup.nix;
    check = import ./nix/devenv-modules/tasks/shared/check.nix;
    clean = import ./nix/devenv-modules/tasks/shared/clean.nix;
    test = import ./nix/devenv-modules/tasks/shared/test.nix;
    test-playwright = import ./nix/devenv-modules/tasks/shared/test-playwright.nix;
    storybook = import ./nix/devenv-modules/tasks/shared/storybook.nix;
    lint-genie = ./nix/devenv-modules/tasks/shared/lint-genie.nix;
    lint-oxc = import ./nix/devenv-modules/tasks/shared/lint-oxc.nix;
    bun = import ./nix/devenv-modules/tasks/shared/bun.nix;
    pnpm = import ./nix/devenv-modules/tasks/shared/pnpm.nix;
    megarepo = ./nix/devenv-modules/tasks/shared/megarepo.nix;
    nix-cli = import ./nix/devenv-modules/tasks/shared/nix-cli.nix;
    context = ./nix/devenv-modules/tasks/shared/context.nix;
  };
  # Use bun source entrypoints for in-repo CLIs in devenv (flake builds stay strict).
  mkSourceCli = import ./nix/devenv-modules/lib/mk-source-cli.nix { inherit pkgs; };

  # CLI packages built with Nix (for hash management)
  nixCliPackages = [
    { name = "genie"; flakeRef = ".#genie"; buildNix = "packages/@overeng/genie/nix/build.nix"; lockfile = "packages/@overeng/genie/pnpm-lock.yaml"; }
    { name = "megarepo"; flakeRef = ".#megarepo"; buildNix = "packages/@overeng/megarepo/nix/build.nix"; lockfile = "packages/@overeng/megarepo/pnpm-lock.yaml"; }
  ];

  # All packages for per-package install tasks
  # NOTE: Using pnpm temporarily due to bun bugs. Plan to switch back once fixed.
  # See: context/workarounds/bun-issues.md
  allPackages = [
    "packages/@overeng/effect-ai-claude-cli"
    "packages/@overeng/effect-path"
    "packages/@overeng/effect-react"
    "packages/@overeng/effect-rpc-tanstack"
    "packages/@overeng/effect-rpc-tanstack/examples/basic"
    "packages/@overeng/effect-schema-form"
    "packages/@overeng/effect-schema-form-aria"
    "packages/@overeng/genie"
    "packages/@overeng/megarepo"
    "packages/@overeng/notion-cli"
    "packages/@overeng/notion-effect-client"
    "packages/@overeng/notion-effect-schema"
    "packages/@overeng/oxc-config"
    "packages/@overeng/react-inspector"
    "packages/@overeng/tui-core"
    "packages/@overeng/tui-react"
    "packages/@overeng/utils"
    "packages/@overeng/utils-dev"
    "context/opentui"
    "context/effect/socket"
  ];

  # Packages that have vitest tests (subset of allPackages)
  # Each package uses its own vitest from node_modules (self-contained)
  packagesWithTests = [
    { path = "packages/@overeng/effect-ai-claude-cli"; name = "effect-ai-claude-cli"; }
    { path = "packages/@overeng/effect-path"; name = "effect-path"; }
    { path = "packages/@overeng/effect-rpc-tanstack"; name = "effect-rpc-tanstack"; }
    { path = "packages/@overeng/genie"; name = "genie"; }
    { path = "packages/@overeng/megarepo"; name = "megarepo"; }
    { path = "packages/@overeng/notion-cli"; name = "notion-cli"; }
    { path = "packages/@overeng/notion-effect-client"; name = "notion-effect-client"; }
    { path = "packages/@overeng/notion-effect-schema"; name = "notion-effect-schema"; }
    { path = "packages/@overeng/oxc-config"; name = "oxc-config"; }
    { path = "packages/@overeng/tui-core"; name = "tui-core"; }
    { path = "packages/@overeng/tui-react"; name = "tui-react"; }
    { path = "packages/@overeng/utils"; name = "utils"; }
  ];

  # Packages that have storybook (subset of allPackages)
  packagesWithStorybook = [
    { path = "packages/@overeng/tui-react"; name = "tui-react"; port = 6006; }
    { path = "packages/@overeng/megarepo"; name = "megarepo"; port = 6007; }
    { path = "packages/@overeng/genie"; name = "genie"; port = 6008; }
    { path = "packages/@overeng/effect-react"; name = "effect-react"; port = 6009; }
    { path = "packages/@overeng/effect-schema-form-aria"; name = "effect-schema-form-aria"; port = 6010; }
    { path = "packages/@overeng/react-inspector"; name = "react-inspector"; port = 6011; }
    { path = "packages/@overeng/notion-cli"; name = "notion-cli"; port = 6012; }
  ];
in
{
  imports = [
    # Beads integration: env vars, sync task, commit correlation hook
    (inputs.overeng-beads-public.devenvModules.beads {
      beadsPrefix = "oep";
      beadsRepoName = "overeng-beads-public";
    })
    # `dt` (devenv tasks) wrapper script and shell completions
    ./nix/devenv-modules/dt.nix
    # Playwright browser drivers and environment setup
    inputs.playwright.devenvModules.default
    # Shared task modules
    taskModules.genie
    # Use package-local tsc patched by effect-language-service (same pattern as vitest in test.nix)
    (taskModules.ts {
      tscBin = "packages/@overeng/utils/node_modules/.bin/tsc";
      lspPatchCmd = "packages/@overeng/utils/node_modules/.bin/effect-language-service patch --dir packages/@overeng/utils/node_modules/typescript";
    })
    taskModules.megarepo
    (taskModules.check { extraChecks = [ "workspace:check" ]; })
    (taskModules.clean { packages = allPackages; })
    # Per-package pnpm install tasks
    # NOTE: Using pnpm temporarily. See: context/workarounds/bun-issues.md
    (taskModules.pnpm { packages = allPackages; })
    # Self-contained test tasks: each package uses its own vitest from node_modules
    (taskModules.test {
      packages = packagesWithTests;
      extraTests = [ "nix:test" ];
    })
    (taskModules.storybook {
      packages = packagesWithStorybook;
    })
    (taskModules.lint-oxc {
      lintPaths = [
        "packages"
        "scripts"
        "context"
      ];
      # Avoid oxfmt walking node_modules while pnpm installs are mutating it in parallel.
      formatAfter = [ "pnpm:install" ];
      # Explicit patterns that avoid node_modules traversal
      # Key insight: patterns like "packages/*/src/**" are safe because src/ never contains node_modules
      execIfModifiedPatterns = [
        # packages: src directories (safe - no node_modules inside src)
        "packages/@overeng/*/src/**/*.ts"
        "packages/@overeng/*/src/**/*.tsx"
        "packages/@overeng/*/src/**/*.js"
        "packages/@overeng/*/src/**/*.jsx"
        # packages: root level config files
        "packages/@overeng/*/*.ts"
        "packages/@overeng/*/*.js"
        # packages: bin, .storybook, stories, stress-test directories
        "packages/@overeng/*/bin/*.ts"
        "packages/@overeng/*/.storybook/*.ts"
        "packages/@overeng/*/.storybook/*.tsx"
        "packages/@overeng/*/stories/**/*.ts"
        "packages/@overeng/*/stories/**/*.tsx"
        "packages/@overeng/*/stress-test/**/*.ts"
        # packages: test directories and setup files
        "packages/@overeng/*/test/**/*.ts"
        "packages/@overeng/*/test/**/*.tsx"
        "packages/@overeng/*/vitest.setup.ts"
        # packages/examples: specific paths (examples/basic has node_modules)
        "packages/@overeng/*/examples/*/*.ts"
        "packages/@overeng/*/examples/*/*.tsx"
        "packages/@overeng/*/examples/*/src/**/*.ts"
        "packages/@overeng/*/examples/*/src/**/*.tsx"
        "packages/@overeng/*/examples/*/tests/*.ts"
        "packages/@overeng/*/examples/**/*.ts"
        "packages/@overeng/*/examples/**/*.tsx"
        # scripts
        "scripts/*.ts"
        "scripts/commands/**/*.ts"
        # context: specific safe paths
        "context/cli-design/*.ts"
        "context/effect/socket/*.genie.ts"
        "context/effect/socket/examples/*.ts"
        "context/opentui/*.genie.ts"
        # linter config files (changes should trigger lint)
        ".oxfmtrc.json"
        ".oxlintrc.json"
      ];
      # Genie file patterns for caching genie:check tasks
      geniePatterns = [
        "packages/@overeng/*/*.genie.ts"
        "packages/@overeng/*/examples/*/*.genie.ts"
        "scripts/*.genie.ts"
        "context/effect/socket/*.genie.ts"
        "context/opentui/*.genie.ts"
        ".oxfmtrc.json.genie.ts"
        ".oxlintrc.json.genie.ts"
      ];
      genieCoverageDirs = [ "packages" ];
      # Type-aware linting for typescript/no-deprecated rule
      tsconfig = "tsconfig.all.json";
    })
    # Setup task (auto-runs in enterShell)
    # Context example tasks
    taskModules.context
    (taskModules.setup {
      requiredTasks = [ ];
      # Keep shell entry resilient (R12): optional tasks run via @complete.
      # Ordering ensures source CLIs have deps before use.
      optionalTasks = [ "pnpm:install" "genie:run" "megarepo:sync" "ts:build" ];
      completionsCliNames = [ "genie" "mr" ];
    })
    # Nix CLI build and hash management
    (taskModules.nix-cli { cliPackages = nixCliPackages; })
    # Local task: Validate allPackages matches filesystem packages (effect-utils specific)
    ./nix/devenv-modules/tasks/local/workspace-check.nix
  ];

  packages = [
    pkgs.pnpm
    pkgs.nodejs_24
    pkgs.bun
    pkgs.typescript
    pkgs.flock  # Cross-process locking for setup tasks (see setup.nix)
    oxlintNpm
    pkgs.oxfmt
    (mkSourceCli { name = "genie"; entry = "packages/@overeng/genie/bin/genie.tsx"; })
    (mkSourceCli { name = "mr"; entry = "packages/@overeng/megarepo/bin/mr.ts"; })
    cliBuildStamp.package
  ];

  # Source-mode CLIs need pnpm install before running.
  # (The shared modules don't assume this — they work with Nix packages too.)
  tasks."genie:run".after = [ "pnpm:install:genie" ];
  tasks."genie:watch".after = [ "pnpm:install:genie" ];
  tasks."genie:check".after = [ "pnpm:install:genie" ];
  tasks."megarepo:sync".after = [ "pnpm:install:megarepo" ];

  # Repo-local pnpm store for consistent local installs (not used by Nix builds).
  env.PNPM_STORE_DIR = "${config.devenv.root}/.pnpm-store";


  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
    ${cliBuildStamp.shellHook}
  '';

  git-hooks.enable = true;
  git-hooks.hooks.check-quick = {
    enable = true;
    entry = "dt check:quick";
    stages = ["pre-commit"];
    always_run = true;
    pass_filenames = false;
  };
}
