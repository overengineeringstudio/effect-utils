{ pkgs }:

{
  rustc,
  linker,
  targetTriple ? "x86_64-unknown-linux-musl",
}:

let
  contract = "effect-utils/rust-local-store-toolchain/v1";
  executionPlatform = "//buck2/platforms:exec_x86_64_linux_local_store";
  targetPlatform = "//buck2/platforms:target_x86_64_linux_musl_static";
  identityVerifier = pkgs.writeShellScript "buck2-rust-toolchain-identity-verify" ''
    set -euo pipefail
    [ "$#" -ge 3 ] || {
      echo "buck2-rust-toolchain-identity-verify: expected MATERIAL ID COMMAND..." >&2
      exit 64
    }
    material="$1"
    expected="$2"
    shift 2
    actual="sha256:$(printf '%s' "$material" | ${pkgs.coreutils}/bin/sha256sum | ${pkgs.gawk}/bin/awk '{ print $1 }')"
    [ "$actual" = "$expected" ] || {
      echo "buck2-rust-toolchain-identity-verify: toolchain identity digest mismatch" >&2
      exit 1
    }
    exec "$@"
  '';
  # This ordered material is both hashed by Nix and reassembled by Buck from
  # the supplied fields. A stale/mixed config cannot retain the old identity.
  identityMaterial = builtins.concatStringsSep ";" [
    "contract=${contract}"
    "execution_platform=${executionPlatform}"
    "identity_verifier=${identityVerifier}"
    "linker=${linker}"
    "rustc=${rustc}"
    "target_platform=${targetPlatform}"
    "target_triple=${targetTriple}"
  ];
  identity = builtins.hashString "sha256" identityMaterial;
in
{
  inherit identity;

  # One immutable file carries paths and semantic claims together. Buck still
  # enforces its configured target/execution constraints independently.
  config = pkgs.writeText "buck2-rust-local-toolchain.conf" ''
    [build]
      execution_platforms = ${executionPlatform}

    [rust_toolchain]
      contract = ${contract}
      execution_platform = ${executionPlatform}
      identity_verifier = ${identityVerifier}
      linker = ${linker}
      rustc = ${rustc}
      target_platform = ${targetPlatform}
      target_triple = ${targetTriple}
      toolchain_identity_material = ${identityMaterial}
      toolchain_identity = sha256:${identity}
  '';
}
