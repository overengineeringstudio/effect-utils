{ pkgs, inputs, ... }:
let
  playwrightDriver = inputs.playwright-web-flake.packages.${pkgs.system}.playwright-driver;
in
{
  packages = [
    pkgs.nodejs_24
    pkgs.bun
  ];

  env = {
    PLAYWRIGHT_BROWSERS_PATH = playwrightDriver.browsers;
  };

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/scripts/bin:$WORKSPACE_ROOT/node_modules/.bin:$PATH"
  '';
}
