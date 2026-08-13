{ pkgs }:

{
  rustc,
  rustdoc ? "${builtins.dirOf (builtins.dirOf rustc)}/bin/rustdoc",
  clippyDriver ? "${builtins.dirOf (builtins.dirOf rustc)}/bin/clippy-driver",
  linker,
  cc ? linker,
  cxx ? linker,
  binutils,
  ar ? "${binutils}/bin/ar",
  dwp ? "${binutils}/bin/dwp",
  nm ? "${binutils}/bin/nm",
  objcopy ? "${binutils}/bin/objcopy",
  objdump ? "${binutils}/bin/objdump",
  ranlib ? "${binutils}/bin/ranlib",
  strip ? "${binutils}/bin/strip",
  python,
  toolPath,
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
    if [ "''${1-}" = "--stamp" ]; then
      [ "$#" -eq 2 ] || {
        echo "buck2-rust-toolchain-identity-verify: expected --stamp OUTPUT" >&2
        exit 64
      }
      printf '%s\n' "$expected" > "$2"
      exit 0
    fi
    exec "$@"
  '';
  # Complete material detects a stale or spliced config. It is deliberately
  # not an action key: actions use the narrow semantic material below.
  configIntegrityMaterial = builtins.concatStringsSep ";" [
    "ar=${ar}"
    "cc=${cc}"
    "clippy_driver=${clippyDriver}"
    "contract=${contract}"
    "cxx=${cxx}"
    "dwp=${dwp}"
    "execution_platform=${executionPlatform}"
    "identity_verifier=${identityVerifier}"
    "linker=${linker}"
    "nm=${nm}"
    "objcopy=${objcopy}"
    "objdump=${objdump}"
    "python=${python}"
    "ranlib=${ranlib}"
    "rustc=${rustc}"
    "rustdoc=${rustdoc}"
    "strip=${strip}"
    "target_platform=${targetPlatform}"
    "target_triple=${targetTriple}"
    "tool_path=${toolPath}"
  ];
  configIntegrityIdentity = builtins.hashString "sha256" configIntegrityMaterial;

  # Prelude Rust compilation receives these exact paths or claims. Product
  # provenance uses this identity, so lint/docs/Python/unused binutils changes
  # do not invalidate compile or packaging.
  compileMaterial = builtins.concatStringsSep ";" [
    "ar=${ar}"
    "cc=${cc}"
    "contract=${contract}"
    "cxx=${cxx}"
    "execution_platform=${executionPlatform}"
    "linker=${linker}"
    "rustc=${rustc}"
    "target_platform=${targetPlatform}"
    "target_triple=${targetTriple}"
    "tool_path=${toolPath}"
  ];
  compileIdentity = builtins.hashString "sha256" compileMaterial;
in
{
  inherit
    compileIdentity
    compileMaterial
    configIntegrityIdentity
    configIntegrityMaterial
    ;

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
      cc = ${cc}
      cxx = ${cxx}
      ar = ${ar}
      dwp = ${dwp}
      nm = ${nm}
      objcopy = ${objcopy}
      objdump = ${objdump}
      ranlib = ${ranlib}
      strip = ${strip}
      python = ${python}
      tool_path = ${toolPath}
      rustc = ${rustc}
      rustdoc = ${rustdoc}
      clippy_driver = ${clippyDriver}
      target_platform = ${targetPlatform}
      target_triple = ${targetTriple}
      config_integrity_material = ${configIntegrityMaterial}
      config_integrity_identity = sha256:${configIntegrityIdentity}
      compile_identity_material = ${compileMaterial}
      compile_identity = sha256:${compileIdentity}
  '';
}
