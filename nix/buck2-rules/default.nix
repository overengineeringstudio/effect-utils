{
  pkgs,
  buck2,
  src,
}:

let
  lib = pkgs.lib;
  inventory = builtins.fromJSON (builtins.readFile ./inventory.json);
  files = inventory.files;
  sortedFiles = builtins.sort builtins.lessThan files;
in
assert lib.assertMsg (
  builtins.attrNames inventory == [
    "files"
    "schema"
    "schemaVersion"
  ]
  && inventory.schema == "effect-utils/buck2-rules-inventory/v1"
  && inventory.schemaVersion == 1
) "buck2-rules: generated inventory schema is invalid";
assert lib.assertMsg (files == sortedFiles) "buck2-rules: generated inventory must be sorted";
assert lib.assertMsg (
  builtins.length files == builtins.length (lib.unique files)
) "buck2-rules: generated inventory paths must be unique";
pkgs.runCommand "buck2-rules"
  {
    nativeBuildInputs = [
      pkgs.gnutar
      pkgs.gzip
    ];
    passthru = {
      inherit inventory;
      prelude = buck2.passthru.prelude;
    };
  }
  ''
    mkdir -p "$out"
    ${lib.concatMapStringsSep "\n" (path: ''
      mkdir -p "$out/${builtins.dirOf path}"
      cp ${lib.escapeShellArg "${src}/${path}"} "$out/${lib.escapeShellArg path}"
    '') files}
    cp ${./inventory.json} "$out/inventory.json"
    chmod -R u+w "$out"
    mkdir -p "$out/prelude"
    tar -xzf ${buck2.passthru.prelude} --strip-components=1 -C "$out/prelude"

    substituteInPlace "$out/buck2/toolchains/BUCK" \
      --replace-fail '"//.buck2/capabilities:defs.bzl"' '"@capabilities//:defs.bzl"'
    substituteInPlace "$out/buck2/toolchains/configured.bzl" \
      --replace-fail '"//.buck2/capabilities:defs.bzl"' '"@capabilities//:defs.bzl"' \
      --replace-fail '"//.buck2/capabilities/generations/' '"@capabilities//generations/'
  ''
