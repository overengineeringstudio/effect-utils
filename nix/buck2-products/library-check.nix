{ pkgs, product }:
let
  source = product.buck2Product;
  realize = import ../workspace-tools/lib/buck2-artifact-realize.nix { inherit pkgs; };
in
pkgs.runCommandCC "buck2-installed-library-consumer"
  {
    buildInputs = pkgs.lib.optional pkgs.stdenv.hostPlatform.isDarwin pkgs.libiconv;
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
    #[derive(serde_derive::Serialize)]
    struct ConsumerMarker { digest: content_address_core::Digest }
    fn assert_serializable<T: serde::Serialize>() {}
    fn main() {
        assert_serializable::<ConsumerMarker>();
        let digest = content_address_core::Digest([0; 32]);
        assert_eq!(digest.to_string().parse::<content_address_core::Digest>().unwrap(), digest);
    }
    RS
    serde=(${product}/lib/libserde-*.rlib)
    derive=(${product}/lib/libserde_derive-*)
    ${product.rustc.unwrapped}/bin/rustc --edition=2024 -C linker="$CC" consumer.rs \
      --extern content_address_core=${product}/lib/libcontent_address_core.rlib \
      --extern serde="''${serde[0]}" --extern serde_derive="''${derive[0]}" \
      -L dependency=${product}/lib -o consumer
    ./consumer
    echo 'PASS: installed library metadata, external consumer and proc-macro loading'
    touch "$out"
  ''
