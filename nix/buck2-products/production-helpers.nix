# Separate build input: never stage development tests or validation runners.
{ pkgs, repositoryRoot }:
let
  inventory = builtins.fromJSON (builtins.readFile (repositoryRoot + "/nix/buck2-products/production-helpers.json"));
  source = pkgs.lib.fileset.toSource {
    root = repositoryRoot;
    fileset = pkgs.lib.fileset.unions (map (file: repositoryRoot + "/${file}") inventory.files);
  };
  buck = pkgs.writeText "production-helpers-BUCK" (
    builtins.readFile (repositoryRoot + "/nix/buck2-products/production-helpers.BUCK")
  );
in
assert inventory.schema == "effect-utils/production-helpers/v1" && inventory.schemaVersion == 1;
assert builtins.all (file: pkgs.lib.hasPrefix "packages/@overeng/buck2-tools/" file) inventory.files;
pkgs.runCommand "buck2-production-helpers" { passthru = { inherit source inventory; }; } ''
  mkdir -p "$out"
  cp -R ${source}/. "$out/"
  chmod u+w "$out/packages/@overeng/buck2-tools"
  cp ${buck} "$out/packages/@overeng/buck2-tools/BUCK"
''
