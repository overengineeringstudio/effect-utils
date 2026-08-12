# Verify and import a published Buck2 artifact into a normal Nix store output.
# The descriptor is an evaluated, reviewed input; Nix never invokes Buck2 or a
# mutable checkout while composing the result. Provenance fields provide
# attributable lineage, not authenticity: callers must obtain the descriptor
# through a trusted source or verify a signature before evaluation.
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
  hasOnlyFields =
    allowed: value:
    builtins.isAttrs value && lib.all (field: lib.elem field allowed) (builtins.attrNames value);
in
{
  descriptor,
  url ? null,
  artifact ? null,
  expectedPlatform ? pkgs.stdenv.hostPlatform.system,
}:

assert lib.assertMsg (builtins.isAttrs descriptor)
  "buck2-artifact-import: descriptor must be an attribute set";
assert lib.assertMsg (hasOnlyFields [
  "artifact"
  "entrypoints"
  "kind"
  "name"
  "platform"
  "provenance"
  "schemaVersion"
] descriptor) "buck2-artifact-import: descriptor contains unknown fields";
assert lib.assertMsg (
  (descriptor.schemaVersion or null) == 1
) "buck2-artifact-import: unsupported descriptor schemaVersion";
assert lib.assertMsg (
  (descriptor.kind or null) == "buck2-build-artifact"
) "buck2-artifact-import: unsupported descriptor kind";
assert lib.assertMsg (validName (
  descriptor.name or null
)) "buck2-artifact-import: descriptor name is invalid";
assert lib.assertMsg (validName (
  descriptor.platform or null
)) "buck2-artifact-import: descriptor platform is invalid";
assert lib.assertMsg (descriptor.platform == expectedPlatform)
  "buck2-artifact-import: platform mismatch: expected ${expectedPlatform}, got ${
    descriptor.platform or "<missing>"
  }";
assert lib.assertMsg (
  descriptor ? artifact
  && hasOnlyFields [ "digest" "file" "format" "sizeBytes" "url" ] descriptor.artifact
  && (descriptor.artifact.format or null) == "tar"
  && (descriptor.artifact.file or null) == "artifact.tar"
  && descriptor.artifact ? digest
  && hasOnlyFields [ "algorithm" "sri" ] descriptor.artifact.digest
  && (descriptor.artifact.digest.algorithm or null) == "sha256"
  && builtins.isString (descriptor.artifact.digest.sri or null)
  && builtins.match "sha256-[A-Za-z0-9+/]+={0,2}" descriptor.artifact.digest.sri != null
  && builtins.isInt (descriptor.artifact.sizeBytes or null)
  && descriptor.artifact.sizeBytes > 0
) "buck2-artifact-import: descriptor artifact/digest shape is invalid";
assert lib.assertMsg (
  descriptor ? entrypoints && builtins.isList descriptor.entrypoints && descriptor.entrypoints != [ ]
) "buck2-artifact-import: descriptor entrypoints must be a non-empty list";
assert lib.assertMsg (lib.all safeRelativePath descriptor.entrypoints)
  "buck2-artifact-import: descriptor entrypoints must be canonical safe relative paths";
assert lib.assertMsg (
  builtins.length descriptor.entrypoints == builtins.length (lib.unique descriptor.entrypoints)
) "buck2-artifact-import: descriptor entrypoints must be unique";
assert lib.assertMsg (
  descriptor ? provenance
  && hasOnlyFields [ "actionDigest" "producer" "sourceRevision" "target" ] descriptor.provenance
  && builtins.isString (descriptor.provenance.producer or null)
  && descriptor.provenance.producer != ""
  && builtins.isString (descriptor.provenance.target or null)
  && descriptor.provenance.target != ""
  && builtins.isString (descriptor.provenance.sourceRevision or null)
  && descriptor.provenance.sourceRevision != ""
  && builtins.isString (descriptor.provenance.actionDigest or null)
  && descriptor.provenance.actionDigest != ""
) "buck2-artifact-import: descriptor provenance is incomplete";
assert lib.assertMsg (
  !((url != null || descriptor.artifact ? url) && artifact != null)
) "buck2-artifact-import: choose either a published URL or a declared artifact path";
assert lib.assertMsg (
  url != null || descriptor.artifact ? url || artifact != null
) "buck2-artifact-import: a published URL or declared artifact path is required";

