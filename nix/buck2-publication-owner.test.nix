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
  comparison = ''
    let
      pkgs = import ${pkgs.path} { system = ${builtins.toJSON pkgs.stdenv.hostPlatform.system}; };
      withDocs = import ${snapshot true}/nix/buck2-publication-owner.nix { inherit pkgs; };
      withoutDocs = import ${snapshot false}/nix/buck2-publication-owner.nix { inherit pkgs; };
    in
    assert pkgs.lib.assertMsg (
      withDocs.drvPath == withoutDocs.drvPath
    ) "buck2 publication owner: unrelated documentation changed the native Bun runtime identity";
    true
  '';
in
# Import the snapshots only at build time, when their store paths have been realised.
pkgs.runCommand "publication-owner-identity" { nativeBuildInputs = [ pkgs.nix ]; } ''
  export HOME="$TMPDIR"
  nix-instantiate --eval --strict --store dummy:// --expr ${lib.escapeShellArg comparison}
  touch "$out"
''
