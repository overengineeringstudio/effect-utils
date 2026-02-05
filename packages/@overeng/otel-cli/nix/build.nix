# Nix derivation that builds otel CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, src, gitRev ? "unknown", commitTs ? 0, dirty ? false }:

let
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs; };
in
mkPnpmCli {
  name = "otel";
  entry = "packages/@overeng/otel-cli/bin/otel.ts";
  binaryName = "otel";
  packageDir = "packages/@overeng/otel-cli";
  workspaceRoot = src;
  extraExcludedSourceNames = [ "context" "scripts" ];
  # Placeholder hashes — run `dt nix:hash` to compute real values
  # after first successful local build.
  pnpmDepsHash = pkgs.lib.fakeHash;
  lockfileHash = pkgs.lib.fakeHash;
  packageJsonDepsHash = pkgs.lib.fakeHash;
  inherit gitRev commitTs dirty;
}
