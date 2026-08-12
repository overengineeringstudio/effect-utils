# Nix build for the otelite Rust crate — effect-utils' first Rust package.
# Hermetic workspace-aware source remains stable across unrelated repo edits.
# cargoLock.lockFile vendors deps from the shared committed workspace lock.
{ pkgs }:
let
  lib = pkgs.lib;
  repositoryRoot = ../../../..;
  workspaceRoot = repositoryRoot + "/rust";
  crateRoot = ../.;
  mkRustWorkspaceSource = import ../../../../nix/workspace-tools/lib/mk-rust-workspace-source.nix {
    inherit lib;
  };
  src = mkRustWorkspaceSource {
    inherit repositoryRoot workspaceRoot;
    packageRoot = crateRoot;
    # The whole test tree contains integration sources plus conformance
    # goldens/fixtures (`.json`/`.ndjson`/`.snap`).
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "otelite";
  version = "0.0.0";
  inherit src;
  cargoRoot = "rust";
  buildAndTestSubdir = "rust";
  cargoLock.lockFile = workspaceRoot + "/Cargo.lock";
  cargoBuildFlags = [
    "--package"
    "otelite"
  ];
  cargoTestFlags = [
    "--package"
    "otelite"
  ];
  doCheck = true;
  meta = {
    description = "Local OTLP capture tool for E2E and instrumentation tests";
    license = lib.licenses.mit;
    mainProgram = "otelite";
  };
}
