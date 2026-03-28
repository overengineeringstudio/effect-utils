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
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./pnpm-task-helpers.sh
  );
  nodeModulesProjectionScript = pkgs.writeText "check-node-modules-projection-health.cjs" (
    builtins.readFile ./check-node-modules-projection-health.cjs
  );

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
  healthCheckNodeModulesPaths = lib.concatStringsSep " " ([ ''"node_modules"'' ] ++ (map (path: ''"${path}/node_modules"'') packages));
  lockFilePaths = ''"pnpm-lock.yaml"'';

  loadPnpmTaskHelpersFn = ''
    # Reuse the exact same helper implementations in task execution and shell
    # tests so cleanup refactors cannot silently drift the two code paths apart.
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
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

  computeInstallStateHashFn = ''
    compute_install_state_hash() {
      local workspace_state_hash
      local gvs_links_dir

      workspace_state_hash="$(compute_workspace_state_hash)"
      gvs_links_dir="$(resolve_gvs_links_dir)"

      {
        # Keep version probes non-interactive even when the parent shell has an
        # open stdin pipe, which is common in CI step wrappers.
        printf '%s\n' "$(pnpm --version < /dev/null 2>/dev/null | ${pkgs.coreutils}/bin/head -n1 || echo unknown)"
        printf '%s\n' "$workspace_state_hash"
        printf '%s\n' "''${gvs_links_dir:-}"
      } | compute_hash
    }
  '';
  computeProjectionStateHashFn = ''
    compute_projection_state_hash() {
      # Keep the warm-path fingerprint semantics identical while avoiding the
      # shell pipeline's per-link process overhead. The helper hashes the same
      # ordered line stream that the previous bash implementation produced.
      NODE_MODULES_HELPER_MODE="projection-hash" \
      PNPM_ROOT_MODULES_YAML="node_modules/.modules.yaml" \
      NODE_MODULES_DIRS="$(printf '%s\n' node_modules ${nodeModulesPaths})" \
      ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionScript}
    }
  '';

  runPnpmInstallFn = ''
    run_pnpm_install() {
      if [ -n "''${CI:-}" ] && ${if frozenInCi then "true" else "false"}; then
        pnpm install --config.confirmModulesPurge=false --frozen-lockfile
      elif [ -n "''${CI:-}" ]; then
        pnpm install --config.confirmModulesPurge=false --no-frozen-lockfile
      else
        pnpm install --config.confirmModulesPurge=false
      fi
    }
  '';

  allTasks = {
    "pnpm:install" = {
      guard = "pnpm";
      description = "Install the repo-root pnpm workspace from the authoritative root lockfile";
      after = installAfter;
      exec = trace.exec "pnpm:install" ''
        set -euo pipefail
        ${loadPnpmTaskHelpersFn}
        mkdir -p "${cacheRoot}"
        # This cache tracks the effective install state, not just workspace
        # manifests. The fingerprint also includes the active GVS projection
        # root because pnpm 11 bakes absolute paths into `links/`.
        hash_file="${cacheRoot}/install-state.hash"
        projection_hash_file="${cacheRoot}/projection-state.hash"

        lockfile="${cacheRoot}/pnpm-install.lock"
        exec 200>"$lockfile"
        if ! ${flock} -w 600 200; then
          echo "[pnpm] Install lock timeout after 600s: $lockfile" >&2
          echo "[pnpm] Another pnpm install may be stuck; try: dt pnpm:clean && dt pnpm:install" >&2
          exit 1
        fi

        export npm_config_manage_package_manager_versions=false

        ${computeWorkspaceStateHash}
        ${computeInstallStateHashFn}
        ${computeProjectionStateHashFn}
        ${runPnpmInstallFn}

        # pnpm 11 GVS: hash-based link invalidation. pnpm reuses existing GVS
        # entries without re-resolving packageExtensions, so stale entries break
        # TypeScript resolution. Only clear links/ when config changes.
        # Content-addressable store (files/) is unaffected.
        # See: pnpm/pnpm#9739
        _gvs_hash=$({
          # pnpm 11 keeps the process alive when stdin stays open, which is
          # what GitHub Actions does for long-lived shell steps.
          pnpm --version < /dev/null
          sed -n '/^packageExtensions:/,/^[a-zA-Z]/p' pnpm-workspace.yaml 2>/dev/null || true
          sed -n '/^allowBuilds:/,/^[a-zA-Z]/p' pnpm-workspace.yaml 2>/dev/null || true
        } | compute_hash)

        _gvs_hash_file=""
        _gvs_links_dir="$(resolve_gvs_links_dir)"
        _purged_node_modules=false

        if [ -n "''${_gvs_links_dir:-}" ]; then
          _gvs_hash_file="$(dirname "$_gvs_links_dir")/.effect-utils-gvs-links.hash"
          mkdir -p "$(dirname "$_gvs_links_dir")"
          if [ ! -f "$_gvs_hash_file" ] || [ "$(cat "$_gvs_hash_file")" != "$_gvs_hash" ]; then
            echo "[pnpm] GVS config changed, clearing stale links"
            rm -rf "$_gvs_links_dir"
            purge_node_modules node_modules ${nodeModulesPaths}
            _purged_node_modules=true
          fi
        fi

        if [ "$_purged_node_modules" != true ] && ! check_node_modules_links_healthy ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionScript} ${healthCheckNodeModulesPaths}; then
          echo "[pnpm] node_modules projection is stale, purging install state"
          purge_node_modules node_modules ${nodeModulesPaths}
        fi

        run_pnpm_install

        # Persist GVS hash after successful install
        if [ -n "''${_gvs_hash_file:-}" ]; then
          echo "$_gvs_hash" > "$_gvs_hash_file"
        fi

        cache_value="$(compute_install_state_hash)"
        ${cache.writeCacheFile ''"$hash_file"''}

        cache_value="$(compute_projection_state_hash)"
        ${cache.writeCacheFile ''"$projection_hash_file"''}
      '';
      status = trace.status "pnpm:install" "hash" ''
        set -euo pipefail
        ${loadPnpmTaskHelpersFn}
        hash_file="${cacheRoot}/install-state.hash"
        projection_hash_file="${cacheRoot}/projection-state.hash"

        if [ ! -d node_modules ] || [ ! -f pnpm-lock.yaml ] || [ ! -f "$hash_file" ] || [ ! -f "$projection_hash_file" ] || [ ! -f node_modules/.modules.yaml ]; then
          exit 1
        fi

        if [ "''${DEVENV_SETUP_OUTER_CACHE_HIT:-0}" = "1" ]; then
          ${computeProjectionStateHashFn}
          current_projection_hash="$(compute_projection_state_hash)"
          stored_projection_hash="$(cat "$projection_hash_file")"
          if [ "$current_projection_hash" != "$stored_projection_hash" ]; then
            exit 1
          fi
          exit 0
        fi

        ${computeWorkspaceStateHash}
        ${computeInstallStateHashFn}
        ${computeProjectionStateHashFn}
        current_hash="$(compute_install_state_hash)"
        current_projection_hash="$(compute_projection_state_hash)"
        stored_hash="$(cat "$hash_file")"
        stored_projection_hash="$(cat "$projection_hash_file")"
        if [ "$current_hash" != "$stored_hash" ]; then
          exit 1
        fi
        if [ "$current_projection_hash" != "$stored_projection_hash" ]; then
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
        set -euo pipefail
        ${loadPnpmTaskHelpersFn}

        purge_node_modules node_modules ${nodeModulesPaths}

        # `pnpm:clean` is expected to force a genuinely fresh install. Keeping
        # the live GVS projection around defeats that expectation because pnpm
        # may reuse stale `links/` entries even after node_modules is gone.
        gvs_links_dir="$(resolve_gvs_links_dir)"
        if [ -n "''${gvs_links_dir:-}" ]; then
          rm -rf "$gvs_links_dir" "$(dirname "$gvs_links_dir")/.effect-utils-gvs-links.hash"
        fi
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
