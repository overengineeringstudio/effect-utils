{ pkgs, ... }:
{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    corepack.enable = true;
  };

  packages = [
    pkgs.nodejs_24
    pkgs.bun
  ];

  env = {
    COREPACK_INTEGRITY_KEYS = "0";
  };

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
  '';
}
