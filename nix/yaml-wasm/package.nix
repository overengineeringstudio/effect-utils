{ nixpkgs }:

let
  # Build with a fixed system so the FOD has a single content hash / store path
  # regardless of the evaluating platform. Consumers on other systems will
  # resolve the same output via binary cache or remote builders.
  pkgs = import nixpkgs { system = "x86_64-linux"; };
in
pkgs.stdenv.mkDerivation {
  pname = "yaml.wasm";
  version = "0.1.0";
  src = ./src;

  nativeBuildInputs = with pkgs; [
    cargo
    rustc
    rustc.llvmPackages.lld
    binaryen
    cacert
  ];

  buildPhase = ''
    export CARGO_HOME=$TMPDIR/cargo
    cargo build --release -p nix-wasm-plugin-yaml --target wasm32-unknown-unknown --locked
  '';

  installPhase = ''
    wasm-opt -O3 --enable-bulk-memory -o $out \
      target/wasm32-unknown-unknown/release/nix_wasm_plugin_yaml.wasm
  '';

  # FOD: content-addressed, single store path across all systems.
  outputHashMode = "flat";
  outputHashAlgo = "sha256";
  outputHash = "sha256-6nL1Vd2toRwzXksmzM2LnAKxyCp8l0a52sz64QnOQ3A=";

  doCheck = false;
}
