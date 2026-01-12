# Nix derivation that builds bun-compose CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown" }:

let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable src; };
in
mkBunCli {
  name = "bun-compose";
  entry = "effect-utils/packages/@overeng/bun-compose/src/cli.ts";
  binaryName = "bun-compose";
  packageJsonPath = "effect-utils/packages/@overeng/bun-compose/package.json";
  typecheckTsconfig = "effect-utils/packages/@overeng/bun-compose/tsconfig.json";
  sources = [
    { name = "effect-utils"; src = src; }
  ];
  installDirs = [
    "effect-utils/packages/@overeng/bun-compose"
    "effect-utils/packages/@overeng/utils"
  ];
  bunDepsHash = "sha256-QN7v+jta6MyYNmpv+RV9hEsCldnKKpoEzcz3PP14ebg=";
  inherit gitRev;
}
