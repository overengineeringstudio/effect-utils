{ pkgs }:
let
  inherit (pkgs) lib;
  files = [
    ./buck2-publication-owner.nix
    ../scripts/buck2-publication-owner.c
  ];
  snapshot =
    includeDocs:
    lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions (
        files ++ lib.optional includeDocs (../packages + "/@overeng/buck2-tools/README.md")
      );
    };
  library =
    includeDocs: import (snapshot includeDocs + "/nix/buck2-publication-owner.nix") { inherit pkgs; };
in
assert lib.assertMsg (
  (library true).drvPath == (library false).drvPath
) "buck2 publication owner: unrelated documentation changed the native Bun runtime identity";
true
