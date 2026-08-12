# Nix build for the otel-scrape Rust crate.
# Hermetic workspace-aware source remains stable across unrelated repo edits.
# cargoLock.lockFile vendors deps from the shared committed workspace lock.
#
# Build-id correlation (H5, decision 0019): the flake git rev is written as an
# adjacent NixStamp build-info file during packaging. Rust compilation stays
# independent of revision metadata while the installed product still derives
# `machineVersion` from the shared build-versioning contract. The shape matches
# the fleet's TS/Nix stamp
# (`@overeng/utils/node/cli-version` NixStamp: type/version/rev/commitTs/dirty);
# it is constructed inline via `builtins.toJSON` exactly like the notion-cli
# build, because the shared shell `cliBuildStamp` helper only produces LocalStamps.
{
  pkgs,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
}:
let
  lib = pkgs.lib;
  repositoryRoot = ../../../..;
  workspaceRoot = repositoryRoot + "/rust";
  crateRoot = ../.;
  mkRustWorkspaceSource = import ../../../../nix/workspace-tools/lib/mk-rust-workspace-source.nix {
    inherit lib;
  };
  # NixStamp JSON (same contract as @overeng/utils/node/cli-version NixStamp).
  # baseVersion pinned to the crate version below so machineVersion is
  # `0.0.0+<rev>` (and `+…-dirty` for a dirty tree).
  buildStamp = builtins.toJSON {
    type = "nix";
    version = "0.0.0";
    rev = gitRev;
    inherit commitTs dirty;
  };
  expectedMachineVersion = "0.0.0+${gitRev}${
    lib.optionalString (dirty && !(lib.hasSuffix "-dirty" gitRev)) "-dirty"
  }";
  src = mkRustWorkspaceSource {
    inherit repositoryRoot workspaceRoot;
    packageRoot = crateRoot;
    includeReadme = true;
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "otel-scrape";
  version = "0.0.0";
  inherit src;
  cargoRoot = "rust";
  buildAndTestSubdir = "rust";
  cargoLock.lockFile = workspaceRoot + "/Cargo.lock";
  cargoBuildFlags = [
    "--package"
    "otel-scrape"
  ];
  cargoTestFlags = [
    "--package"
    "otel-scrape"
  ];
  postInstall = ''
    printf '%s\n' ${lib.escapeShellArg buildStamp} > "$out/bin/otel-scrape.build-info.json"
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    actual="$($out/bin/otel-scrape --version)"
    expected=${lib.escapeShellArg "otel-scrape ${expectedMachineVersion}"}
    if [ "$actual" != "$expected" ]; then
      echo "installed build-info mismatch: expected '$expected', got '$actual'" >&2
      exit 1
    fi
    runHook postInstallCheck
  '';
  doCheck = true;
  nativeCheckInputs = [
    pkgs.nodejs
  ];
  meta = {
    description = "Process wrapper for command telemetry and profile artifact links";
    license = lib.licenses.mit;
    mainProgram = "otel-scrape";
  };
}
