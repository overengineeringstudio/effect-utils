# Immutable shared composition for agents/CI. Callers retain their own guarded
# Buck, capability/root publisher and explicit non-secret environment contract.
{ pkgs, buck2, events, otelSpan, tools, prepare, preflight, environment ? { } }:
let
  publication = ../scripts/worktree-env.py;
  bridge = import ./worktree-buck-trace.nix { inherit pkgs buck2 events otelSpan; };
  exports = pkgs.lib.concatStringsSep "\n" (
    pkgs.lib.mapAttrsToList (name: value: "export ${name}=${pkgs.lib.escapeShellArg (toString value)}") environment
  );
  check = pkgs.writeShellScript "worktree-tools-preflight" preflight;
  launcher = pkgs.writeShellScript "worktree-buck2" ''
    set -euo pipefail
    git_local_env="$(${pkgs.git}/bin/git rev-parse --local-env-vars)"
    while IFS= read -r variable; do unset "$variable"; done <<< "$git_local_env"
    export WORKTREE_GIT=${pkgs.git}/bin/git
    generation="$(${pkgs.python3}/bin/python3 ${publication} check @tools@)"
    export WORKSPACE_ROOT="$(${pkgs.coreutils}/bin/dirname "$(${pkgs.coreutils}/bin/dirname "$generation")")"
    export WORKSPACE_ROOT="$(${pkgs.coreutils}/bin/dirname "$WORKSPACE_ROOT")"
    IFS=: read -ra inherited_path <<< "''${PATH:-}"
    policy_path=""
    for entry in "''${inherited_path[@]}"; do
      case "$entry" in */agent-seat/policy-bin) policy_path="$policy_path$entry:" ;; esac
    done
    export WORKTREE_POLICY_PATH="''${policy_path%:}"
    export PATH="$policy_path$WORKSPACE_ROOT/node_modules/.bin:@tools@/bin:''${PATH:-}"
    ${exports}
    ${check} "$WORKSPACE_ROOT" "$generation"
    # A real emitted environment root encloses dispatch, capture and export.
    exec ${otelSpan}/bin/otel-span run effect-utils-env environment.entry \
      --attr span.label=buck --attr "process.working_directory=$PWD" \
      -- ${bridge} "$@"
  '';
in
pkgs.symlinkJoin {
  name = "worktree-tools";
  # The guarded/traced launcher is the only bin/buck2 provider in this output.
  paths = tools;
  postBuild = ''
    test ! -e "$out/bin/buck2"
    mkdir -p "$out/bin" "$out/share/worktree-tools"
    substitute ${launcher} "$out/bin/buck2" --replace-fail @tools@ "$out"
    chmod +x "$out/bin/buck2"
    ln -s ${pkgs.writeShellScript "worktree-tools-prepare" prepare} "$out/share/worktree-tools/prepare"
    ln -s ${check} "$out/share/worktree-tools/preflight"
    ln -s ${publication} "$out/share/worktree-tools/worktree-env.py"
  '';
}
