{ pkgs }:

let
  exportToolchain = import ../buck2-toolchain-export.nix { inherit pkgs; };
  importArtifact = import ../buck2-artifact-import.nix { inherit pkgs; };

  provenance = {
    recipeId = "buck2-bridge-test/portable-tool-v1";
    sourceDigest = "sha256:fixture-portable-tool-v1";
  };

  portableSource = pkgs.runCommand "buck2-bridge-portable-source" { allowedReferences = [ ]; } ''
    mkdir -p "$out/bin" "$out/share/fixture"
    printf '%s\n' '#!/bin/sh' 'printf "%s\\n" buck2-bridge-ok' > "$out/bin/fixture-tool"
    printf '%s\n' 'portable fixture data' > "$out/share/fixture/data.txt"
    chmod 0555 "$out/bin/fixture-tool"
    chmod 0444 "$out/share/fixture/data.txt"
  '';

  storeReferenceSource = pkgs.runCommand "buck2-bridge-store-reference-source" { } ''
    mkdir -p "$out/bin"
    printf '%s\n' '#!/bin/sh' 'exec ${pkgs.hello}/bin/hello "$@"' > "$out/bin/fixture-tool"
    chmod 0555 "$out/bin/fixture-tool"
  '';

  escapingSymlinkSource =
    pkgs.runCommand "buck2-bridge-escaping-symlink-source" { allowedReferences = [ ]; }
      ''
        mkdir -p "$out/bin" "$out/share"
        printf '%s\n' '#!/bin/sh' 'exit 0' > "$out/bin/fixture-tool"
        chmod 0555 "$out/bin/fixture-tool"
        ln -s ../../outside "$out/share/escape"
      '';

  reservedMetadataSource =
    pkgs.runCommand "buck2-bridge-reserved-metadata-source"
      {
        allowedReferences = [ ];
      }
      ''
        mkdir -p "$out/bin" "$out/share/buck2-artifact"
        printf '%s\n' '#!/bin/sh' 'exit 0' > "$out/bin/fixture-tool"
        printf '%s\n' payload-owned > "$out/share/buck2-artifact/descriptor.json"
        chmod 0555 "$out/bin/fixture-tool"
        chmod 0444 "$out/share/buck2-artifact/descriptor.json"
      '';

  mkExport =
    src:
    exportToolchain {
      name = "fixture-tool";
      inherit src provenance;
      entrypoints = [ "bin/fixture-tool" ];
    };

  mkEntrypointExport =
    entrypoint:
    exportToolchain {
      name = "fixture-tool";
      src = portableSource;
      inherit provenance;
      entrypoints = [ entrypoint ];
    };
in
{
  portableExport = mkExport portableSource;
  storeReferenceExport = mkExport storeReferenceSource;
  escapingSymlinkExport = mkExport escapingSymlinkSource;
  reservedMetadataExport = mkExport reservedMetadataSource;
  nonCanonicalEntrypointExport = mkEntrypointExport "bin/./fixture-tool";
  repeatedSeparatorEntrypointExport = mkEntrypointExport "bin//fixture-tool";
  backslashEntrypointExport = mkEntrypointExport "bin\\fixture-tool";
  duplicateEntrypointExport = exportToolchain {
    name = "fixture-tool";
    src = portableSource;
    inherit provenance;
    entrypoints = [
      "bin/fixture-tool"
      "bin/fixture-tool"
    ];
  };

  mkImport =
    {
      descriptor,
      url ? null,
      artifact ? null,
      expectedPlatform ? pkgs.stdenv.hostPlatform.system,
    }:
    importArtifact {
      inherit
        artifact
        descriptor
        expectedPlatform
        url
        ;
    };
}
