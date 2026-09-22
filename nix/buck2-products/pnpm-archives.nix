{
  pkgs,
  sidecarPath ? ../../buck2/dependencies/pnpm-lock.sha256.json,
}:

let
  lib = pkgs.lib;
  sidecar = builtins.fromJSON (builtins.readFile sidecarPath);
  archivesByDigest = builtins.listToAttrs (
    lib.mapAttrsToList (
      packageIdentity:
      archive:
      assert lib.assertMsg (
        builtins.attrNames archive == [
          "bins"
          "classification"
          "integrity"
          "packageIdentity"
          "registryUrl"
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
      assert lib.assertMsg (
        lib.hasPrefix "https://" archive.registryUrl
      ) "buck2-pnpm-archives: registry URL must use HTTPS for ${packageIdentity}";
      assert lib.assertMsg (
        lib.hasPrefix "sha512-" archive.integrity
      ) "buck2-pnpm-archives: invalid lock integrity for ${packageIdentity}";
      assert lib.assertMsg (
        builtins.match "[0-9a-f]{64}" archive.sha256 != null
      ) "buck2-pnpm-archives: invalid SHA-256 for ${packageIdentity}";
      assert lib.assertMsg (
        builtins.isInt archive.sizeBytes && archive.sizeBytes > 0
      ) "buck2-pnpm-archives: invalid size for ${packageIdentity}";
      {
        name = archive.sha256;
        value = pkgs.fetchurl {
          url = archive.registryUrl;
          name = "${archive.sha256}.tgz";
          sha256 = archive.sha256;
        };
      }
    ) sidecar.packages
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
pkgs.linkFarm "buck2-pnpm-archives-${builtins.substring 7 12 sidecar.fingerprint}" (
  lib.mapAttrsToList (sha256: path: {
    name = "${sha256}.tgz";
    inherit path;
  }) archivesByDigest
)
