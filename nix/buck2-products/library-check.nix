{ pkgs, product }:
let
  source = product.buck2Product;
  realize = import ../workspace-tools/lib/buck2-artifact-realize.nix { inherit pkgs; };
in
pkgs.runCommand "buck2-installed-library-consumer" {
  nativeBuildInputs = [ pkgs.stdenv.cc ];
  dontStrip = true;
  passthru.mismatch = realize {
    name = "example-library";
    runtimeKind = "library";
    expectedPlatform = {
      os = if pkgs.stdenv.hostPlatform.isDarwin then "darwin" else "linux";
      architecture = pkgs.stdenv.hostPlatform.parsed.cpu.name;
      abi = if pkgs.stdenv.hostPlatform.isDarwin then "darwin" else pkgs.stdenv.hostPlatform.libc;
    };
    expectedPanicStrategy = "abort";
    descriptorPath = "${source}/descriptor.json";
    archivePath = "${source}/artifact.tar";
  };
} ''
  set -euo pipefail
  descriptor=${source}/descriptor.json
  ${pkgs.jq}/bin/jq -r '.library.artifacts[] | "\(.sha256)  ${product}/\(.path)"' "$descriptor" \
    | ${pkgs.coreutils}/bin/sha256sum --check
  ${pkgs.stdenv.cc.bintools}/bin/ar t ${product}/lib/libexample_library.rlib \
    | ${pkgs.gnugrep}/bin/grep 'lib.rmeta'
  ${product.rustc}/bin/rustc --edition=2024 \
    ${../../buck2/tests/library_closure/consumer.rs} \
    --extern example_library=${product}/lib/libexample_library.rlib \
    -L dependency=${product}/lib -o consumer
  ./consumer
  echo 'PASS: installed library metadata, external consumer and proc-macro loading'
  touch "$out"
''
