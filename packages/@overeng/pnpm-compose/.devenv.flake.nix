# devenv looks for this file instead of flake.nix (devenv#1137)
{
  description = "pnpm-compose CLI for multi-repo pnpm workspace management";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-25.11";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, nixpkgsUnstable, flake-utils, ... }:
    let
      pnpmGuardOverlay = import ./nix/overlay.nix;
    in
    {
      overlays.default = pnpmGuardOverlay;
      overlays.pnpmGuard = pnpmGuardOverlay;
    } //
    flake-utils.lib.eachDefaultSystem (system:
      let
        gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
      in
      {
        packages.default = import ./nix/build.nix {
          pkgs = import nixpkgs { inherit system; };
          pkgsUnstable = import nixpkgsUnstable { inherit system; };
          src = ../../..;
          inherit gitRev;
        };
      });
}
