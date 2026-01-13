{ pkgs, inputs, ... }:
let
  playwrightDriver = inputs.playwright-web-flake.packages.${pkgs.stdenv.hostPlatform.system}.playwright-driver;
  genie = inputs.genie.packages.${pkgs.stdenv.hostPlatform.system}.default;
  dotdot = inputs.dotdot.packages.${pkgs.stdenv.hostPlatform.system}.default;
  cliBuildStamp = import ./nix/cli-build-stamp.nix { inherit pkgs; };
in
{
  packages = [
    pkgs.pnpm
    pkgs.nodejs_24
    pkgs.bun
    pkgs.oxlint
    pkgs.oxfmt
    genie
    dotdot
    cliBuildStamp.package
  ];

  env = {
    PLAYWRIGHT_BROWSERS_PATH = playwrightDriver.browsers;
  };

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/scripts/bin:$WORKSPACE_ROOT/node_modules/.bin:$PATH"
    ${cliBuildStamp.shellHook}
  '';
}
