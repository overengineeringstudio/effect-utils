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
            entry = "effect-utils/packages/@overeng/genie/src/build/cli.ts";
            packageJsonPath = "effect-utils/packages/@overeng/genie/package.json";
            typecheckTsconfig = "effect-utils/packages/@overeng/genie/tsconfig.json";
            sources = [
              { name = "effect-utils"; src = self; }
            ];
            installDirs = [
              "effect-utils/packages/@overeng/genie"
              "effect-utils/packages/@overeng/utils"
            ];
            bunDepsHash = "sha256-xtg5VBvc6BGMDoFI8LtrAv35fGay/f7UQfOp7X/X3cw=";
            inherit gitRev;
          };
          dotdot = mkBunCli {
            name = "dotdot";
            entry = "effect-utils/packages/@overeng/dotdot/src/cli.ts";
            binaryName = "dotdot";
            packageJsonPath = "effect-utils/packages/@overeng/dotdot/package.json";
            typecheckTsconfig = "effect-utils/packages/@overeng/dotdot/tsconfig.json";
            sources = [
              { name = "effect-utils"; src = self; }
            ];
            installDirs = [
              "effect-utils/packages/@overeng/dotdot"
              "effect-utils/packages/@overeng/utils"
            ];
            bunDepsHash = "sha256-VGMmRFaJPhXOEI4nAwGHHU+McNwkz7zXc2FUyIit58k=";
            inherit gitRev;
          };
        };

        apps.update-bun-hashes = flake-utils.lib.mkApp {
          drv = import ./nix/update-bun-hashes.nix { inherit pkgs; };
        };
      }
    ) // {
      # Builder function for external repos to create their own Bun CLIs
      lib.mkBunCli = { pkgs, pkgsUnstable, src ? null }:
        import ./nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable src; };

      # Legacy API for backwards compatibility
      lib.mkCliPackages = {
        pkgs,
        pkgsUnstable,
        gitRev ? "unknown",
        src ? ./.,
      }:
        let
          srcPath = src;
          mkBunCli = import ./nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable; src = srcPath; };
          specs = {
            genie = {
              name = "genie";
              entry = "effect-utils/packages/@overeng/genie/src/cli.ts";
              packageJsonPath = "effect-utils/packages/@overeng/genie/package.json";
              typecheckTsconfig = "effect-utils/packages/@overeng/genie/tsconfig.json";
              bunDepsHash = "sha256-JtxYAEufsrrbYZA5OdZzaWRpgvawnOMwmht+98DDHSQ=";
              sources = [
                { name = "effect-utils"; src = srcPath; }
              ];
              installDirs = [
                "effect-utils/packages/@overeng/genie"
                "effect-utils/packages/@overeng/utils"
              ];
            };
            dotdot = {
              name = "dotdot";
              entry = "effect-utils/packages/@overeng/dotdot/src/cli.ts";
              binaryName = "dotdot";
              packageJsonPath = "effect-utils/packages/@overeng/dotdot/package.json";
              typecheckTsconfig = "effect-utils/packages/@overeng/dotdot/tsconfig.json";
              bunDepsHash = "sha256-VGMmRFaJPhXOEI4nAwGHHU+McNwkz7zXc2FUyIit58k=";
              sources = [
                { name = "effect-utils"; src = srcPath; }
              ];
              installDirs = [
                "effect-utils/packages/@overeng/dotdot"
                "effect-utils/packages/@overeng/utils"
              ];
            };
          };
        in
        builtins.mapAttrs (_: spec: mkBunCli (spec // { inherit gitRev; })) specs;
    };
}
