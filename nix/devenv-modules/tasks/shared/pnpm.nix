# pnpm install tasks
#
# effect-utils now uses a repo-root pnpm workspace for dev installs.
# Package-level pnpm-workspace.yaml files remain only as package-closure build
# metadata and lockfile generation inputs.
#
# Provides:
# - pnpm:install
# - pnpm:update
# - pnpm:clean
# - pnpm:reset-lock-files
{
  packages,
  globalCache ? true,
  frozenInCi ? true,
}:
{
  lib,
  config,
  pkgs,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cache = import ../lib/cache.nix { inherit config; };
  cacheRoot = cache.mkCachePath "pnpm-install";

  sha256sum = "${pkgs.coreutils}/bin/sha256sum";
  flock = "${pkgs.flock}/bin/flock";

  manifestPaths = lib.concatMapStringsSep " " (path: ''"${path}/package.json"'') packages;
  packageWorkspacePaths =
    lib.concatMapStringsSep " " (
      path: ''"${path}/pnpm-workspace.yaml" "${path}/pnpm-lock.yaml"''
    ) packages;
  nodeModulesPaths = lib.concatMapStringsSep " " (path: ''"${path}/node_modules"'') packages;
  lockFilePaths =
    lib.concatStringsSep " " ([ ''"pnpm-lock.yaml"'' ] ++ map (path: ''"${path}/pnpm-lock.yaml"'') packages);

  computeHashFn = ''
    compute_hash() {
      ${sha256sum} | awk '{print $1}'
    }
  '';

  computeWorkspaceStateHash = ''
    compute_workspace_state_hash() {
      {
        cat package.json
        cat pnpm-workspace.yaml
        if [ -f .npmrc ]; then
          cat .npmrc
        fi

        for manifest in ${manifestPaths}; do
          if [ -f "$manifest" ]; then
            cat "$manifest"
          fi
        done

        for workspace_file in ${packageWorkspacePaths}; do
          if [ -f "$workspace_file" ]; then
            cat "$workspace_file"
          fi
        done
      } | compute_hash
    }
  '';

  refreshPackageLockfilesScript = ''
    for path in ${lib.concatMapStringsSep " " (path: ''"${path}"'') packages}; do
      if [ -f "$path/pnpm-workspace.yaml" ]; then
        (
          cd "$path"
          pnpm install --lockfile-only --ignore-scripts --config.confirmModulesPurge=false
        )
      fi
    done
  '';
in
{
  enterShell = lib.mkIf globalCache ''
    export npm_config_cache="$HOME/.cache/pnpm"
    export npm_config_manage_package_manager_versions=false
  '';

  tasks = {
    "pnpm:install" = {
      description = "Install repo-root pnpm workspace and refresh package lockfiles";
      exec = trace.exec "pnpm:install" ''
        set -euo pipefail
        mkdir -p "${cacheRoot}"
        hash_file="${cacheRoot}/workspace.hash"

        lockfile="${cacheRoot}/pnpm-install.lock"
        exec 200>"$lockfile"
        if ! ${flock} -w 600 200; then
          echo "[pnpm] Install lock timeout after 600s: $lockfile" >&2
          echo "[pnpm] Another pnpm install may be stuck; try: dt pnpm:clean && dt pnpm:install" >&2
          exit 1
        fi

        export npm_config_manage_package_manager_versions=false

        if [ -n "''${CI:-}" ] && ${if frozenInCi then "true" else "false"}; then
          pnpm install --config.confirmModulesPurge=false --frozen-lockfile
        elif [ -n "''${CI:-}" ]; then
          pnpm install --config.confirmModulesPurge=false --no-frozen-lockfile
        else
          pnpm install --config.confirmModulesPurge=false
        fi

        ${refreshPackageLockfilesScript}

        ${computeHashFn}
        ${computeWorkspaceStateHash}
        cache_value="$(compute_workspace_state_hash)"
        ${cache.writeCacheFile ''"$hash_file"''}
      '';
      status = trace.status "pnpm:install" "hash" ''
        set -euo pipefail
        hash_file="${cacheRoot}/workspace.hash"

        if [ ! -d node_modules ] || [ ! -f pnpm-lock.yaml ] || [ ! -f "$hash_file" ]; then
          exit 1
        fi

        for path in ${lib.concatMapStringsSep " " (path: ''"${path}"'') packages}; do
          if [ -f "$path/pnpm-workspace.yaml" ] && [ ! -f "$path/pnpm-lock.yaml" ]; then
            exit 1
          fi
        done

        ${computeHashFn}
        ${computeWorkspaceStateHash}
        current_hash="$(compute_workspace_state_hash)"
        stored_hash="$(cat "$hash_file")"
        if [ "$current_hash" != "$stored_hash" ]; then
          exit 1
        fi
        exit 0
      '';
    };

    "pnpm:update" = {
      description = "Update repo-root and package-closure pnpm lockfiles";
      after = [ "genie:run" ];
      exec = trace.exec "pnpm:update" ''
        set -euo pipefail
        export npm_config_manage_package_manager_versions=false
        pnpm install --fix-lockfile --config.confirmModulesPurge=false
        ${lib.replaceStrings [ "--lockfile-only --ignore-scripts" ] [ "--lockfile-only --fix-lockfile --ignore-scripts" ] refreshPackageLockfilesScript}
        echo "Lockfiles updated. Run 'dt nix:hash' to update Nix hashes."
      '';
    };

    "pnpm:clean" = {
      description = "Remove repo-root and package-level node_modules";
      exec = trace.exec "pnpm:clean" ''
        rm -rf "node_modules" ${nodeModulesPaths}
      '';
    };

    "pnpm:reset-lock-files" = {
      description = "Remove repo-root and package-level pnpm lock files (last resort)";
      exec = trace.exec "pnpm:reset-lock-files" ''
        rm -f ${lockFilePaths}
      '';
    };
  };
}
