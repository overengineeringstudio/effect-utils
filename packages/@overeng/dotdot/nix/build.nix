# Nix derivation that builds dotdot CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown" }:

let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };
in
mkBunCli {
  name = "dotdot";
  entry = "packages/@overeng/dotdot/src/cli.ts";
  binaryName = "dotdot";
  packageDir = "packages/@overeng/dotdot";
  workspaceRoot = src;
  # TODO: Re-enable once Effect language service messages don't cause tsc to exit non-zero
  typecheck = false;
  bunDepsHash = "sha256-GLlXkSQIMHf+1SMK418D4h8rYB2D5N3fLVq/GcPsMwo=";
  inherit gitRev;
}
