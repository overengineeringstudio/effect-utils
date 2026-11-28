# Immutable shared composition for agents/CI. Callers retain their own guarded
# Buck, capability/root publisher and explicit non-secret environment contract.
{
  pkgs,
  buck2,
  events,
  otelSpan,
  tools,
  prepare,
  preflight,
  # Shared { paths; source; } projection of the owning tool input declaration.
  identityInputs,
  environment ? { },
}:
let
  # Watchman prunes ignored outputs before watching; notify recursively walks
  # their growing trees on Linux and has no delivery barrier on Darwin.
  fileWatcher = "watchman";
  # Capture the executable file, not its enclosing flake source context.
  publication = builtins.path {
    path = ../scripts/worktree-env.py;
    name = "worktree-env.py";
  };
  identityManifest = pkgs.writeText "worktree-tools-identity-inputs.json" (
    builtins.toJSON {
      schemaVersion = 1;
      # Owning-root Git selectors are metadata, not executable/store references.
      # Do not retain the whole flake's source context through relative names.
      paths = builtins.sort builtins.lessThan (
        pkgs.lib.unique (map builtins.unsafeDiscardStringContext identityInputs.paths)
      );
    }
  );
  identityDigest =
    pkgs.runCommand "worktree-tools-identity-inputs-digest"
      {
        nativeBuildInputs = [
          pkgs.git
          pkgs.python3
        ];
      }
      ''
        export HOME="$TMPDIR/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
        export WORKTREE_GIT=${pkgs.git}/bin/git
        mkdir -p "$HOME" "$TMPDIR/snapshot"
        cp -R ${identityInputs.source}/. "$TMPDIR/snapshot/"
        chmod -R u+w "$TMPDIR/snapshot"
        git -c init.defaultBranch=identity init --template= "$TMPDIR/snapshot" >&2
        git -C "$TMPDIR/snapshot" add -f --all
        ${pkgs.python3}/bin/python3 -P ${publication} inputs-digest \
          ${identityManifest} "$TMPDIR/snapshot" > "$out"
      '';
  bridge = import ./worktree-buck-trace.nix {
    inherit
      pkgs
      buck2
      events
      otelSpan
      ;
  };
  exports = pkgs.lib.concatStringsSep "\n" (
    pkgs.lib.mapAttrsToList (
      name: value: "export ${name}=${pkgs.lib.escapeShellArg (toString value)}"
    ) environment
  );
  watcherPrepare = pkgs.writeShellScript "worktree-tools-prepare" ''
    set -euo pipefail
    # Persist the evaluated selection before caller preparation can start native Buck.
    (cd "$1" && ${buck2}/bin/buck2 worktree-watcher prepare ${fileWatcher})
    ${prepare}
  '';
  check = pkgs.writeShellScript "worktree-tools-preflight" ''
    set -euo pipefail
    (cd "$1" && ${buck2}/bin/buck2 worktree-watcher check ${fileWatcher})
    ${preflight}
  '';
  launcher = pkgs.writeShellScript "worktree-buck2" ''
    set -euo pipefail
    git_local_env="$(${pkgs.git}/bin/git rev-parse --local-env-vars)"
    while IFS= read -r variable; do unset "$variable"; done <<< "$git_local_env"
    export WORKTREE_GIT=${pkgs.git}/bin/git
    generation="$(${pkgs.python3}/bin/python3 -P ${publication} check @tools@)"
    export WORKSPACE_ROOT="$(${pkgs.coreutils}/bin/dirname "$(${pkgs.coreutils}/bin/dirname "$generation")")"
    export WORKSPACE_ROOT="$(${pkgs.coreutils}/bin/dirname "$WORKSPACE_ROOT")"
    IFS=: read -ra inherited_path <<< "''${PATH:-}"
    policy_path=""
    for entry in "''${inherited_path[@]}"; do
      case "$entry" in */agent-seat/policy-bin) policy_path="$policy_path$entry:" ;; esac
    done
    # Keep the operator's immutable admission package, never its ambient bin dir.
    operator_gate="$(type -P gate-slot || true)"
    if [ -n "$operator_gate" ]; then
      operator_gate="$(${pkgs.coreutils}/bin/realpath "$operator_gate")"
      operator_package="''${operator_gate%/bin/gate-slot}"
      case "$operator_package" in
        /nix/store/*)
          if [[ "''${operator_package#/nix/store/}" != */* && "$operator_gate" == "$operator_package/bin/gate-slot" ]]; then
            policy_path="$policy_path$operator_package/bin:"
          fi
          ;;
      esac
    fi
    export WORKTREE_POLICY_PATH="''${policy_path%:}"
    export PATH="$policy_path$WORKSPACE_ROOT/node_modules/.bin:@tools@/bin:''${PATH:-}"
    ${exports}
    ${check} "$WORKSPACE_ROOT" "$generation"
    export WORKTREE_CAPABILITIES_PROFILE="$(${pkgs.coreutils}/bin/realpath "$generation/profile")"
    # A real emitted environment root encloses dispatch, capture and export.
    exec ${otelSpan}/bin/otel-span run effect-utils-env environment.entry \
      --attr span.label=buck --attr "process.working_directory=$PWD" \
      -- ${bridge} "$@"
  '';
in
assert pkgs.lib.assertMsg (
  builtins.isAttrs identityInputs
  && identityInputs ? source
  && identityInputs ? paths
  && builtins.isList identityInputs.paths
  && identityInputs.paths != [ ]
  && builtins.all (path: builtins.isString path && path != "") identityInputs.paths
) "worktree-tools: identityInputs must project nonempty owning-repository Git selectors and source";
pkgs.symlinkJoin {
  name = "worktree-tools";
  # The guarded/traced launcher is the only bin/buck2 provider in this output.
  paths = tools;
  passthru = {
    inherit fileWatcher;
    identity-inputs-manifest = identityManifest;
    identity-inputs-digest = identityDigest;
  };
  postBuild = ''
    test ! -e "$out/bin/buck2"
    mkdir -p "$out/bin" "$out/share/worktree-tools"
    substitute ${launcher} "$out/bin/buck2" --replace-fail @tools@ "$out"
    chmod +x "$out/bin/buck2"
    ln -s ${watcherPrepare} "$out/share/worktree-tools/prepare"
    ln -s ${check} "$out/share/worktree-tools/preflight"
    ln -s ${publication} "$out/share/worktree-tools/worktree-env.py"
    ln -s ${identityManifest} "$out/share/worktree-tools/identity-inputs.json"
    ln -s ${identityDigest} "$out/share/worktree-tools/identity-inputs-digest"
  '';
}
