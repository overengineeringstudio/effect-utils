# Exact executor-local native and wasm Rust tools for the admitted Buck hosts.
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
  wasmTargetTriple = "wasm32-unknown-unknown";
  wasmBindgenVersion = "0.2.127";
  wasmOptVersion = "132";
  # nixpkgs' native rustc includes wasm std. A cross stdenv would instead try
  # to build a compiler executing on wasm, and Darwin's native product wrapper
  # injects Apple linker flags that must never reach a wasm link.
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
    rust-wasm-compiler = pkgs.rustc;
    rust-wasm-rustdoc = pkgs.rustc;
    rust-wasm-linker = pkgs.llvmPackages.lld;
    wasm-bindgen = pkgs.wasm-bindgen-cli;
    wasm-opt = pkgs.binaryen;
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
    rust-wasm-compiler = "rustc";
    rust-wasm-rustdoc = "rustdoc";
    rust-wasm-linker = "wasm-ld";
    wasm-bindgen = "wasm-bindgen";
    wasm-opt = "wasm-opt";
  };
  packages = lib.mapAttrs (
    name: package:
    # cargo_build_script uses this executable directly as a #! interpreter.
    # Darwin's kernel cannot interpret a script whose interpreter is another script.
    if name == "rust-shell" then
      package
    else
      pkgs.writeShellScriptBin executableNames.${name} ''
        ${lib.optionalString (name == "rust-linker" && pkgs.stdenv.hostPlatform.isLinux) ''
          export NIX_DONT_SET_RPATH=1
          export NIX_LDFLAGS=
        ''}
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
      "wasm_target_triple=${wasmTargetTriple}"
      "wasm_bindgen_version=${wasmBindgenVersion}"
      "wasm_opt_version=${wasmOptVersion}"
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
    sysroot="$(${lib.escapeShellArg tools.rust-wasm-compiler} --print sysroot)"
    [ -d "$sysroot/lib/rustlib/${wasmTargetTriple}/lib" ] || {
      echo "buck2-rust-toolchain-preflight: missing ${wasmTargetTriple} std" >&2
      exit 1
    }
    [ "$(${lib.escapeShellArg tools.wasm-bindgen} --version)" = "wasm-bindgen ${wasmBindgenVersion}" ]
    [ "$(${lib.escapeShellArg tools.wasm-opt} --version)" = "wasm-opt version ${wasmOptVersion}" ]
    printf '%s\n' ${lib.escapeShellArg identity}
  '';
in
assert lib.assertMsg (
  builtins.isString nixpkgsRevision && builtins.match "[0-9a-f]{40}" nixpkgsRevision != null
) "buck2-rust-toolchain-capability requires the exact 40-character nixpkgs revision";
assert lib.assertMsg (
  pkgs.wasm-bindgen-cli.version == wasmBindgenVersion
) "Buck wasm-bindgen CLI must exactly match the Cargo wasm-bindgen ${wasmBindgenVersion} pin";
assert lib.assertMsg (
  pkgs.binaryen.version == wasmOptVersion
) "Buck wasm-opt flags are admitted for Binaryen ${wasmOptVersion}";
{
  inherit
    executableNames
    identity
    packages
    preflight
    targetTriple
    tools
    wasmTargetTriple
    wasmBindgenVersion
    wasmOptVersion
    ;
}
