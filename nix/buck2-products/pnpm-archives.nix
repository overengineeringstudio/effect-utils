{
  pkgs,
  sidecarPath ? ../../buck2/dependencies/pnpm-lock.sha256.json,
  # Digest-keyed private product tarballs (`mkPrivateProductTarballs`
  # `archivesByDigest`). Product rows are never fetched over the network.
  productArchives ? { },
}:

let
  lib = pkgs.lib;
  sidecar = builtins.fromJSON (builtins.readFile sidecarPath);
  archivesByDigest = builtins.listToAttrs (
    lib.mapAttrsToList (
      packageIdentity: archive:
      let
        isProduct = archive ? productTarball;
        productArchive =
          productArchives.${archive.sha256}
            or (throw "buck2-pnpm-archives: private product ${packageIdentity} has no Nix-realized archive");
      in
      assert lib.assertMsg (
        builtins.attrNames archive == [
          "bins"
          "classification"
          "integrity"
          "packageIdentity"
          (if isProduct then "productTarball" else "registryUrl")
          "sha256"
          "sizeBytes"
        ]
      ) "buck2-pnpm-archives: ${packageIdentity} fields are not exact";
      assert lib.assertMsg (
        archive.packageIdentity == packageIdentity
      ) "buck2-pnpm-archives: package identity mismatch for ${packageIdentity}";
      assert lib.assertMsg (
        archive.classification == "public" || archive.classification == "private"
      ) "buck2-pnpm-archives: invalid classification for ${packageIdentity}";
      assert lib.assertMsg (isProduct || lib.hasPrefix "https://" archive.registryUrl)
        "buck2-pnpm-archives: registry URL must use HTTPS for ${packageIdentity}";
      assert lib.assertMsg (
        !isProduct
        || (
          archive.classification == "private"
          && lib.hasPrefix "file:" archive.productTarball
          && lib.hasSuffix "-${archive.sha256}.tgz" archive.productTarball
        )
      ) "buck2-pnpm-archives: product tarball ${packageIdentity} must be a private digest-named file: archive";
      assert lib.assertMsg (lib.hasPrefix "sha512-" archive.integrity)
        "buck2-pnpm-archives: invalid lock integrity for ${packageIdentity}";
      assert lib.assertMsg (
        builtins.match "[0-9a-f]{64}" archive.sha256 != null
      ) "buck2-pnpm-archives: invalid SHA-256 for ${packageIdentity}";
      assert lib.assertMsg (
        builtins.isInt archive.sizeBytes && archive.sizeBytes > 0
      ) "buck2-pnpm-archives: invalid size for ${packageIdentity}";
      assert lib.assertMsg (
        !isProduct
        || (
          lib.isDerivation productArchive
          && (productArchive.outputHashMode or null) == "flat"
          && (productArchive.outputHash or null) == archive.sha256
        )
      ) "buck2-pnpm-archives: private product ${packageIdentity} archive is not pinned to its sidecar digest";
      {
        name = archive.sha256;
        value =
          if isProduct then
            productArchive
          else
            pkgs.fetchurl {
              url = archive.registryUrl;
              name = "${archive.sha256}.tgz";
              sha256 = archive.sha256;
            };
      }
    ) sidecar.packages
  );
  archivesByIdentity = lib.mapAttrs (_: archive: archivesByDigest.${archive.sha256}) sidecar.packages;
  archiveRoot = pkgs.linkFarm "buck2-pnpm-archives-${builtins.substring 7 12 sidecar.fingerprint}" (
    lib.mapAttrsToList (sha256: path: {
      name = "${sha256}.tgz";
      inherit path;
    }) archivesByDigest
  );
in
assert lib.assertMsg (
  builtins.attrNames sidecar == [
    "fingerprint"
    "generator"
    "lockfileFingerprint"
    "packages"
    "regenerate"
    "schema"
    "source"
  ]
) "buck2-pnpm-archives: sidecar fields are not exact";
assert lib.assertMsg (
  sidecar.schema == "effect-utils/buck2-pnpm-sha256/v2"
) "buck2-pnpm-archives: unsupported sidecar schema";
archiveRoot.overrideAttrs (old: {
  passthru = (old.passthru or { }) // {
    inherit archivesByDigest archivesByIdentity;
  };
})
