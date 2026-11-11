{ pkgs }:
let
  lease = pkgs.callPackage ./editor-view-lease { };
  # The recount import graph uses only Node/Bun builtins and sibling TypeScript modules.
  source = builtins.path {
    path = ../packages + "/@overeng/buck2-tools/src";
    name = "editor-view-budget-source";
    filter =
      path: type:
      type == "directory" || (pkgs.lib.hasSuffix ".ts" path && !pkgs.lib.hasInfix ".test." path);
  };
in
pkgs.writeShellApplication {
  name = "editor-view-budget";
  text = ''
    if [[ "$#" -ne 1 || "''${1:-}" != recount ]]; then
      echo 'Usage: editor-view-budget recount' >&2
      exit 2
    fi
    export EDITOR_VIEW_LEASE_LIBRARY=${lease}/lib/libeditor-view-lease${pkgs.stdenv.hostPlatform.extensions.sharedLibrary}
    exec ${pkgs.bun}/bin/bun ${source}/editor-view.ts budget "$@"
  '';
  meta.description = "Refresh editor-view host accounting and warm census sidecars outside publication";
}
