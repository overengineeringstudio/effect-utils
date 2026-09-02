# Exact executor-local Rust/C++ tools for the three admitted native Buck pairs.
{
  pkgs,
  nixpkgsRevision,
}:

let
  lib = pkgs.lib;
  system = pkgs.stdenv.hostPlatform.system;
  targetTriple =
    {
      x86_64-linux = "x86_64-unknown-linux-gnu";
      aarch64-linux = "aarch64-unknown-linux-gnu";
      aarch64-darwin = "aarch64-apple-darwin";
    }
    .${system} or (throw "Buck Rust toolchains do not admit ${system}");
  darwinCapability =
    if pkgs.stdenv.hostPlatform.isDarwin then
      import ./buck2-darwin-rust-capability.nix {
        inherit pkgs nixpkgsRevision;
      }
    else
      null;
  upstreamPackages = {
    rust-compiler = if darwinCapability != null then darwinCapability.compiler else pkgs.rustc;
    rust-rustdoc = pkgs.rustc;
    rust-clippy-driver = pkgs.clippy;
    rust-c-compiler = pkgs.stdenv.cc;
    rust-cxx-compiler = pkgs.stdenv.cc;
    rust-linker = pkgs.stdenv.cc;
    rust-archiver = pkgs.stdenv.cc.bintools;
    rust-dwp = pkgs.stdenv.cc.bintools;
    rust-nm = pkgs.stdenv.cc.bintools;
    rust-objcopy = pkgs.stdenv.cc.bintools;
    rust-objdump = pkgs.stdenv.cc.bintools;
    rust-ranlib = pkgs.stdenv.cc.bintools;
    rust-strip = pkgs.stdenv.cc.bintools;
    rust-shell = pkgs.bash;
  };
  executableNames = {
    rust-compiler = "rustc";
    rust-rustdoc = "rustdoc";
    rust-clippy-driver = "clippy-driver";
    rust-c-compiler = "cc";
    rust-cxx-compiler = "c++";
    rust-linker = "c++";
    rust-archiver = "ar";
    rust-dwp = "dwp";
    rust-nm = "nm";
    rust-objcopy = "objcopy";
    rust-objdump = "objdump";
    rust-ranlib = "ranlib";
    rust-strip = "strip";
    rust-shell = "bash";
  };
  packages = lib.mapAttrs (
    name: package:
    pkgs.writeShellScriptBin executableNames.${name} ''
      exec ${lib.escapeShellArg "${package}/bin/${executableNames.${name}}"} "$@"
    ''
  ) upstreamPackages;
  tools = lib.mapAttrs (name: package: "${package}/bin/${executableNames.${name}}") packages;
  identity = lib.concatStringsSep ";" (
    [
      "contract=effect-utils/buck2-rust-toolchain/v1"
      "nixpkgs=${nixpkgsRevision}"
      "system=${system}"
      "target_triple=${targetTriple}"
    ]
    ++ lib.mapAttrsToList (name: executable: "${name}=${executable}") tools
  );
  preflight = pkgs.writeShellScript "buck2-rust-toolchain-preflight" ''
    set -euo pipefail
    ${lib.optionalString (darwinCapability != null) ''
      ${darwinCapability.preflight} >/dev/null
    ''}
    ${lib.concatMapStringsSep "\n" (executable: ''
      [ -x ${lib.escapeShellArg executable} ] || {
        echo "buck2-rust-toolchain-preflight: missing Nix tool: ${executable}" >&2
        exit 1
      }
    '') (builtins.attrValues tools)}
    printf '%s\n' ${lib.escapeShellArg identity}
  '';
in
assert lib.assertMsg (
  builtins.isString nixpkgsRevision && builtins.match "[0-9a-f]{40}" nixpkgsRevision != null
) "buck2-rust-toolchain-capability requires the exact 40-character nixpkgs revision";
{
  inherit
    executableNames
    identity
    packages
    preflight
    targetTriple
    tools
    ;
}
