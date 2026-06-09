# Nix build for the otelite Rust crate — effect-utils' first Rust package.
# Hermetic source via fileset.toSource (stable across unrelated repo edits);
# cargoLock.lockFile vendors deps from the committed Cargo.lock.
{ pkgs }:
let
  lib = pkgs.lib;
  crateRoot = ../.;
  src = lib.fileset.toSource {
    root = crateRoot;
    fileset = lib.fileset.unions [
      (crateRoot + "/Cargo.toml")
      (crateRoot + "/Cargo.lock")
      (crateRoot + "/rust-toolchain.toml")
      (lib.fileset.fileFilter (f: f.hasExt "rs") (crateRoot + "/src"))
      # Whole test tree (added in M4): integration `.rs` plus conformance
      # goldens/fixtures (`.json`/`.ndjson`/`.snap`). maybeMissing keeps this a
      # no-op until `tests/` exists, so `doCheck` finds fixtures, not a void.
      (lib.fileset.maybeMissing (crateRoot + "/tests"))
    ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "otelite";
  version = "0.0.0";
  inherit src;
  cargoLock.lockFile = crateRoot + "/Cargo.lock";
  doCheck = true;
  meta = {
    description = "Local OTLP capture tool for E2E and instrumentation tests";
    license = lib.licenses.mit;
    mainProgram = "otelite";
  };
}
