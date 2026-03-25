# pnpm install tasks
#
# effect-utils now uses a repo-root pnpm workspace for dev installs.
# The repo-root pnpm-lock.yaml is the only authoritative lockfile for this
# live-worktree model.
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
  installAfter ? [ ],
  updateAfter ? [ ],
  cleanAfter ? [ ],
  resetLockFilesAfter ? [ ],
}:
{
  lib,
  config,
  pkgs,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
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
  nodeModulesPaths = lib.concatMapStringsSep " " (path: ''"${path}/node_modules"'') packages;
  lockFilePaths = ''"pnpm-lock.yaml"'';

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

        for injected_dir in ${lib.concatMapStringsSep " " (path: ''"${path}"'') injectedSourcePaths}; do
          emit_dir_state "$injected_dir"
        done
      } | compute_hash
    }
  '';

  allTasks = {
    "pnpm:install" = {
      guard = "pnpm";
      description = "Install the repo-root pnpm workspace from the authoritative root lockfile";
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

        ${computeHashFn}

        # pnpm 11 GVS: hash-based link invalidation. pnpm reuses existing GVS
        # entries without re-resolving packageExtensions, so stale entries break
        # TypeScript resolution. Only clear links/ when config changes.
        # Content-addressable store (files/) is unaffected.
        # See: pnpm/pnpm#9739
        _gvs_hash_file="${cacheRoot}/gvs-links.hash"
        _gvs_hash=$({
          pnpm --version
          sed -n '/^packageExtensions:/,/^[a-zA-Z]/p' pnpm-workspace.yaml 2>/dev/null || true
          sed -n '/^allowBuilds:/,/^[a-zA-Z]/p' pnpm-workspace.yaml 2>/dev/null || true
        } | compute_hash)

        _gvs_links_dir=""
        for _d in \
          "''${PNPM_HOME:-__none__}/store/v11/links" \
          "''${XDG_DATA_HOME:-__none__}/pnpm/store/v11/links" \
          "$HOME/.local/share/pnpm/store/v11/links" \
          "$HOME/Library/pnpm/store/v11/links"; do
          if [ -d "$_d" ] || [ -d "$(dirname "$_d")" ]; then
            _gvs_links_dir="$_d"; break
          fi
        done

        if [ -n "''${_gvs_links_dir:-}" ]; then
          if [ ! -f "$_gvs_hash_file" ] || [ "$(cat "$_gvs_hash_file")" != "$_gvs_hash" ]; then
            echo "[pnpm] GVS config changed, clearing stale links"
            rm -rf "$_gvs_links_dir"
          fi
        fi

        if [ -n "''${CI:-}" ] && ${if frozenInCi then "true" else "false"}; then
          pnpm install --config.confirmModulesPurge=false --frozen-lockfile
        elif [ -n "''${CI:-}" ]; then
          pnpm install --config.confirmModulesPurge=false --no-frozen-lockfile
        else
          pnpm install --config.confirmModulesPurge=false
        fi

        # Persist GVS hash after successful install
        echo "$_gvs_hash" > "$_gvs_hash_file"

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
      guard = "pnpm";
      description = "Update the authoritative repo-root pnpm lockfile";
      after = [ "genie:run" ] ++ updateAfter;
      exec = trace.exec "pnpm:update" ''
        set -euo pipefail
        export npm_config_manage_package_manager_versions=false
        pnpm install --fix-lockfile --config.confirmModulesPurge=false
        echo "Repo-root lockfile updated. Run 'dt nix:hash' to update Nix hashes."
      '';
    };

    "pnpm:clean" = {
      guard = "pnpm";
      description = "Remove repo-root and package-level node_modules";
      after = cleanAfter;
      exec = trace.exec "pnpm:clean" ''
        rm -rf "node_modules" ${nodeModulesPaths}
      '';
    };

    "pnpm:reset-lock-files" = {
      description = "Remove the repo-root pnpm lock file (last resort)";
      after = resetLockFilesAfter;
      exec = trace.exec "pnpm:reset-lock-files" ''
        rm -f ${lockFilePaths}
      '';
    };
  };

in
{
  packages = cliGuard.fromTasks allTasks;

  enterShell = lib.mkIf globalCache ''
    export npm_config_cache="$HOME/.cache/pnpm"
    export npm_config_manage_package_manager_versions=false
  '';

  tasks = cliGuard.stripGuards allTasks;
}
