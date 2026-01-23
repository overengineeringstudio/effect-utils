{ pkgs, inputs, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
  # Build CLIs against the same nixpkgs set as the flake outputs.
  # Keep devenv outputs aligned with flake outputs so mono nix status is accurate.
  # TODO use proper git rev
  gitRev = "unknown";
  workspaceSrc = ./.;
  playwrightDriver = inputs.playwright-web-flake.packages.${system}.playwright-driver;
  # Import CLI builds from their canonical build.nix files to avoid duplicate hash definitions.
  genie = import (./. + "/packages/@overeng/genie/nix/build.nix") {
    inherit pkgs gitRev;
    src = workspaceSrc;
  };
  dotdot = import (./. + "/packages/@overeng/dotdot/nix/build.nix") {
    inherit pkgs gitRev;
    src = workspaceSrc;
  };
  # Keep devenv shells fast; dirty mono builds are opt-in via direnv helper.
  mono = import ./scripts/nix/build.nix {
    inherit pkgs gitRev;
    src = workspaceSrc;
    dirty = false;
  };
  cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
  # Use npm oxlint with NAPI bindings to enable JavaScript plugin support
  oxlintNpm = import ./nix/oxlint-npm.nix {
    inherit pkgs;
    bun = pkgs.bun;
  };

  # Shared task modules
  taskModules = {
    genie = ./nix/devenv-modules/tasks/genie.nix;
    ts = import ./nix/devenv-modules/tasks/ts.nix;
    setup = import ./nix/devenv-modules/tasks/setup.nix;
    check = import ./nix/devenv-modules/tasks/check.nix;
    clean = import ./nix/devenv-modules/tasks/clean.nix;
    test = import ./nix/devenv-modules/tasks/test.nix;
    lint-oxc = import ./nix/devenv-modules/tasks/lint-oxc.nix;
    bun = import ./nix/devenv-modules/tasks/bun.nix;
    pnpm = import ./nix/devenv-modules/tasks/pnpm.nix;
    nix-cli = import ./nix/devenv-modules/tasks/nix-cli.nix;
  };

  # CLI packages built with Nix (for hash management)
  nixCliPackages = [
    { name = "genie"; flakeRef = ".#genie"; buildNix = "packages/@overeng/genie/nix/build.nix"; }
    { name = "dotdot"; flakeRef = ".#dotdot"; buildNix = "packages/@overeng/dotdot/nix/build.nix"; }
    { name = "mono"; flakeRef = ".#mono"; buildNix = "scripts/nix/build.nix"; }
  ];

  # All packages for per-package install tasks
  # NOTE: Using pnpm temporarily due to bun bugs. Plan to switch back once fixed.
  # See: context/workarounds/bun-issues.md
  allPackages = [
    "packages/@overeng/cli-ui"
    "packages/@overeng/dotdot"
    "packages/@overeng/effect-ai-claude-cli"
    "packages/@overeng/effect-path"
    "packages/@overeng/effect-react"
    "packages/@overeng/effect-rpc-tanstack"
    "packages/@overeng/effect-rpc-tanstack/examples/basic"
    "packages/@overeng/effect-schema-form"
    "packages/@overeng/effect-schema-form-aria"
    "packages/@overeng/genie"
    "packages/@overeng/megarepo"
    "packages/@overeng/mono"
    "packages/@overeng/notion-cli"
    "packages/@overeng/notion-effect-client"
    "packages/@overeng/notion-effect-schema"
    "packages/@overeng/oxc-config"
    "packages/@overeng/react-inspector"
    "packages/@overeng/utils"
    "scripts"
    "context/opentui"
    "context/effect/socket"
  ];

  # Packages that have vitest tests (subset of allPackages)
  packagesWithTests = [
    { path = "packages/@overeng/dotdot"; name = "dotdot"; }
    { path = "packages/@overeng/effect-ai-claude-cli"; name = "effect-ai-claude-cli"; }
    { path = "packages/@overeng/effect-path"; name = "effect-path"; }
    { path = "packages/@overeng/effect-rpc-tanstack"; name = "effect-rpc-tanstack"; }
    { path = "packages/@overeng/genie"; name = "genie"; }
    { path = "packages/@overeng/megarepo"; name = "megarepo"; }
    { path = "packages/@overeng/mono"; name = "mono"; }
    { path = "packages/@overeng/notion-cli"; name = "notion-cli"; }
    { path = "packages/@overeng/notion-effect-client"; name = "notion-effect-client"; }
    { path = "packages/@overeng/notion-effect-schema"; name = "notion-effect-schema"; }
    { path = "packages/@overeng/oxc-config"; name = "oxc-config"; }
    { path = "packages/@overeng/utils"; name = "utils"; }
  ];
in
{
  imports = [
    # Beads commit correlation for issue tracking
    (inputs.overeng-beads-public.devenvModules.beads {
      beadsPrefix = "oep";
      beadsRepoName = "overeng-beads-public";
    })
    # `dt` (devenv tasks) wrapper script and shell completions
    ./nix/devenv-modules/dt.nix
    # Shared task modules
    taskModules.genie
    (taskModules.ts {})
    (taskModules.check {})
    (taskModules.clean { packages = allPackages; })
    # Per-package pnpm install tasks
    # NOTE: Using pnpm temporarily. See: context/workarounds/bun-issues.md
    (taskModules.pnpm { packages = allPackages; })
    (taskModules.test {
      packages = packagesWithTests;
      vitestBin = "packages/@overeng/utils/node_modules/.bin/vitest";
      vitestConfig = "packages/@overeng/utils/vitest.config.ts";
    })
    (taskModules.lint-oxc {
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
        # packages: bin, .storybook, stress-test directories
        "packages/@overeng/*/bin/*.ts"
        "packages/@overeng/*/.storybook/*.ts"
        "packages/@overeng/*/.storybook/*.tsx"
        "packages/@overeng/*/stress-test/**/*.ts"
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
        # linter config files (changes should trigger lint)
        "oxfmt.json"
        "oxlint.json"
      ];
      # Genie file patterns for caching genie:check tasks
      geniePatterns = [
        "packages/@overeng/*/*.genie.ts"
        "packages/@overeng/*/examples/*/*.genie.ts"
        "scripts/*.genie.ts"
        "context/effect/socket/*.genie.ts"
        "context/opentui/*.genie.ts"
      ];
      genieCoverageDirs = [ "packages" "scripts" ];
      oxfmtExcludes = [
        "**/package.json"
        "**/tsconfig.json"
        "**/tsconfig.*.json"
        ".github/workflows/*.yml"
        "packages/@overeng/oxc-config/*.jsonc"
      ];
    })
    # Setup task (auto-runs in enterShell)
    (taskModules.setup {
      tasks = [ "pnpm:install" "genie:run" "ts:build" ];
    })
    # Nix CLI build and hash management
    (taskModules.nix-cli { cliPackages = nixCliPackages; })
  ];

  packages = [
    pkgs.pnpm
    pkgs.nodejs_24
    pkgs.bun
    pkgs.typescript
    oxlintNpm
    pkgs.oxfmt
    genie
    dotdot
    mono
    cliBuildStamp.package
  ];

  env = {
    PLAYWRIGHT_BROWSERS_PATH = playwrightDriver.browsers;
  };

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
    ${cliBuildStamp.shellHook}
  '';
}
