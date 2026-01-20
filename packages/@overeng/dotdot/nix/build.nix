# Nix derivation that builds dotdot CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown", dirty ? false }:

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
  bunDepsHash = "sha256-+wPb5gjCklCuGb5hJkyjOOVlqIa41hmsYJ2BLY1GTkE=";
  dirty = dirty;
  inherit gitRev;
}
