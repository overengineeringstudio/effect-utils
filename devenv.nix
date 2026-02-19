{
  pkgs,
  inputs,
  config,
  lib,
  ...
}:
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
    worktree-guard = import ./nix/devenv-modules/tasks/shared/worktree-guard.nix;
    setup = import ./nix/devenv-modules/tasks/shared/setup.nix;
    check = import ./nix/devenv-modules/tasks/shared/check.nix;
    clean = import ./nix/devenv-modules/tasks/shared/clean.nix;
    test = import ./nix/devenv-modules/tasks/shared/test.nix;
    test-playwright = import ./nix/devenv-modules/tasks/shared/test-playwright.nix;
    storybook = import ./nix/devenv-modules/tasks/shared/storybook.nix;
    netlify = import ./nix/devenv-modules/tasks/shared/netlify.nix;
    lint-genie = ./nix/devenv-modules/tasks/shared/lint-genie.nix;
    lint-oxc = import ./nix/devenv-modules/tasks/shared/lint-oxc.nix;
    bun = import ./nix/devenv-modules/tasks/shared/bun.nix;
    pnpm = import ./nix/devenv-modules/tasks/shared/pnpm.nix;
    megarepo = import ./nix/devenv-modules/tasks/shared/megarepo.nix;
    nix-cli = import ./nix/devenv-modules/tasks/shared/nix-cli.nix;
    context = ./nix/devenv-modules/tasks/shared/context.nix;
    beads = import ./nix/devenv-modules/tasks/shared/beads.nix;
  };
  # Use bun source entrypoints for in-repo CLIs in devenv (flake builds stay strict).
  mkSourceCli = import ./nix/devenv-modules/lib/mk-source-cli.nix { inherit pkgs; };

  # CLI packages built with Nix (for hash management)
  nixCliPackages = [
    {
      name = "genie";
      flakeRef = ".#genie";
      buildNix = "packages/@overeng/genie/nix/build.nix";
      lockfile = "packages/@overeng/genie/pnpm-lock.yaml";
    }
    {
      name = "megarepo";
      flakeRef = ".#megarepo";
      buildNix = "packages/@overeng/megarepo/nix/build.nix";
      lockfile = "packages/@overeng/megarepo/pnpm-lock.yaml";
    }
    {
      name = "oxlint-npm";
      flakeRef = ".#oxlint-npm";
      buildNix = "nix/oxc-config-plugin.nix";
      lockfile = "packages/@overeng/oxc-config/pnpm-lock.yaml";
      pnpmInstallTask = "oxc-config";
    }
  ];

  # All packages for per-package install tasks
  # NOTE: Using pnpm temporarily due to bun bugs. Plan to switch back once fixed.
  # See: context/workarounds/bun-issues.md
  # NOTE: Order matters for sequential pnpm install chain.
  # Packages near the front complete first, enabling dependent tasks to start sooner.
  # utils is first because ts:patch-lsp depends on it (for Effect Language Service).
  allPackages = [
    "packages/@overeng/utils"
    "packages/@overeng/utils-dev"
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
    "context/opentui"
    "context/effect/socket"
  ];

  # Packages that have vitest tests (subset of allPackages)
  # Each package uses its own vitest from node_modules (self-contained)
  packagesWithTests = [
    {
      path = "packages/@overeng/effect-ai-claude-cli";
      name = "effect-ai-claude-cli";
    }
    {
      path = "packages/@overeng/effect-path";
      name = "effect-path";
    }
    {
      path = "packages/@overeng/effect-rpc-tanstack";
      name = "effect-rpc-tanstack";
    }
    {
      path = "packages/@overeng/genie";
      name = "genie";
    }
    {
      path = "packages/@overeng/megarepo";
      name = "megarepo";
    }
    {
      path = "packages/@overeng/notion-cli";
      name = "notion-cli";
    }
    {
      path = "packages/@overeng/notion-effect-client";
      name = "notion-effect-client";
    }
    {
      path = "packages/@overeng/notion-effect-schema";
      name = "notion-effect-schema";
    }

    {
      path = "packages/@overeng/oxc-config";
      name = "oxc-config";
    }
    {
      path = "packages/@overeng/tui-core";
      name = "tui-core";
    }
    {
      path = "packages/@overeng/tui-react";
      name = "tui-react";
    }
    {
      path = "packages/@overeng/utils";
      name = "utils";
    }
  ];

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
  ];
