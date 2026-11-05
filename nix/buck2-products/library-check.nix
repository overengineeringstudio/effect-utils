{
  pkgs,
  product,
  fixture,
}:
let
  source = product.buck2Product;
  realize = import ../workspace-tools/lib/buck2-artifact-realize.nix { inherit pkgs; };
in
pkgs.runCommand "buck2-installed-library-consumer"
  {
    nativeBuildInputs = [
      pkgs.rustc
      pkgs.stdenv.cc
    ];
    buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
      pkgs.apple-sdk
      pkgs.libiconv
    ];
    dontStrip = true;
    passthru.mismatch = realize {
      name = "content-address-core";
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
  }
  ''
    set -euo pipefail
    descriptor=${source}/descriptor.json
    ${pkgs.jq}/bin/jq -r '.library.artifacts[] | "\(.sha256)  ${product}/\(.path)"' "$descriptor" \
      | ${pkgs.coreutils}/bin/sha256sum --check
    ${pkgs.stdenv.cc.bintools}/bin/ar t ${product}/lib/libcontent_address_core.rlib \
      | ${pkgs.gnugrep}/bin/grep 'lib.rmeta'
    cat > consumer.rs <<'RS'
    fn main() {
        let digest = content_address_core::Digest([0; 32]);
        assert_eq!(digest.to_string().parse::<content_address_core::Digest>().unwrap(), digest);
    }
    RS
    rustc --edition=2024 consumer.rs \
      --extern content_address_core=${product}/lib/libcontent_address_core.rlib \
      -L dependency=${product}/lib -o consumer
    ./consumer
    cp ${../../buck2/tests/library_closure/consumer.rs} consumer.rs
    rustc --edition=2024 consumer.rs \
      --extern example_library=${fixture}/lib/libexample_library.rlib \
      -L dependency=${fixture}/lib -o consumer
    ./consumer
    echo 'PASS: installed library metadata, external consumer and proc-macro loading'
    touch "$out"
  ''
