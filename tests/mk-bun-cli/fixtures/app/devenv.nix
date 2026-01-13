{ pkgs, inputs, ... }:
let
  pkgsUnstable = pkgs;
  mkBunCli = import "${inputs.effect-utils}/nix/mk-bun-cli.nix" { inherit pkgs pkgsUnstable; };

  appCli = mkBunCli {
    name = "app-cli";
    entry = "app/src/cli.ts";
    packageDir = "app";
    workspaceRoot = inputs.workspace;
    bunDepsHash = pkgs.lib.fakeHash;
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
