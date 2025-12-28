# Workaround for devenv-nix bug with Determinate Nix
# See: https://github.com/cachix/devenv/issues/2364
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        corepack = pkgs.runCommand "corepack-enable" { } ''
          mkdir -p $out/bin
          ${pkgs.nodejs_24}/bin/corepack enable --install-directory $out/bin
        '';
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs_24
            corepack
            pkgs.bun
          ];

          env = {
            COREPACK_INTEGRITY_KEYS = "0";
          };

          shellHook = ''
            export WORKSPACE_ROOT="$PWD"
            export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
          '';
        };
      });
}
