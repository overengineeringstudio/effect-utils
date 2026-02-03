# DEPRECATED: This module is no longer needed as of devenv 2.0.0+
#
# The upstream issue https://github.com/cachix/devenv/issues/2455 was fixed
# in commit 59bdb8c (2026-02-03). If you're using devenv 2.0.0 or later,
# you can safely remove this import from your devenv.nix.
#
# This module is kept for backwards compatibility with older devenv versions.
#
# Original issue: https://github.com/cachix/devenv/issues/2455
{ config, lib, pkgs, ... }:

let
  # Get the list of hook stages from git-hooks config
  # We need to check if the actual hook files exist for each configured stage
  configuredStages = lib.pipe config.git-hooks.hooks [
    (lib.filterAttrs (_: hook: hook.enable or false))
    (lib.mapAttrsToList (_: hook: hook.stages or [ "pre-commit" ]))
    lib.flatten
    lib.unique
  ];

  stagesStr = lib.concatStringsSep " " configuredStages;
  prek = pkgs.prek or (builtins.throw "prek not available in pkgs");
in
{
  tasks."git-hooks:ensure" = lib.mkIf (config.git-hooks.hooks != { }) {
    description = "Ensure git hooks are actually installed (workaround for cachix/devenv#2455)";
    exec = ''
      # Skip if not in a git repo
      if ! git rev-parse --git-dir &>/dev/null; then
        exit 0
      fi

      # Skip if no .pre-commit-config.yaml (git-hooks not configured)
      if [ ! -e ".pre-commit-config.yaml" ]; then
        exit 0
      fi

      HOOKS_DIR=$(git rev-parse --git-common-dir)/hooks
      INSTALLED_ANY=0

      for stage in ${stagesStr}; do
        if [ ! -f "$HOOKS_DIR/$stage" ]; then
          echo "[git-hooks:ensure] Installing missing hook: $stage"
          # Clear core.hooksPath temporarily so prek doesn't refuse
          HOOKS_PATH=$(git config --local core.hooksPath 2>/dev/null || true)
          if [ -n "$HOOKS_PATH" ]; then
            git config --local --unset core.hooksPath
          fi

          ${prek}/bin/prek install -c .pre-commit-config.yaml -t "$stage" 2>/dev/null || true

          # Restore core.hooksPath
          if [ -n "$HOOKS_PATH" ]; then
            git config --local core.hooksPath "$HOOKS_PATH"
          fi

          INSTALLED_ANY=1
        fi
      done

      if [ "$INSTALLED_ANY" = "1" ]; then
        echo "[git-hooks:ensure] Hooks installed successfully"
      fi
    '';
    # Run AFTER devenv:git-hooks:install to fix up any missing hooks
    after = [ "devenv:git-hooks:install" ];
    # Run BEFORE enterShell so hooks are ready when shell starts
    before = [ "devenv:enterShell" ];
  };
}
