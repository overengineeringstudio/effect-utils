# Nix build for the otel-scrape Rust crate.
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
      (crateRoot + "/README.md")
      (crateRoot + "/rust-toolchain.toml")
      (lib.fileset.fileFilter (f: f.hasExt "rs") (crateRoot + "/src"))
      (lib.fileset.maybeMissing (crateRoot + "/tests"))
    ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "otel-scrape";
  version = "0.0.0";
  inherit src;
  cargoLock.lockFile = crateRoot + "/Cargo.lock";
  doCheck = true;
  meta = {
    description = "Process wrapper for command telemetry and profile artifact links";
    license = lib.licenses.mit;
    mainProgram = "otel-scrape";
  };
}
