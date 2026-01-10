# Nix derivation that builds pnpm-compose CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown" }:

let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable src; };
in
mkBunCli {
  name = "pnpm-compose";
  entry = "packages/@overeng/pnpm-compose/src/cli.ts";
  binaryName = "pnpm-compose";
  packageJsonPath = "packages/@overeng/pnpm-compose/package.json";
  typecheckTsconfig = "packages/@overeng/pnpm-compose/tsconfig.json";
  bunDepsHash = "sha256-QoYHZF4cUW57wGPes0QXDNP8t8yge0jDB5inphfj0SA=";
  inherit gitRev;
}