in
{
  imports = [
    # Beads integration: daemon, sync task, commit correlation hook
    (taskModules.beads {
      beadsPrefix = "oep";
      beadsRepoName = "overeng-beads-public";
    })
    # `dt` (devenv tasks) wrapper script and shell completions
    ./nix/devenv-modules/dt.nix
    # Git hook: prevent commits on default branch + enforce linked worktrees
    (taskModules.worktree-guard {})
    # OpenTelemetry observability stack (Collector + Tempo + Grafana)
    (import ./nix/devenv-modules/otel.nix { })
    # Playwright browser drivers and environment setup
    inputs.playwright.devenvModules.default
    # Shared task modules
    taskModules.genie
    # Use package-local tsc patched by effect-language-service (same pattern as vitest in test.nix)
    (taskModules.ts {
      tscBin = "packages/@overeng/utils/node_modules/.bin/tsc";
      lspPatchCmd = "packages/@overeng/utils/node_modules/.bin/effect-language-service patch --dir packages/@overeng/utils/node_modules/typescript";
      lspPatchDir = "packages/@overeng/utils/node_modules/typescript";
      # Depend only on utils package install (not full pnpm:install) for faster parallel startup
      lspPatchAfter = [ "pnpm:install:utils" ];
    })
    (taskModules.megarepo { })
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
    (taskModules.netlify {
      site = "overeng-utils";
      packages = packagesWithStorybook;
    })
    (taskModules.lint-oxc {
      jsPlugins = lib.optionals (oxlintNpm.pluginPath != null) [ oxlintNpm.pluginPath ];
      lintPaths = [
        "packages"
        "scripts"
        "context"
      ];
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
        # scripts
        "scripts/*.ts"
        "scripts/commands/**/*.ts"
        # context: specific safe paths
        "context/cli-design/*.ts"
        "context/effect/socket/*.genie.ts"
        "context/effect/socket/examples/*.ts"
        "context/opentui/*.genie.ts"
        # context: docs/config (safe; no node_modules under context/)
        "context/**/*.md"
        "context/**/*.json"
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
      optionalTasks = [
        "pnpm:install"
        "genie:run"
        "megarepo:sync"
        "ts:patch-lsp"
        "ts:emit"
      ];
      completionsCliNames = [
        "genie"
        "mr"
      ];
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
    pkgs.flock # Cross-process locking for setup tasks (see setup.nix)
    oxlintNpm
    pkgs.oxfmt
    (mkSourceCli {
      name = "genie";
      entry = "packages/@overeng/genie/bin/genie.tsx";
    })
    (mkSourceCli {
      name = "mr";
      entry = "packages/@overeng/megarepo/bin/mr.ts";
    })
    cliBuildStamp.package
  ];

  # Source-mode CLIs need pnpm install before running.
  # (The shared modules don't assume this — they work with Nix packages too.)
  tasks."genie:run".after = [ "pnpm:install:genie" ];
  tasks."genie:watch".after = [ "pnpm:install:genie" ];
  tasks."genie:check".after = [ "pnpm:install:genie" ];
  tasks."megarepo:sync".after = [ "pnpm:install:megarepo" ];

  tasks."gh:apply-settings" = {
    after = [ "genie:run" ];
    exec = ''
      set -euo pipefail
      ruleset_id=$(gh api repos/overengineeringstudio/effect-utils/rulesets --jq '.[0].id')
      gh api "repos/overengineeringstudio/effect-utils/rulesets/$ruleset_id" --method PUT --input .github/repo-settings.json
      echo "Applied repo-settings.json to ruleset $ruleset_id"
    '';
    description = "Apply .github/repo-settings.json to GitHub ruleset";
  };

  # Wire beads:daemon:ensure directly to shell entry (not via optionalTasks).
  # The setup module's gitHashStatus cache would prevent re-checking the daemon
  # after it stops without a new commit. The beads module's own status check
  # (is daemon running?) is the correct gate for this task.
  tasks."devenv:enterShell".after = lib.mkAfter [ "beads:daemon:ensure" ];

  # Keep git-hook installation out of the shell-entry path.
  # If needed, install with `devenv tasks run devenv:git-hooks:install`.
  # TODO(cachix/git-hooks.nix#688): remove this once the upstream git-hooks.nix issue
  # is fixed; currently this workaround prevents shell-entry failures with core.hooksPath.
  tasks."devenv:git-hooks:install".before = lib.mkForce [ ];

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
    # Can't use `dt` here — git hooks run outside the devenv shell where `dt` isn't on $PATH
    entry = "devenv tasks run check:quick --mode before";
    stages = [ "pre-commit" ];
    always_run = true;
    pass_filenames = false;
  };
}
