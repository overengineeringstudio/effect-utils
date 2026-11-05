{
  pkgs,
  library,
  tool,
}:
let
  combined = (import ../workspace-tools/lib/buck2-product-composition.nix { inherit pkgs; }) {
    name = "content-address-core-with-otelite";
    products = [
      library
      tool
    ];
  };
in
assert import ../workspace-tools/lib/buck2-product-composition-plan.test.nix;
pkgs.runCommand "buck2-library-bin-consumer"
  {
    nativeBuildInputs = [
      pkgs.rustc
      pkgs.stdenv.cc
    ];
    buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
      pkgs.apple-sdk
      pkgs.libiconv
    ];
    passthru.composition = combined;
  }
  ''
    cat > consumer.rs <<'RS'
    fn main() {
        let digest = content_address_core::Digest([0; 32]);
        assert_eq!(digest.to_string().parse::<content_address_core::Digest>().unwrap(), digest);
    }
    RS
    rustc --edition=2024 consumer.rs \
      --extern content_address_core=${combined}/lib/libcontent_address_core.rlib \
      -L dependency=${combined}/lib -o consumer
    ./consumer
    ${combined}/bin/otelite --help
    touch "$out"
  ''
