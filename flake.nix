{
  # Nix flake for sharing helper libraries across repos.
  #
  # We already have a devenv-based setup for local development, but repos that
  # consume effect-utils as a flake input still need a flake entry point so they
  # can import Nix helpers (for example lib.mkCliPackages) with a stable API.
  # This keeps the build logic reusable without requiring devenv in the parent.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-25.11";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, nixpkgsUnstable, flake-utils, ... }:
    let
      gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
    in
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        pkgsUnstable = import nixpkgsUnstable { inherit system; };
        mkBunCli = import ./nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };
      in
      {
        packages = {
          genie = mkBunCli {
            name = "genie";
            entry = "packages/@overeng/genie/src/build/cli.ts";
            packageDir = "packages/@overeng/genie";
            workspaceRoot = self;
            typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
            bunDepsHash = "sha256-WLkR7X5stKcFbroEflzIvcWDhVWsHxsNtsZZEAnAjBo=";
            inherit gitRev;
          };
          dotdot = mkBunCli {
            name = "dotdot";
            entry = "packages/@overeng/dotdot/src/cli.ts";
            binaryName = "dotdot";
            packageDir = "packages/@overeng/dotdot";
            workspaceRoot = self;
            typecheckTsconfig = "packages/@overeng/dotdot/tsconfig.json";
            bunDepsHash = "sha256-0HfezPxkSbXI4+0sLjhZ4u44j7nIp/25zRXRXRxPaSM=";
            inherit gitRev;
          };
        };

        apps.update-bun-hashes = flake-utils.lib.mkApp {
          drv = import ./nix/update-bun-hashes.nix { inherit pkgs; };
        };
      }
    ) // {
      # Builder function for external repos to create their own Bun CLIs
      lib.mkBunCli = { pkgs, pkgsUnstable }:
        import ./nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };

      # Legacy API for backwards compatibility
      lib.mkCliPackages = {
        pkgs,
        pkgsUnstable,
        gitRev ? "unknown",
        workspaceRoot ? ./.,
      }:
        let
          mkBunCli = import ./nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };
          specs = {
            genie = {
              name = "genie";
              entry = "packages/@overeng/genie/src/build/cli.ts";
              packageDir = "packages/@overeng/genie";
              typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
              bunDepsHash = "sha256-WLkR7X5stKcFbroEflzIvcWDhVWsHxsNtsZZEAnAjBo=";
            };
            dotdot = {
              name = "dotdot";
              entry = "packages/@overeng/dotdot/src/cli.ts";
              binaryName = "dotdot";
              packageDir = "packages/@overeng/dotdot";
              typecheckTsconfig = "packages/@overeng/dotdot/tsconfig.json";
              bunDepsHash = "sha256-0HfezPxkSbXI4+0sLjhZ4u44j7nIp/25zRXRXRxPaSM=";
            };
          };
        in
        builtins.mapAttrs (_: spec: mkBunCli (spec // { inherit gitRev workspaceRoot; })) specs;
    };
}
