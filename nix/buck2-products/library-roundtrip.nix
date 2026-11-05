# Run only after the source archive is realized: descriptor reads never cause IFD.
{
  repositoryPath,
  productName,
  sourcePath,
  system ? builtins.currentSystem,
}:
let
  flake = builtins.getFlake ("git+file://" + repositoryPath + "?shallow=1");
  pkgs = import flake.inputs.nixpkgs { inherit system; };
  contract = import ../workspace-tools/lib/buck2-build-product-contract.nix;
  source = flake.packages.${system}.${productName};
  archiveRoot = builtins.storePath sourcePath;
  # Identity strings are data; archiveRoot below retains the explicit store dependency.
  descriptor = builtins.fromJSON (
    builtins.unsafeDiscardStringContext (builtins.readFile "${archiveRoot}/descriptor.json")
  );
  importArtifact = flake.lib.mkBuck2ArtifactImport { inherit pkgs; };
  args = {
    inherit descriptor;
    expectedDescriptorDigest = contract.descriptorDigest descriptor;
    expectedPlatform = descriptor.platform;
    artifact = "${archiveRoot}/artifact.tar";
  };
  published = importArtifact args;
  tamperedDescriptor = descriptor // {
    name = "tampered-library";
  };
  tampered = importArtifact (
    args
    // {
      descriptor = tamperedDescriptor;
    }
  );
in
assert contract.validateDescriptor tamperedDescriptor == tamperedDescriptor;
assert !(builtins.tryEval tampered.drvPath).success;
assert toString source.buck2Product == sourcePath;
assert published.checkedDescriptor == descriptor;
assert published.rustc == source.rustc;
assert published.rustTarget == source.rustTarget;
assert published.panicStrategy == source.panicStrategy;
pkgs.runCommand "${productName}-published-library-roundtrip"
  {
    nativeBuildInputs = [
      pkgs.rustc
      pkgs.stdenv.cc
    ];
    buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
      pkgs.apple-sdk
      pkgs.libiconv
    ];
  }
  ''
    set -euo pipefail
    ${pkgs.diffutils}/bin/diff -r ${source}/lib ${published}/lib
    ${pkgs.jq}/bin/jq -cS . ${archiveRoot}/descriptor.json > source.json
    ${pkgs.jq}/bin/jq -cS . ${published.descriptorPath} > published.json
    ${pkgs.diffutils}/bin/cmp source.json published.json
    cat > consumer.rs <<'RS'
    fn main() {
        let digest = content_address_core::Digest([0; 32]);
        assert_eq!(digest.to_string().parse::<content_address_core::Digest>().unwrap(), digest);
    }
    RS
    rustc --edition=2024 consumer.rs \
      --extern content_address_core=${published}/lib/libcontent_address_core.rlib \
      -L dependency=${published}/lib -o consumer
    ./consumer
    touch "$out"
  ''
