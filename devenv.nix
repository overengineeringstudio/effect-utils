{ pkgs, inputs, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
  pkgsStable = import inputs.nixpkgs { inherit system; };
  pkgsUnstable = import inputs.nixpkgsUnstable { inherit system; };
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
  mono = import ./scripts/nix/build.nix {
    pkgs = pkgsStable;
    inherit pkgsUnstable gitRev;
    src = workspaceSrc;
  };
  cliBuildStamp = import ./nix/cli-build-stamp.nix { inherit pkgs; };
  # Use npm oxlint with NAPI bindings to enable JavaScript plugin support
  oxlintNpm = import ./nix/oxlint-npm.nix {
    inherit pkgs;
    bun = pkgsUnstable.bun;
  };
in
{
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
