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
  # Skip smoke test — otel CLI requires OTEL_EXPORTER_OTLP_ENDPOINT at startup
  smokeTestArgs = [];
  # Managed by `dt nix:hash:otel-cli` — do not edit manually.
  pnpmDepsHash = "sha256-ZxH/bKKzlAqSQb+0FC+LPUlqUDngn5WZ5WCCumeLCKg=";
  lockfileHash = "sha256-xdr+vkueeTjl00ENADLXXfjKuf3/vFm57wDY9NnCS5A=";
  packageJsonDepsHash = "sha256-EKqAx1VuDdi8BOR+eq+fxCKehKj2SnqB4bXyJSPVuEs=";
  inherit gitRev commitTs dirty;
}
