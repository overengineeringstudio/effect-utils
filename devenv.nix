{ pkgs, inputs, ... }:
let
  playwrightDriver = inputs.playwright-web-flake.packages.${pkgs.system}.playwright-driver;
  genie = inputs.genie.packages.${pkgs.system}.default;
in
{
  # Apply pnpm guard overlay from local pnpm-compose package (fetched via devenv.yaml with flake: false)
  # See pnpm-compose README for design rationale on this approach
  overlays = [
    (import "${inputs.pnpm-compose}/nix/overlay.nix")
  ];

  packages = [
    pkgs.pnpm
    pkgs.nodejs_24
    pkgs.bun
    genie
  ];

  env = {
    PLAYWRIGHT_BROWSERS_PATH = playwrightDriver.browsers;
  };

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/scripts/bin:$WORKSPACE_ROOT/node_modules/.bin:$PATH"
  '';
}
