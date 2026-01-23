{ pkgs, inputs, ... }:
let
  mkBunCli = inputs.effect-utils.lib.mkBunCli { inherit pkgs; };

  appCli = mkBunCli {
    name = "app-cli";
    entry = "src/cli.ts";
    packageDir = ".";
    workspaceRoot = ./.;
    bunDepsHash = "sha256-bgayVjxWMiacjo3XyHT663lCj2rLcUvinkbD5nbo9r0=";
    typecheck = false;
  };
in
{
  packages = [
    pkgs.bun
    pkgs.nodejs_24
    appCli
  ];

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
  '';
}
