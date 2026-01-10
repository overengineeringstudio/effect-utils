{
  # Nix flake for sharing helper libraries across repos.
  #
  # We already have a devenv-based setup for local development, but repos that
  # consume effect-utils as a submodule still need a flake entry point so they
  # can import Nix helpers (for example lib.mkCliPackages) with a stable API.
  # This keeps the build logic reusable without requiring devenv in the parent.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-25.11";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, nixpkgsUnstable, flake-utils, ... }:
    {
      lib.mkCliPackages = {
        pkgs,
        pkgsUnstable,
        gitRev ? self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown",
        src ? ./.,
      }:
        let
          srcPath = src;
          mkBunCli = import ./nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable; src = srcPath; };
          specs = {
            genie = {
              name = "genie";
              entry = "packages/@overeng/genie/src/cli.ts";
              packageJsonPath = "packages/@overeng/genie/package.json";
              typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
              bunDepsHash = "sha256-QoYHZF4cUW57wGPes0QXDNP8t8yge0jDB5inphfj0SA=";
            };
            pnpm-compose = {
              name = "pnpm-compose";
              entry = "packages/@overeng/pnpm-compose/src/cli.ts";
              packageJsonPath = "packages/@overeng/pnpm-compose/package.json";
              typecheckTsconfig = "packages/@overeng/pnpm-compose/tsconfig.json";
              bunDepsHash = "sha256-QoYHZF4cUW57wGPes0QXDNP8t8yge0jDB5inphfj0SA=";
            };
          };
        in
        builtins.mapAttrs (_: spec: mkBunCli (spec // { inherit gitRev; })) specs;
    };
}
