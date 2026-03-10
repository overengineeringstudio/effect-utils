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
  installAfter ? [],
  updateAfter ? [],
  cleanAfter ? [],
  resetLockFilesAfter ? [],
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

  packageNameToPath = builtins.listToAttrs (
    builtins.filter (x: x != null) (
      map (
        path:
        let
          pkgJsonPath = "${config.devenv.root}/${path}/package.json";
          pkgJsonExists = builtins.pathExists pkgJsonPath;
          pkgJson = if pkgJsonExists then builtins.fromJSON (builtins.readFile pkgJsonPath) else { };
          name = pkgJson.name or null;
        in
        if name != null then
          {
            inherit name;
            value = path;
          }
        else
          null
      ) packages
    )
  );

  getInjectedDeps =
    path:
    let
      pkgJsonPath = "${config.devenv.root}/${path}/package.json";
      pkgJsonExists = builtins.pathExists pkgJsonPath;
      pkgJson = if pkgJsonExists then builtins.fromJSON (builtins.readFile pkgJsonPath) else { };
      depsMeta = pkgJson.dependenciesMeta or { };
      injectedNames = builtins.filter (name: (depsMeta.${name}.injected or false) == true) (
        builtins.attrNames depsMeta
      );
    in
    builtins.filter (p: p != null) (map (name: packageNameToPath.${name} or null) injectedNames);

  injectedSourcePaths = lib.unique (lib.concatMap getInjectedDeps packages);

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

  emitDirStateFn = ''
    emit_dir_state() {
      local dir="$1"

      if [ ! -d "$dir" ]; then
        return
      fi

      find "$dir" \
        \( \
          -name .git -o \
          -name .direnv -o \
          -name .devenv -o \
          -name .turbo -o \
          -name .cache -o \
          -name node_modules -o \
          -name dist -o \
          -name coverage -o \
          -name result -o \
          -name tmp \
        \) -prune -o -type f -print \
        | LC_ALL=C sort \
        | while IFS= read -r file; do
          printf '%s ' "''${file#"$dir"/}"
          ${sha256sum} "$file" | awk '{print $1}'
        done
    }
  '';

  computeWorkspaceStateHash = ''
    compute_workspace_state_hash() {
      {
        cat package.json
        cat pnpm-workspace.yaml
        cat pnpm-lock.yaml
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

        for injected_dir in ${lib.concatMapStringsSep " " (path: ''"${path}"'') injectedSourcePaths}; do
          emit_dir_state "$injected_dir"
        done
      } | compute_hash
    }
  '';

  refreshPackageLockfilesScript = ''
    for path in ${lib.concatMapStringsSep " " (path: ''"${path}"'') packages}; do
      if [ -f "$path/pnpm-workspace.yaml" ]; then
        (
          cd "$path"
          if [ -n "''${CI:-}" ] && ${if frozenInCi then "true" else "false"}; then
            pnpm install --lockfile-only --ignore-scripts --frozen-lockfile --config.confirmModulesPurge=false
          else
            pnpm install --lockfile-only --ignore-scripts --config.confirmModulesPurge=false
          fi
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
      after = installAfter;
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
        ${emitDirStateFn}
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
        ${emitDirStateFn}
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
      after = [ "genie:run" ] ++ updateAfter;
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
      after = cleanAfter;
      exec = trace.exec "pnpm:clean" ''
        rm -rf "node_modules" ${nodeModulesPaths}
      '';
    };

    "pnpm:reset-lock-files" = {
      description = "Remove repo-root and package-level pnpm lock files (last resort)";
      after = resetLockFilesAfter;
      exec = trace.exec "pnpm:reset-lock-files" ''
        rm -f ${lockFilePaths}
      '';
    };
  };
}
