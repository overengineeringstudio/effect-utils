{ pkgs, inputs, lib, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
  pkgsStable = import inputs.nixpkgs { inherit system; };
  pkgsUnstable = import inputs.nixpkgsUnstable { inherit system; };
  # Build CLIs against the same nixpkgs set as the flake outputs.
  # Keep devenv outputs aligned with flake outputs so mono nix status is accurate.
  # TODO use proper git rev
  gitRev = "unknown";
  workspaceSrc = ./.;
  playwrightDriver = inputs.playwright-web-flake.packages.${system}.playwright-driver;
  # Import CLI builds from their canonical build.nix files to avoid duplicate hash definitions.
  genie = import (./. + "/packages/@overeng/genie/nix/build.nix") {
    pkgs = pkgsStable;
    inherit pkgsUnstable gitRev;
    src = workspaceSrc;
  };
  dotdot = import (./. + "/packages/@overeng/dotdot/nix/build.nix") {
    pkgs = pkgsStable;
    inherit pkgsUnstable gitRev;
    src = workspaceSrc;
  };
  # Keep devenv shells fast; dirty mono builds are opt-in via direnv helper.
  mono = import ./scripts/nix/build.nix {
    pkgs = pkgsStable;
    inherit pkgsUnstable gitRev;
    src = workspaceSrc;
    dirty = false;
  };
  cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
  # Use npm oxlint with NAPI bindings to enable JavaScript plugin support
  oxlintNpm = import ./nix/oxlint-npm.nix {
    inherit pkgs;
    bun = pkgsUnstable.bun;
  };

  # Shared task modules
  taskModules = {
    genie = ./nix/devenv-modules/tasks/genie.nix;
    ts = ./nix/devenv-modules/tasks/ts.nix;
    setup = import ./nix/devenv-modules/tasks/setup.nix;
    check = import ./nix/devenv-modules/tasks/check.nix;
    clean = import ./nix/devenv-modules/tasks/clean.nix;
    test = import ./nix/devenv-modules/tasks/test.nix;
    lint-oxc = import ./nix/devenv-modules/tasks/lint-oxc.nix;
    bun = import ./nix/devenv-modules/tasks/bun.nix;
  };

  # All packages that need bun install
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
    taskModules.ts
    (taskModules.check {})
    (taskModules.clean { extraDirs = []; })
    (taskModules.bun { packages = allPackages; })
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
        # packages: root level config files
        "packages/@overeng/*/*.ts"
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
      tasks = [ "bun:install" "genie:run" "ts:build" ];
    })
  ];

  packages = [
    pkgs.pnpm
    pkgsUnstable.nodejs_24
    pkgsUnstable.bun
    pkgsUnstable.typescript
    oxlintNpm
    pkgsUnstable.oxfmt
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
