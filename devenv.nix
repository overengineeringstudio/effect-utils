{ pkgs, inputs, ... }:
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
  imports = [
    # Beads commit correlation for issue tracking
    (inputs.overeng-beads-public.devenvModules.beads {
      beadsPrefix = "oep";
      beadsRepoName = "overeng-beads-public";
    })
    # Tasks
    ./nix/devenv/tasks/bun.nix
    ./nix/devenv/tasks/genie.nix
    ./nix/devenv/tasks/lint.nix
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
