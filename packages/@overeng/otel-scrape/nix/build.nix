# Nix build for the otel-scrape Rust crate.
# Hermetic source via fileset.toSource (stable across unrelated repo edits);
# cargoLock.lockFile vendors deps from the committed Cargo.lock.
#
# Build-id correlation (H5, decision 0019): the flake git rev is injected as a
# NixStamp `CLI_BUILD_STAMP` env var so the binary reflects its build without
# breaking purity (the rev is a flake input, not an impure read). Rust reads it
# at compile time via `option_env!` and derives `machineVersion` per the shared
# build-versioning contract. The shape matches the fleet's TS/Nix stamp
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
  crateRoot = ../.;
  # NixStamp JSON (same contract as @overeng/utils/node/cli-version NixStamp).
  # baseVersion pinned to the crate version below so machineVersion is
  # `0.0.0+<rev>` (and `+…-dirty` for a dirty tree).
  buildStamp = builtins.toJSON {
    type = "nix";
    version = "0.0.0";
    rev = gitRev;
    inherit commitTs dirty;
  };
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
  # Reaches rustc as a plain env var; `option_env!("CLI_BUILD_STAMP")` captures
  # it at compile time (decision 0019). Because it is a derivation env var, a new
  # rev changes the derivation hash so Nix rebuilds the crate — the binary tracks
  # its build. (The cargo `rerun-if-env-changed` incremental path is not relied on;
  # each `nix build` is a fresh sandbox.)
  CLI_BUILD_STAMP = buildStamp;
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
