# pnpm install tasks
#
# effect-utils now uses a repo-root pnpm workspace for dev installs.
# The repo-root pnpm-lock.yaml is the only authoritative lockfile for this
# live-worktree model.
#
# Provides:
# - pnpm:install
# - pnpm:update
# - pnpm:dedupe
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
  dedupeAfter ? [ ],
  cleanAfter ? [ ],
  resetLockFilesAfter ? [ ],
  # Real derivation/path backing the `pnpm` guard. When set, the guard owns
  # `bin/pnpm` and exec's this by absolute path under passthrough (see
  # cli-guard.nix).
  pnpmPkg ? null,
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
      "${config.devenv.root}/.devenv/pnpm-home"
    else
      "${config.devenv.root}/.devenv/pnpm-home/${workspaceCacheName}";
  defaultPnpmStoreDir =
    if workspaceRoot == "." then
      "${config.devenv.root}/.devenv/pnpm-store-pure-v1"
    else
      "${config.devenv.root}/.devenv/pnpm-store-pure-v1/${workspaceCacheName}";
  installTaskName =
    if taskSuffix == null then
      "${taskNamePrefix}:install"
    else
      "${taskNamePrefix}:install:${taskSuffix}";
  updateTaskName =
    if taskSuffix == null then "${taskNamePrefix}:update" else "${taskNamePrefix}:update:${taskSuffix}";
  dedupeTaskName =
    if taskSuffix == null then "${taskNamePrefix}:dedupe" else "${taskNamePrefix}:dedupe:${taskSuffix}";
  cleanTaskName =
    if taskSuffix == null then "${taskNamePrefix}:clean" else "${taskNamePrefix}:clean:${taskSuffix}";
  doctorTaskName =
    if taskSuffix == null then "${taskNamePrefix}:doctor" else "${taskNamePrefix}:doctor:${taskSuffix}";
  repairTaskName =
    if taskSuffix == null then "${taskNamePrefix}:repair" else "${taskNamePrefix}:repair:${taskSuffix}";
  resetLockFilesTaskName =
    if taskSuffix == null then
      "${taskNamePrefix}:reset-lock-files"
    else
      "${taskNamePrefix}:reset-lock-files:${taskSuffix}";
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./pnpm-task-helpers.sh
  );
  nodeModulesProjectionScript = pkgs.writeText "check-node-modules-projection-health.cjs" (
    builtins.readFile ./check-node-modules-projection-health.cjs
  );
  pnpmInstallPolicy = import ../../../workspace-tools/lib/pnpm-install-policy.nix { inherit lib; };

  flock = "${pkgs.flock}/bin/flock";
  installFlagsString = lib.escapeShellArgs installFlags;
  pureInstallFlags = [
    (if frozenInCi then "--frozen-lockfile" else "--no-frozen-lockfile")
  ]
  ++ pnpmInstallPolicy.liveInstallPolicyFlags;
  pureInstallFlagsString = lib.concatStringsSep " " pureInstallFlags;

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
  packageNodeModulesPaths = map (
    path: if path == "." then "node_modules" else "${path}/node_modules"
  ) packages;
  nodeModulesPaths = lib.concatMapStringsSep " " lib.escapeShellArg packageNodeModulesPaths;
  healthCheckNodeModulesPaths = lib.concatStringsSep " " (
    map lib.escapeShellArg (lib.unique ([ "node_modules" ] ++ packageNodeModulesPaths))
  );
  lockFilePaths = ''"pnpm-lock.yaml"'';

  loadPnpmTaskHelpersFn = ''
    # Reuse the exact same helper implementations in task execution and shell
    # tests so cleanup refactors cannot silently drift the two code paths apart.
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
  '';
  ensureLocalPnpmHomeFn = ''
    # Keep package-manager state workspace-local. Only immutable content bytes
    # are shared across Materialization Roots.
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
    _pnpm_store_dir="''${npm_config_store_dir:-''${PNPM_CONFIG_STORE_DIR:-''${PNPM_STORE_DIR:-}}}"
    if [ ${lib.escapeShellArg workspaceRoot} != "." ] && [ -n "$_pnpm_store_dir" ]; then
      case "$_pnpm_store_dir" in
        */${workspaceCacheName}) ;;
        *) _pnpm_store_dir="$_pnpm_store_dir/${workspaceCacheName}" ;;
      esac
    elif [ -n "$_pnpm_store_dir" ]; then
      :
    else
      _pnpm_store_dir=${lib.escapeShellArg defaultPnpmStoreDir}
    fi
    export PNPM_STORE_DIR="$_pnpm_store_dir"
    export PNPM_CONFIG_STORE_DIR="$_pnpm_store_dir"
    export npm_config_store_dir="$_pnpm_store_dir"
    unset _pnpm_store_dir
  '';
  ensureSharedPnpmFilesStoreFn = ''
    ensure_shared_pnpm_files_store() {
      if [ -n "''${CI:-}" ]; then
        return 0
      fi
      if [ -z "''${npm_config_store_dir:-}" ]; then
        echo "[pnpm] npm_config_store_dir is empty; cannot prepare split store" >&2
        exit 1
      fi

      local store_version_dir
      local files_path
      local shared_files_path
      store_version_dir="''${npm_config_store_dir}/v11"
      files_path="$store_version_dir/files"
      shared_files_path="''${PNPM_SHARED_FILES_DIR:-$HOME/.local/share/pnpm/shared-files}/v11"

      mkdir -p "$store_version_dir" "$shared_files_path"

      if [ -L "$files_path" ]; then
        if [ "$(readlink "$files_path")" != "$shared_files_path" ]; then
          echo "[pnpm] $files_path points at $(readlink "$files_path"), expected $shared_files_path" >&2
          exit 1
        fi
        return 0
      fi

      if [ -e "$files_path" ]; then
        if [ -d "$files_path" ] && [ -z "$(find "$files_path" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
          rmdir "$files_path"
        else
          echo "[pnpm] Refusing to replace non-empty legacy root-local content: $files_path" >&2
          echo "[pnpm] One-time clean break required: archive or remove that directory explicitly, then rerun: devenv tasks run ${installTaskName}" >&2
          exit 1
        fi
      fi

      ln -s "$shared_files_path" "$files_path"
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

  computeInstallStateHashFn = ''
    compute_install_state_hash() {
      local workspace_state_hash
      workspace_state_hash="$(compute_workspace_state_hash)"

      {
        printf '%s\n' ${lib.escapeShellArg pkgs.pnpm.version}
        printf '%s\n' "$workspace_state_hash"
        printf '%s\n' ${lib.escapeShellArg (builtins.toJSON installFlags)}
        printf '%s\n' ${lib.escapeShellArg preInstall}
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
    reject_impure_pnpm_install_args() {
      local arg
      for arg in "$@"; do
        case "$arg" in
          --no-frozen-lockfile | --frozen-lockfile=false | \
          --fix-lockfile | --lockfile-only | --no-lockfile | \
          --config.frozen-lockfile=false | --config.frozen-lockfile | \
          --no-ignore-scripts | --ignore-scripts=false | \
          --config.ignore-scripts=false | --config.ignore-scripts | \
          --config.ignore-dep-scripts=false | --config.ignore-dep-scripts | \
          --config.side-effects-cache=true | --config.side-effects-cache | --side-effects-cache | \
          --side-effects-cache-readonly | --config.side-effects-cache-readonly=true | --config.side-effects-cache-readonly | \
          --no-verify-store-integrity | --verify-store-integrity=false | \
          --config.verify-store-integrity=false | --config.verify-store-integrity | \
          --strict-store-pkg-content-check=false | --no-strict-store-pkg-content-check | \
          --config.strict-store-pkg-content-check=false | --config.strict-store-pkg-content-check | \
          --config.manage-package-manager-versions=true | --config.manage-package-manager-versions | \
          --config.enable-global-virtual-store=true | --enable-global-virtual-store | \
          --config.global-virtual-store-dir=* | --config.global-virtual-store-dir | \
          --global-virtual-store-dir=* | --global-virtual-store-dir | \
          --config.virtual-store-dir=* | --config.virtual-store-dir | \
          --virtual-store-dir=* | --virtual-store-dir | \
          --pm-on-fail=* | --pm-on-fail | --config.pm-on-fail=* | --config.pm-on-fail | \
          --config.package-import-method=* | --config.package-import-method | --package-import-method=* | --package-import-method | \
          --config.store-dir=* | --config.store-dir | --store-dir=* | --store-dir)
            echo "[pnpm] Refusing impure install argument: $arg" >&2
            exit 1
            ;;
        esac
      done
    }

    run_pnpm_install() {
      local install_args
      reject_impure_pnpm_install_args "$@" ${installFlagsString}
      install_args=(install "$@" ${installFlagsString} ${pureInstallFlagsString} "--config.store-dir=$npm_config_store_dir")

      ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
        if [ -n "''${CI:-}" ]; then
          ${pnpmInstallPolicy.darwinNodeOptionsShell}
        fi
      ''}

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
      ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
        # GitHub-hosted macOS runners can kill pnpm after APFS materialization
        # has completed. Bound the node heap like the fixed-output builder does
        # so teardown pressure does not fail otherwise-complete installs.
        export NODE_OPTIONS="''${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=1536"
      ''}
      pnpm "''${install_args[@]}" > "$log_file" 2>&1
      rc="$?"
      set -e
      if [ "$rc" -eq 0 ]; then
        return
      fi

      ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
        if ${
          pnpmInstallPolicy.darwinCompletedMaterializationCheckShell {
            statusVar = "rc";
            logFileVar = "log_file";
          }
        }; then
          echo "[pnpm] Install completed materialization before darwin install teardown; continuing after node teardown exit $rc" >&2
          return
        fi
      ''}

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
      echo "[pnpm] Exit code: $rc" >&2
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
          echo "- Exit code: $rc"
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
        ${ensureSharedPnpmFilesStoreFn}
        ensure_shared_pnpm_files_store
        mkdir -p "${cacheRoot}"
        # This cache tracks the effective install state, not just workspace
        # manifests. The virtual dependency graph itself is root-local.
        hash_file="${cacheRoot}/install-state.hash"
        projection_hash_file="${cacheRoot}/projection-state.hash"
        contract_state_file="${cacheRoot}/pnpm-install-contract.json"

        lockfile="${cacheRoot}/pnpm-install.lock"
        exec 200>"$lockfile"
        if ! ${flock} -w 600 200; then
          echo "[pnpm] Install lock timeout after 600s: $lockfile" >&2
          echo "[pnpm] Another pnpm install may be stuck; try: devenv tasks run pnpm:clean && devenv tasks run pnpm:install" >&2
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

        ${computeWorkspaceStateHash}
        ${computeInstallStateHashFn}
        ${computeProjectionStateHashFn}
        ${preInstall}
        ${runPnpmInstallFn}

        _pnpm_install_contract_file="$(resolve_pnpm_install_contract_file "$PWD" || true)"
        if [ -z "''${_pnpm_install_contract_file:-}" ]; then
          ${lib.optionalString (workspaceRoot == ".") ''
            echo "[pnpm] Missing generated pnpm-install-contract.json at repo root" >&2
            echo "[pnpm] Run: devenv tasks run genie:run" >&2
            exit 1
          ''}
          : # A nested downstream root may not emit profile evidence yet.
        fi

        _force_install=false

        if ! check_node_modules_links_healthy ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionScript} ${healthCheckNodeModulesPaths}; then
          echo "[pnpm] node_modules projection is stale, purging install state"
          purge_node_modules node_modules ${nodeModulesPaths}
          _force_install=true
        fi

        if [ "$_force_install" = true ]; then
          run_pnpm_install --force
        else
          run_pnpm_install
        fi

        if ! check_node_modules_links_healthy ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionScript} ${healthCheckNodeModulesPaths}; then
          echo "[pnpm] node_modules projection is still unhealthy after install" >&2
          exit 1
        fi

        if [ -n "''${_pnpm_install_contract_file:-}" ]; then
          rm -f "$contract_state_file"
          cp "$_pnpm_install_contract_file" "$contract_state_file"
          chmod u+w "$contract_state_file" 2>/dev/null || true
        fi

        cache_value="$(compute_install_state_hash)"
        ${cache.writeCacheFile ''"$hash_file"''}

        cache_value="$(compute_projection_state_hash)"
        ${cache.writeCacheFile ''"$projection_hash_file"''}
      '';
      status = trace.status installTaskName "hash" ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${loadPnpmTaskHelpersFn}
        ${ensureLocalPnpmHomeFn}
        ${ensureLocalPnpmStoreDirFn}
        ${ensureSharedPnpmFilesStoreFn}
        ensure_shared_pnpm_files_store
        hash_file="${cacheRoot}/install-state.hash"
        projection_hash_file="${cacheRoot}/projection-state.hash"
        contract_state_file="${cacheRoot}/pnpm-install-contract.json"

        _pnpm_install_contract_file="$(resolve_pnpm_install_contract_file "$PWD" || true)"
        if [ -z "''${_pnpm_install_contract_file:-}" ]; then
          ${lib.optionalString (workspaceRoot == ".") ''
            echo "[pnpm] Missing generated pnpm-install-contract.json at repo root" >&2
            echo "[pnpm] Run: devenv tasks run genie:run" >&2
          ''}
          emit_pnpm_install_miss_span ${lib.escapeShellArg installTaskName} "contract_missing"
          exit 1
        fi

        if [ ! -d node_modules ] || [ ! -f pnpm-lock.yaml ] || [ ! -f "$hash_file" ] || [ ! -f "$projection_hash_file" ] || [ ! -f node_modules/.modules.yaml ]; then
          emit_pnpm_install_miss_span ${lib.escapeShellArg installTaskName} "bootstrap"
          exit 1
        fi

        if [ "''${DEVENV_SETUP_OUTER_CACHE_HIT:-0}" = "1" ]; then
          # The stored projection digest was written only after the full health
          # oracle passed. Compare the complete realization evidence instead of
          # repeating module resolution for every cached downstream task.
          ${computeProjectionStateHashFn}
          current_projection_hash="$(compute_projection_state_hash)"
          stored_projection_hash="$(cat "$projection_hash_file")"
          if [ "$current_projection_hash" != "$stored_projection_hash" ]; then
            emit_pnpm_install_miss_span ${lib.escapeShellArg installTaskName} "projection"
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
          if [ -f "$contract_state_file" ]; then
            _miss_reason="$(classify_pnpm_contract_change ${pkgs.nodejs}/bin/node "$contract_state_file" "$_pnpm_install_contract_file" || printf '%s\n' unknown)"
          else
            _miss_reason="unknown"
          fi
          emit_pnpm_install_miss_span ${lib.escapeShellArg installTaskName} "$_miss_reason"
          exit 1
        fi
        if [ "$current_projection_hash" != "$stored_projection_hash" ]; then
          emit_pnpm_install_miss_span ${lib.escapeShellArg installTaskName} "projection"
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
        ${ensureSharedPnpmFilesStoreFn}
        ensure_shared_pnpm_files_store
        pnpm install --fix-lockfile --config.confirmModulesPurge=false --pm-on-fail=ignore --config.store-dir="$npm_config_store_dir"
        echo "Repo-root lockfile updated. Refresh Nix FOD hashes with the repo workflow."
      '';
    };

    "${dedupeTaskName}" = {
      guard = "pnpm";
      # Remediation counterpart to the catalog duplicate-version gate (genie:check):
      # collapse in-range duplicate versions onto the newest satisfying release.
      # Upstream-locked duplicates that cannot be collapsed stay and must be
      # acknowledged via catalogDuplicateExceptions.
      description = "Collapse in-range duplicate versions in the pnpm lockfile at ${workspaceRoot}";
      after = (if workspaceRoot == "." then [ "genie:run" ] else [ ]) ++ dedupeAfter;
      exec = trace.exec dedupeTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${loadPnpmTaskHelpersFn}
        ${ensureLocalPnpmHomeFn}
        ${ensureLocalPnpmStoreDirFn}
        ${ensureSharedPnpmFilesStoreFn}
        ensure_shared_pnpm_files_store
        pnpm dedupe --config.confirmModulesPurge=false --pm-on-fail=ignore --config.store-dir="$npm_config_store_dir"
        echo "Lockfile deduped. Re-run genie:check to verify the catalog duplicate gate; bless any upstream-locked residuals via catalogDuplicateExceptions."
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
        ${ensureSharedPnpmFilesStoreFn}
        ensure_shared_pnpm_files_store

        purge_node_modules node_modules ${nodeModulesPaths}
      '';
    };

    "${doctorTaskName}" = {
      guard = "pnpm";
      description = "Inspect existing dependency materialization evidence for the pnpm workspace at ${workspaceRoot}";
      exec = trace.exec doctorTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${loadPnpmTaskHelpersFn}

        if [ -d node_modules/.pnpm ] && check_node_modules_links_healthy ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionScript} ${healthCheckNodeModulesPaths}; then
          doctor_decision="healthy"
          doctor_reason="root-local-graph-healthy"
        else
          doctor_decision="repair-root"
          doctor_reason="root-local-graph-unhealthy"
        fi
        ${pkgs.nodejs}/bin/node - "$PWD" "$doctor_decision" "$doctor_reason" <<'EOF'
        const [root, decision, reason] = process.argv.slice(2)
        console.log(JSON.stringify({ phase: 'doctor', root, decision, reason }))
        EOF
      '';
    };

    "${repairTaskName}" = {
      guard = "pnpm";
      description = "Discard and rematerialize the root-local pnpm dependency graph at ${workspaceRoot}";
      exec = trace.exec repairTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${loadPnpmTaskHelpersFn}
        purge_node_modules node_modules ${nodeModulesPaths}
        rm -f \
          "${cacheRoot}/install-state.hash" \
          "${cacheRoot}/projection-state.hash"
        echo "[pnpm] Discarded root-local dependency graph; reinvoking ${installTaskName}"
        exec devenv tasks run ${lib.escapeShellArg installTaskName}
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
  packages = cliGuard.fromTasks {
    tasks = allTasks;
    reals = lib.optionalAttrs (pnpmPkg != null) { pnpm = pnpmPkg; };
  };

  enterShell = lib.mkIf (globalCache && workspaceRoot == ".") ''
    export PNPM_HOME="''${PNPM_HOME:-${config.devenv.root}/.devenv/pnpm-home}"
    _pnpm_store_dir="''${npm_config_store_dir:-''${PNPM_CONFIG_STORE_DIR:-''${PNPM_STORE_DIR:-${defaultPnpmStoreDir}}}}"
    export PNPM_STORE_DIR="$_pnpm_store_dir"
    export PNPM_CONFIG_STORE_DIR="$_pnpm_store_dir"
    export npm_config_store_dir="$_pnpm_store_dir"
    export npm_config_cache="$HOME/.cache/pnpm"
    export npm_config_pm_on_fail=ignore
    if [ -z "''${CI:-}" ]; then
      _pnpm_shared_files="''${PNPM_SHARED_FILES_DIR:-$HOME/.local/share/pnpm/shared-files}/v11"
      mkdir -p "$PNPM_STORE_DIR/v11" "$_pnpm_shared_files"
      if [ ! -e "$PNPM_STORE_DIR/v11/files" ] && [ ! -L "$PNPM_STORE_DIR/v11/files" ]; then
        ln -s "$_pnpm_shared_files" "$PNPM_STORE_DIR/v11/files"
      fi
      unset _pnpm_shared_files
    fi
    unset _pnpm_store_dir
  '';

  tasks = cliGuard.stripGuards allTasks;
}
