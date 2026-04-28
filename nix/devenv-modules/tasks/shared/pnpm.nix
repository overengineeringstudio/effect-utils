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
  workspaceRoot ? ".",
  taskNamePrefix ? "pnpm",
  taskSuffix ? null,
  globalCache ? true,
  frozenInCi ? true,
  installFlags ? [ ],
  preInstall ? "",
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
  workspaceCacheName =
    if workspaceRoot == "." then
      "root"
    else
      builtins.replaceStrings [ "/" "." ] [ "-" "_" ] workspaceRoot;
  cacheRoot =
    if workspaceRoot == "." then
      cache.mkCachePath "pnpm-install"
    else
      cache.mkCachePath "pnpm-install/${workspaceCacheName}";
  workspaceRootAbs =
    if workspaceRoot == "." then config.devenv.root else "${config.devenv.root}/${workspaceRoot}";
  defaultPnpmHome =
    if workspaceRoot == "." then
      "${config.devenv.root}/.direnv/pnpm-home"
    else
      "${config.devenv.root}/.direnv/pnpm-home/${workspaceCacheName}";
  defaultPnpmStoreDir = "${config.devenv.root}/.direnv/pnpm-store";
  installTaskName =
    if taskSuffix == null then
      "${taskNamePrefix}:install"
    else
      "${taskNamePrefix}:install:${taskSuffix}";
  updateTaskName =
    if taskSuffix == null then "${taskNamePrefix}:update" else "${taskNamePrefix}:update:${taskSuffix}";
  cleanTaskName =
    if taskSuffix == null then "${taskNamePrefix}:clean" else "${taskNamePrefix}:clean:${taskSuffix}";
  resetLockFilesTaskName =
    if taskSuffix == null then
      "${taskNamePrefix}:reset-lock-files"
    else
      "${taskNamePrefix}:reset-lock-files:${taskSuffix}";
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./pnpm-task-helpers.sh
  );
  nodeModulesProjectionHealthScript = pkgs.writeText "check-node-modules-projection-health.cjs" (
    builtins.readFile ./check-node-modules-projection-health.cjs
  );

  flock = "${pkgs.flock}/bin/flock";
  installFlagsString = lib.escapeShellArgs installFlags;

  packageNameToPath = builtins.listToAttrs (
    builtins.filter (x: x != null) (
      map (
        path:
        let
          pkgJsonPath = "${workspaceRootAbs}/${path}/package.json";
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
      pkgJsonPath = "${workspaceRootAbs}/${path}/package.json";
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
  healthCheckNodeModulesPaths = lib.concatStringsSep " " (
    [ ''"node_modules"'' ] ++ (map (path: ''"${path}/node_modules"'') packages)
  );
  lockFilePaths = ''"pnpm-lock.yaml"'';

  loadPnpmTaskHelpersFn = ''
    # Reuse the exact same helper implementations in task execution and shell
    # tests so cleanup refactors cannot silently drift the two code paths apart.
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
  '';
  ensureLocalPnpmHomeFn = ''
    # Keep pnpm's hot GVS projection workspace-local by default so local tasks
    # match CI and don't inherit stale global link state from unrelated repos.
    if [ ${lib.escapeShellArg workspaceRoot} = "." ]; then
      if [ -z "''${PNPM_HOME:-}" ]; then
        export PNPM_HOME=${lib.escapeShellArg defaultPnpmHome}
      fi
    elif [ -z "''${PNPM_HOME:-}" ]; then
      export PNPM_HOME=${lib.escapeShellArg defaultPnpmHome}
    else
      case "$PNPM_HOME" in
        */${workspaceCacheName}) ;;
        *) export PNPM_HOME="$PNPM_HOME/${workspaceCacheName}" ;;
      esac
    fi
  '';
  ensureLocalPnpmStoreDirFn = ''
    if [ -n "''${npm_config_store_dir:-}" ]; then
      export PNPM_STORE_DIR="''${PNPM_STORE_DIR:-$npm_config_store_dir}"
    elif [ -n "''${PNPM_STORE_DIR:-}" ]; then
      export npm_config_store_dir="$PNPM_STORE_DIR"
    else
      export PNPM_STORE_DIR=${lib.escapeShellArg defaultPnpmStoreDir}
      export npm_config_store_dir="$PNPM_STORE_DIR"
    fi
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
        printf '%s\n' "$workspace_state_hash"
        printf '%s\n' "''${gvs_links_dir:-}"
        printf '%s\n' ${lib.escapeShellArg (builtins.toJSON installFlags)}
        printf '%s\n' ${lib.escapeShellArg preInstall}
      } | compute_hash
    }
  '';

  runPnpmInstallFn = ''
    run_pnpm_install() {
      local extra_install_args=("$@")
      local install_args
      if [ -n "''${CI:-}" ] && ${if frozenInCi then "true" else "false"}; then
        install_args=(install --config.confirmModulesPurge=false --config.store-dir="$npm_config_store_dir" "''${extra_install_args[@]}" --frozen-lockfile ${installFlagsString})
      elif [ -n "''${CI:-}" ]; then
        install_args=(install --config.confirmModulesPurge=false --config.store-dir="$npm_config_store_dir" "''${extra_install_args[@]}" --no-frozen-lockfile ${installFlagsString})
      else
        install_args=(install --config.confirmModulesPurge=false --config.store-dir="$npm_config_store_dir" "''${extra_install_args[@]}" ${installFlagsString})
      fi

      if [ -z "''${CI:-}" ]; then
        pnpm "''${install_args[@]}"
        return
      fi

      local diagnostics_dir
      diagnostics_dir="''${CI_DIAGNOSTICS_DIR:-${cacheRoot}/diagnostics}"
      mkdir -p "$diagnostics_dir"

      local log_file
      log_file="$diagnostics_dir/pnpm-install.log"

      echo "[pnpm] Running install; full log: $log_file"
      local rc
      set +e
      pnpm "''${install_args[@]}" > "$log_file" 2>&1
      rc="$?"
      set -e
      if [ "$rc" -eq 0 ]; then
        return
      fi

      local classification="pnpm install failure"
      local evidence=""

      if grep -Eq 'ERR_PNPM_(META_)?FETCH_FAIL|Socket timeout|request to .* failed|fetch.*failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN' "$log_file"; then
        classification="registry/network fetch failure"
        evidence="$(grep -Em1 'ERR_PNPM_(META_)?FETCH_FAIL|Socket timeout|request to .* failed|fetch.*failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN' "$log_file" || true)"
      elif grep -Eq 'ERR_PNPM_WORKSPACE_PKG_NOT_FOUND' "$log_file"; then
        classification="workspace package mismatch"
        evidence="$(grep -Em1 'ERR_PNPM_WORKSPACE_PKG_NOT_FOUND' "$log_file" || true)"
      fi

      if [ -n "''${GITHUB_ACTIONS:-}" ]; then
        echo "::group::pnpm install failure diagnostics"
      fi

      echo "[pnpm] Install failed: $classification" >&2
      echo "[pnpm] Workspace: ${lib.escapeShellArg workspaceRootAbs}" >&2
      echo "[pnpm] Log: $log_file" >&2
      if [ -n "$evidence" ]; then
        echo "[pnpm] Evidence: $evidence" >&2
      fi
      echo "[pnpm] Last 120 log lines:" >&2
      tail -120 "$log_file" >&2 || true

      if [ -n "''${GITHUB_STEP_SUMMARY:-}" ]; then
        {
          echo "### pnpm install failed"
          echo ""
          echo "- Classification: $classification"
          if [ -n "$evidence" ]; then
            echo "- Evidence: \`$evidence\`"
          fi
          echo "- Log artifact: \`$log_file\`"
        } >> "$GITHUB_STEP_SUMMARY"
      fi

      if [ -n "''${GITHUB_ACTIONS:-}" ]; then
        echo "::endgroup::"
      fi

      return "$rc"
    }
  '';

  allTasks = {
    "${installTaskName}" = {
      guard = "pnpm";
      description = "Install the pnpm workspace at ${workspaceRoot} from its authoritative lockfile";
      after = installAfter;
      exec = trace.exec installTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${loadPnpmTaskHelpersFn}
        ${ensureLocalPnpmHomeFn}
        ${ensureLocalPnpmStoreDirFn}
        mkdir -p "${cacheRoot}"
        # This cache tracks the effective install state, not just workspace
        # manifests. The fingerprint also includes the active GVS projection
        # root because pnpm 11 bakes absolute paths into `links/`.
        hash_file="${cacheRoot}/install-state.hash"

        lockfile="${cacheRoot}/pnpm-install.lock"
        exec 200>"$lockfile"
        if ! ${flock} -w 600 200; then
          echo "[pnpm] Install lock timeout after 600s: $lockfile" >&2
          echo "[pnpm] Another pnpm install may be stuck; try: dt pnpm:clean && dt pnpm:install" >&2
          exit 1
        fi

        pnpm_home_lockfile="''${PNPM_HOME:-${cacheRoot}}/.effect-utils-pnpm-install.lock"
        mkdir -p "$(dirname "$pnpm_home_lockfile")"
        exec 201>"$pnpm_home_lockfile"
        if ! ${flock} -w 600 201; then
          echo "[pnpm] PNPM_HOME lock timeout after 600s: $pnpm_home_lockfile" >&2
          echo "[pnpm] Another pnpm install sharing this PNPM_HOME may be stuck" >&2
          exit 1
        fi

        pnpm_store_lockfile="''${npm_config_store_dir:-${cacheRoot}}/.effect-utils-pnpm-store.lock"
        mkdir -p "$(dirname "$pnpm_store_lockfile")"
        exec 202>"$pnpm_store_lockfile"
        if ! ${flock} -w 600 202; then
          echo "[pnpm] store-dir lock timeout after 600s: $pnpm_store_lockfile" >&2
          echo "[pnpm] Another pnpm install sharing this store-dir may be stuck" >&2
          exit 1
        fi

        export npm_config_manage_package_manager_versions=false

        ${computeWorkspaceStateHash}
        ${computeInstallStateHashFn}
        ${preInstall}
        ${runPnpmInstallFn}

        # pnpm 11 GVS: hash-based link invalidation. pnpm reuses existing GVS
        # entries without re-resolving packageExtensions, so stale entries break
        # TypeScript resolution. Only clear links/ when config changes.
        # Content-addressable store (files/) is unaffected.
        # See: pnpm/pnpm#9739
        _gvs_hash=$({
          # Hash the resolved pnpm package version directly instead of probing
          # the CLI at runtime. That keeps the task deterministic and avoids
          # trace-wrapper quoting hazards around command rewriting.
          printf '%s\n' ${lib.escapeShellArg pkgs.pnpm.version}
          sed -n '/^packageExtensions:/,/^[a-zA-Z]/p' pnpm-workspace.yaml 2>/dev/null || true
          sed -n '/^allowBuilds:/,/^[a-zA-Z]/p' pnpm-workspace.yaml 2>/dev/null || true
        } | compute_hash)

        _gvs_hash_file=""
        _gvs_links_dir="$(resolve_gvs_links_dir)"
        _purged_node_modules=false
        _force_install=false

        if [ -n "''${_gvs_links_dir:-}" ]; then
          _gvs_hash_file="$(dirname "$_gvs_links_dir")/.effect-utils-gvs-links.hash"
          mkdir -p "$(dirname "$_gvs_links_dir")"
          if [ ! -f "$_gvs_hash_file" ] || [ "$(cat "$_gvs_hash_file")" != "$_gvs_hash" ]; then
            echo "[pnpm] GVS config changed, forcing current workspace relink"
            purge_node_modules node_modules ${nodeModulesPaths}
            rm -rf "$_gvs_links_dir"
            _purged_node_modules=true
            _force_install=true
          fi
        fi

        if [ "$_purged_node_modules" != true ] && ! check_node_modules_links_healthy ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionHealthScript} ${healthCheckNodeModulesPaths}; then
          echo "[pnpm] node_modules projection is stale, purging install state"
          purge_node_modules node_modules ${nodeModulesPaths}
          if [ -n "''${_gvs_links_dir:-}" ]; then
            rm -rf "$_gvs_links_dir"
          fi
          _force_install=true
        fi

        if [ "$_force_install" = true ]; then
          run_pnpm_install --force
        else
          run_pnpm_install
        fi

        if ! check_node_modules_links_healthy ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionHealthScript} ${healthCheckNodeModulesPaths}; then
          echo "[pnpm] node_modules projection is still unhealthy after install" >&2
          exit 1
        fi

        # Persist GVS hash after successful install
        if [ -n "''${_gvs_hash_file:-}" ]; then
          echo "$_gvs_hash" > "$_gvs_hash_file"
        fi

        cache_value="$(compute_install_state_hash)"
        ${cache.writeCacheFile ''"$hash_file"''}
      '';
      status = trace.status installTaskName "hash" ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${loadPnpmTaskHelpersFn}
        ${ensureLocalPnpmHomeFn}
        ${ensureLocalPnpmStoreDirFn}
        hash_file="${cacheRoot}/install-state.hash"

        if [ ! -d node_modules ] || [ ! -f pnpm-lock.yaml ] || [ ! -f "$hash_file" ]; then
          exit 1
        fi

        ${computeWorkspaceStateHash}
        ${computeInstallStateHashFn}
        current_hash="$(compute_install_state_hash)"
        stored_hash="$(cat "$hash_file")"
        if ! check_node_modules_links_healthy ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionHealthScript} ${healthCheckNodeModulesPaths}; then
          exit 1
        fi
        if [ "$current_hash" != "$stored_hash" ]; then
          exit 1
        fi
        exit 0
      '';
    };

    "${updateTaskName}" = {
      guard = "pnpm";
      description = "Update the authoritative pnpm lockfile at ${workspaceRoot}";
      after = (if workspaceRoot == "." then [ "genie:run" ] else [ ]) ++ updateAfter;
      exec = trace.exec updateTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${loadPnpmTaskHelpersFn}
        ${ensureLocalPnpmHomeFn}
        ${ensureLocalPnpmStoreDirFn}
        export npm_config_manage_package_manager_versions=false
        pnpm install --fix-lockfile --config.confirmModulesPurge=false --config.store-dir="$npm_config_store_dir"
        echo "Repo-root lockfile updated. Run 'dt nix:hash' to update Nix hashes."
      '';
    };

    "${cleanTaskName}" = {
      guard = "pnpm";
      description = "Remove node_modules for the pnpm workspace at ${workspaceRoot}";
      after = cleanAfter;
      exec = trace.exec cleanTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${loadPnpmTaskHelpersFn}
        ${ensureLocalPnpmHomeFn}
        ${ensureLocalPnpmStoreDirFn}

        purge_node_modules node_modules ${nodeModulesPaths}

        # The GVS `links/` directory lives under the shared store-dir. Deleting
        # it from one workspace would break node_modules projections in other
        # workspaces that point at the same shared store.
      '';
    };

    "${resetLockFilesTaskName}" = {
      description = "Remove the pnpm lock file at ${workspaceRoot} (last resort)";
      after = resetLockFilesAfter;
      exec = trace.exec resetLockFilesTaskName ''
        cd ${lib.escapeShellArg workspaceRootAbs}
        rm -f ${lockFilePaths}
      '';
    };
  };

in
{
  packages = cliGuard.fromTasks allTasks;

  enterShell = lib.mkIf (globalCache && workspaceRoot == ".") ''
    export PNPM_HOME="''${PNPM_HOME:-${config.devenv.root}/.direnv/pnpm-home}"
    export PNPM_STORE_DIR="''${PNPM_STORE_DIR:-${defaultPnpmStoreDir}}"
    export npm_config_store_dir="''${npm_config_store_dir:-$PNPM_STORE_DIR}"
    export npm_config_cache="$HOME/.cache/pnpm"
    export npm_config_manage_package_manager_versions=false
  '';

  tasks = cliGuard.stripGuards allTasks;
}
