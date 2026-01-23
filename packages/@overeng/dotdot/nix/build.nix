# Nix derivation that builds dotdot CLI binary.
# Uses bun build --compile for native platform.
# TODO: Remove pkgsUnstable param once mk-bun-cli.nix is updated to use single pkgs
{ pkgs, pkgsUnstable ? pkgs, src, gitRev ? "unknown", dirty ? false }:

let
  mkBunCli = import ../../../../nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };
in
mkBunCli {
  name = "dotdot";
  entry = "packages/@overeng/dotdot/src/cli.ts";
  binaryName = "dotdot";
  packageDir = "packages/@overeng/dotdot";
  workspaceRoot = src;
  extraExcludedSourceNames = [ "context" "scripts" ];
  typecheckTsconfig = "packages/@overeng/dotdot/tsconfig.json";
  smokeTestCwd = "workspace";
  smokeTestSetup = ''
    printf '%s\n' '{"repos":{}}' > "$smoke_test_cwd/dotdot-root.json"
  '';
  bunDepsHash = "sha256-+iA+T/MzyNdBV+IDuqYAvDeQxX/XcumFcC5bj0J+JYg=";
  dirty = dirty;
  inherit gitRev;
}
