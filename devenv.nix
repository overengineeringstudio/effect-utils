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
      genieCoverageDirs = [ "packages" "scripts" "context" ];
      oxfmtExcludes = [
        "**/package.json"
        "**/tsconfig.json"
        "**/tsconfig.*.json"
        ".github/workflows/*.yml"
        "packages/@overeng/oxc-config/*.jsonc"
      ];
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
