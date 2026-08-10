# Nix build for the otel-core Rust library crate.
# Hermetic source via fileset.toSource (stable across unrelated repo edits);
# cargoLock.lockFile vendors deps from the committed Cargo.lock.
#
# Plain `{ pkgs }` build (mirrors otelite, NOT the stamped otel-scrape build):
# otel-core is a registry-agnostic library with no build-id/machineVersion, so
# there is no NixStamp to inject.
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
      (lib.fileset.maybeMissing (crateRoot + "/tests"))
    ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "otel-core";
  version = "0.0.0";
  inherit src;
  cargoLock.lockFile = crateRoot + "/Cargo.lock";
  doCheck = true;
  meta = {
    description = "Registry-agnostic OpenTelemetry primitives: content-address CAS, W3C trace-context, hex/stable-hash";
    license = lib.licenses.mit;
  };
}
