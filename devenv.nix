{ pkgs, lib, inputs, ... }:
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
in
{
  # Beads commit correlation for issue tracking
  imports = [
    (inputs.overeng-beads-public.devenvModules.beads {
      beadsPrefix = "oep";
      beadsRepoName = "overeng-beads-public";
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

  # Per-package bun install tasks for parallel execution with progress tracking
  tasks = let
    dirs = [
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

    # Convert path to task name: "packages/@overeng/foo" -> "foo", "context/opentui" -> "context-opentui"
    toName = path: builtins.replaceStrings ["/"] ["-"] (lib.last (lib.splitString "@overeng/" path));

    mkTask = path: {
      "bun:install:${toName path}" = {
        exec = "bun install";
        cwd = path;
        execIfModified = [ "${path}/package.json" "${path}/bun.lock" ];
        after = [ "genie:run" ];
      };
    };

  in lib.mkMerge (map mkTask dirs ++ [
    {
      "genie:run" = {
        exec = "genie";
        execIfModified = [ "**/*.genie.ts" ];
      };
      "bun:install" = {
        description = "Install all bun dependencies";
        after = map (p: "bun:install:${toName p}") dirs;
      };
    }
  ]);
}
