{
  pkgs,
  native ? pkgs.callPackage ./default.nix { },
}:
let
  preload = ./inherit.cjs;
in
pkgs.writeShellApplication {
  name = "editor-view-source";
  runtimeInputs = [ pkgs.coreutils ];
  text = ''
    root="''${EDITOR_VIEW_LEASE_WORKSPACE_ROOT:-''${DEVENV_ROOT:-$PWD}}"
    root="$(realpath "$root")"
    # No synthetic override: linked workspaces can have different owning CAS
    # fences. Native discovery infers each root's store unless explicitly set.
    if [ -n "''${EDITOR_VIEW_CONTENT_STORE:-}" ]; then
      # Match the source API's lexical resolve of relative overrides, without
      # following a symlink that the native control validation must reject.
      EDITOR_VIEW_CONTENT_STORE="$(realpath -m -s "$EDITOR_VIEW_CONTENT_STORE")"
      export EDITOR_VIEW_CONTENT_STORE
    fi
    export EDITOR_VIEW_LEASE_WORKSPACE_ROOT="$root"
    # Verify every launch; Bun enumerates all ancestors of a store-backed preload.
    preload="$(${pkgs.bash}/bin/bash ${./prepare-preload.sh} ${preload})"
    export EDITOR_VIEW_LEASE_PRELOAD="$preload"
    export EDITOR_VIEW_LEASE_LIBRARY=${native}/lib/libeditor-view-lease${pkgs.stdenv.hostPlatform.extensions.sharedLibrary}
    export NODE_OPTIONS="''${NODE_OPTIONS:-} --require=$preload"
    export BUN_OPTIONS="''${BUN_OPTIONS:-} --preload=$preload"
    exec ${native}/bin/editor-view-lease --workspace-root "$root" -- "$@"
  '';
}