let
  effectiveUrl = if url != null then url else descriptor.artifact.url;
  descriptorFile = pkgs.writeText "${descriptor.name}-buck2-artifact-descriptor.json" (
    builtins.toJSON descriptor
  );
  archive =
    if artifact != null then
      pkgs.runCommand "${descriptor.name}-${descriptor.platform}-buck2-artifact.tar"
        {
          outputHashMode = "flat";
          outputHashAlgo = "sha256";
          outputHash = descriptor.artifact.digest.sri;
        }
        ''
          cp ${lib.escapeShellArg (toString artifact)} "$out"
        ''
    else
      pkgs.fetchurl {
        name = "${descriptor.name}-${descriptor.platform}-buck2-artifact.tar";
        url = effectiveUrl;
        hash = descriptor.artifact.digest.sri;
      };
in
pkgs.runCommand "${descriptor.name}-${descriptor.platform}-buck2-import"
  {
    nativeBuildInputs = [
      pkgs.jq
      pkgs.openssl
    ];
    allowedReferences = [ ];
    passthru = {
      buck2ArtifactDescriptor = descriptor;
      inherit archive;
    };
    meta.platforms = [ descriptor.platform ];
  }
  ''
    set -euo pipefail

    expected_digest=${lib.escapeShellArg descriptor.artifact.digest.sri}
    actual_digest="sha256-$(${pkgs.openssl}/bin/openssl dgst -sha256 -binary ${archive} \
      | ${pkgs.openssl}/bin/openssl base64 -A)"
    [ "$actual_digest" = "$expected_digest" ] || {
      echo "buck2-artifact-import: digest mismatch after fixed-output fetch" >&2
      exit 1
    }
    expected_size=${toString descriptor.artifact.sizeBytes}
    actual_size="$(${pkgs.coreutils}/bin/stat --format=%s ${archive})"
    [ "$actual_size" = "$expected_size" ] || {
      echo "buck2-artifact-import: size mismatch: expected $expected_size bytes, got $actual_size" >&2
      exit 1
    }

    ${scan} archive ${archive}
    mkdir -p "$out"
    ${pkgs.gnutar}/bin/tar \
      --extract \
      --file ${archive} \
      --directory "$out" \
      --no-same-owner \
      --no-same-permissions \
      --delay-directory-restore

    ${scan} tree "$out"

    if [ -L "$out/share" ] \
      || [ -e "$out/share/buck2-artifact" ] \
      || [ -L "$out/share/buck2-artifact" ]; then
      echo "buck2-artifact-import: artifact occupies reserved importer metadata path" >&2
      exit 1
    fi

    while IFS= read -r entrypoint; do
      case "$entrypoint" in
        /*|../*|*/../*|*/..) echo "buck2-artifact-import: unsafe entrypoint: $entrypoint" >&2; exit 1 ;;
      esac
      [ -f "$out/$entrypoint" ] && [ -x "$out/$entrypoint" ] || {
        echo "buck2-artifact-import: missing executable entrypoint: $entrypoint" >&2
        exit 1
      }
    done < <(${pkgs.jq}/bin/jq -r '.entrypoints[]' ${descriptorFile})

    chmod u+w "$out" "$out/share" 2>/dev/null || true
    mkdir -p "$out/share/buck2-artifact"
    cp ${descriptorFile} "$out/share/buck2-artifact/descriptor.json"
    chmod 0444 "$out/share/buck2-artifact/descriptor.json"
    ${pkgs.findutils}/bin/find "$out" -type d -exec chmod 0555 {} +
    ${scan} tree "$out"
  ''
