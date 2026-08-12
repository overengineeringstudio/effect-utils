# Export an already-relocatable Nix-authored tool tree for Buck2 consumption.
# This helper deliberately validates relocation; it does not guess how to
# rewrite ELF/Mach-O loaders, shebangs, or runtime data paths. Its provenance
# describes lineage but is not a signature or authenticity proof.
{ pkgs }:

let
  lib = pkgs.lib;
  scan = import ./buck2-artifact-scan.nix { inherit pkgs; };

  validName = value: builtins.isString value && builtins.match "[A-Za-z0-9._+-]+" value != null;
  safeRelativePath =
    value:
    let
      components = lib.splitString "/" value;
    in
    builtins.isString value
    && value != ""
    && !(lib.hasPrefix "/" value)
    && !(lib.hasInfix "\\" value)
    && lib.all (component: component != "" && component != "." && component != "..") components;
in
{
  name,
  src,
  entrypoints,
  provenance,
  platform ? pkgs.stdenv.hostPlatform.system,
}:

assert lib.assertMsg (validName name)
  "buck2-toolchain-export: name must be a portable artifact name";
assert lib.assertMsg (validName platform)
  "buck2-toolchain-export: platform must be a portable platform identifier";
assert lib.assertMsg (
  builtins.isList entrypoints && entrypoints != [ ]
) "buck2-toolchain-export: entrypoints must be a non-empty list";
assert lib.assertMsg (lib.all safeRelativePath entrypoints)
  "buck2-toolchain-export: entrypoints must be safe relative paths";
assert lib.assertMsg (
  builtins.length entrypoints == builtins.length (lib.unique entrypoints)
) "buck2-toolchain-export: entrypoints must be unique";
assert lib.assertMsg (
  builtins.isAttrs provenance
  && provenance ? recipeId
  && builtins.isString provenance.recipeId
  && provenance.recipeId != ""
  && provenance ? sourceDigest
  && builtins.isString provenance.sourceDigest
  && provenance.sourceDigest != ""
) "buck2-toolchain-export: provenance requires non-empty recipeId and sourceDigest strings";

let
  provenanceFile = pkgs.writeText "${name}-buck2-toolchain-provenance.json" (
    builtins.toJSON (
      provenance
      // {
        producer = "effect-utils.buck2-toolchain-export";
      }
    )
  );
  entrypointsFile = pkgs.writeText "${name}-buck2-toolchain-entrypoints.json" (
    builtins.toJSON entrypoints
  );
in
pkgs.runCommand "${name}-${platform}-buck2-toolchain"
  {
    nativeBuildInputs = [
      pkgs.jq
      pkgs.openssl
    ];
    allowedReferences = [ ];
    passthru = {
      archivePath = "artifact.tar";
      descriptorPath = "descriptor.json";
      inherit entrypoints platform;
    };
  }
  ''
    set -euo pipefail

    payload="$NIX_BUILD_TOP/payload"
    mkdir -p "$payload" "$out"
    cp -a ${lib.escapeShellArg (toString src)}/. "$payload"/

    while IFS= read -r entrypoint; do
      case "$entrypoint" in
        /*|../*|*/../*|*/..) echo "buck2-toolchain-export: unsafe entrypoint: $entrypoint" >&2; exit 1 ;;
      esac
      [ -f "$payload/$entrypoint" ] || {
        echo "buck2-toolchain-export: missing entrypoint: $entrypoint" >&2
        exit 1
      }
      [ -x "$payload/$entrypoint" ] || {
        echo "buck2-toolchain-export: entrypoint is not executable: $entrypoint" >&2
        exit 1
      }
    done < <(${pkgs.jq}/bin/jq -r '.[]' ${entrypointsFile})

    # Normalize only representation metadata. Content owners must make the tool
    # itself relocatable before calling this helper.
    ${pkgs.findutils}/bin/find "$payload" -type d -exec chmod 0555 {} +
    while IFS= read -r -d "" file; do
      if [ -x "$file" ]; then chmod 0555 "$file"; else chmod 0444 "$file"; fi
    done < <(${pkgs.findutils}/bin/find "$payload" -type f -print0)

    ${scan} tree "$payload"

    ${pkgs.gnutar}/bin/tar \
      --create \
      --format=gnu \
      --sort=name \
      --mtime='@1' \
      --owner=0 \
      --group=0 \
      --numeric-owner \
      --file "$out/artifact.tar" \
      --directory "$payload" \
      .
    ${scan} archive "$out/artifact.tar"

    digest="sha256-$(${pkgs.openssl}/bin/openssl dgst -sha256 -binary "$out/artifact.tar" \
      | ${pkgs.openssl}/bin/openssl base64 -A)"
    size="$(${pkgs.coreutils}/bin/stat --format=%s "$out/artifact.tar")"

    ${pkgs.jq}/bin/jq --null-input --sort-keys \
      --arg name ${lib.escapeShellArg name} \
      --arg platform ${lib.escapeShellArg platform} \
      --arg digest "$digest" \
      --argjson sizeBytes "$size" \
      --slurpfile entrypoints ${entrypointsFile} \
      --slurpfile provenance ${provenanceFile} \
      '{
        schemaVersion: 1,
        kind: "buck2-portable-toolchain-artifact",
        name: $name,
        platform: $platform,
        artifact: {
          file: "artifact.tar",
          format: "tar",
          digest: { algorithm: "sha256", sri: $digest },
          sizeBytes: $sizeBytes
        },
        entrypoints: $entrypoints[0],
        normalization: {
          schemaVersion: 1,
          mtimeSeconds: 1,
          ownerId: 0,
          groupId: 0,
          directoryMode: "0555",
          executableMode: "0555",
          dataMode: "0444"
        },
        provenance: $provenance[0]
      }' > "$out/descriptor.json"

    ${scan} tree "$out"
  ''
