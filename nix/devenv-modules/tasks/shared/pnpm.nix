# pnpm install tasks
#
# STATUS: Current package manager (temporary, plan to switch back to bun)
#
# We use pnpm temporarily due to bun bugs. Once fixed, we'll switch back to bun.
# See: context/workarounds/bun-issues.md for blocking issues.
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.pnpm {
#       packages = [
#         "packages/app"
#         "packages/website"
#         "scripts"
#       ];
#       # globalCache = true;  # default: share ~/.cache/pnpm across workspaces
#     })
#   ];
#
# Provides: pnpm:install, pnpm:install:<name>, pnpm:update, pnpm:clean, pnpm:reset-lock-files
# Sets: env.npm_config_cache (when globalCache = true)
#
# ---
# How we avoid TypeScript TS2742 errors:
#
# We use `workspace:*` protocol with per-package pnpm-workspace.yaml files.
# Each package declares only its direct workspace dependencies, which ensures
# TypeScript resolves types correctly without additional workarounds.
#
# Note: `enableGlobalVirtualStore` was previously used but is no longer needed
# with the `workspace:*` protocol approach. See PNPM-02 in context/workarounds/pnpm-issues.md
#
# ---
# Why installs run SEQUENTIALLY (not in parallel):
#
# Each package has a pnpm-workspace.yaml that lists workspace members for the
# `workspace:*` protocol to resolve internal dependencies. When `pnpm install`
# runs, it operates on ALL workspace members (not just the current package),
# installing dependencies into each member's node_modules/.
#
# When multiple packages have overlapping workspace members (e.g., both genie
# and notion-cli include ../utils, ../tui-react), running their installs in
# parallel causes race conditions - both try to write to the same directories
# simultaneously, resulting in ENOENT errors.
#
# Alternative: Dependency-aware parallelism could be implemented by analyzing
# workspace overlap and only serializing installs with shared members. This
# would restore ~3x speedup for non-overlapping packages but adds complexity.
#
# ---
# Shared caching rules live in ../lib/cache.nix (task-specific details below).
#
# Cache inputs (per package path):
# - package.json contents
# - pnpm-lock.yaml contents
# - For packages with injected deps: source file contents (content-addressed)
#
# Cache files:
# - .direnv/task-cache/pnpm-install/<task-name>.hash
#
# ---
# Injected workspace deps and staleness:
#
# Packages using `injected: true` in dependenciesMeta get a COPY of the workspace
# dep instead of a symlink. This copy becomes stale when the source changes.
# Regular `pnpm install` syncs the copy, but our status check must detect when
# the source has changed to trigger reinstall.
#
# Injected deps are AUTO-DETECTED from each package's package.json by parsing
# the `dependenciesMeta` section at Nix evaluation time. No manual configuration
# needed - just add `"injected": true` to dependenciesMeta and it will be tracked.
#
# ---
# Global content cache:
#
# By default, pnpm's content-addressable cache is shared globally at ~/.cache/pnpm.
# This prevents duplicate downloads across workspaces while keeping stores per-workspace.
# Set globalCache = false to disable (not recommended for megarepo setups).
#
{
  packages,
  globalCache ? true,
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
  flock = "${pkgs.flock}/bin/flock";

  # Convert path to task name:
  # "packages/@scope/foo" -> "foo"
  # "packages/@scope/foo/examples/basic" -> "foo-examples-basic"
  # "packages/app" -> "app"
  # "apps/example.com" -> "example-com"
  # "tests/wa-sqlite" -> "tests-wa-sqlite"
  # "scripts" -> "scripts"
  # "repos/effect-utils/packages/@overeng/oxc-config" -> "oxc-config"
  toName =
    path:
    let
      sanitize = s: builtins.replaceStrings [ "/" "." ] [ "-" "-" ] s;
      # Strip "repos/*/packages/" prefix for megarepo peer repo paths
      repoStripped =
        let
          m = builtins.match "repos/[^/]+/packages/(.*)" path;
        in
        if m != null then builtins.head m else path;
      # Only strip "packages/" or "apps/" prefix, keep others like "tests/"
      stripped = lib.removePrefix "apps/" (lib.removePrefix "packages/" repoStripped);
      # Strip @scope/ pattern (e.g., "@overeng/foo" -> "foo")
      m = builtins.match "@[^/]+/(.*)" stripped;
      final = if m != null then builtins.head m else stripped;
    in
    sanitize final;

  # =============================================================================
  # Auto-detect injected deps from package.json
  # =============================================================================
  #
  # Build a lookup from package name (e.g., "@overeng/tui-react") to path
  # (e.g., "packages/@overeng/tui-react"). Only includes packages in our list.
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

  # Get injected dep paths for a package by parsing its package.json
  # Returns list of paths (e.g., ["packages/@overeng/tui-react"])
  getInjectedDeps =
    path:
    let
      pkgJsonPath = "${config.devenv.root}/${path}/package.json";
      pkgJsonExists = builtins.pathExists pkgJsonPath;
      pkgJson = if pkgJsonExists then builtins.fromJSON (builtins.readFile pkgJsonPath) else { };
      depsMeta = pkgJson.dependenciesMeta or { };
      # Get names with injected: true
      injectedNames = builtins.filter (name: (depsMeta.${name}.injected or false) == true) (
        builtins.attrNames depsMeta
      );
      # Map to paths, filtering out packages not in our list
      injectedPaths = builtins.filter (p: p != null) (
        map (name: packageNameToPath.${name} or null) injectedNames
      );
    in
    injectedPaths;

  # Build list of {path, name, prevName, injected} for sequential chaining
  packagesWithPrev = lib.imap0 (i: path: {
    inherit path;
    name = toName path;
    prevName = if i == 0 then null else toName (builtins.elemAt packages (i - 1));
    # Auto-detect injected deps from package.json
    injected = getInjectedDeps path;
  }) packages;

  # =============================================================================
  # Shared hash computation scripts
  # =============================================================================
  #
  # Hash function that works on both Linux (sha256sum) and macOS (shasum)
  sha256sum = "${pkgs.coreutils}/bin/sha256sum";
  computeHashFn = ''
    compute_hash() {
      ${sha256sum} | awk '{print $1}'
    }
  '';

  # Generate cache hash computation script for a package
  # Takes the list of injected dep paths and a variable name for the result
  mkComputeCacheHash =
    { injected, resultVar }:
    ''
      if [ -f pnpm-lock.yaml ]; then
        base_hash="$(cat package.json pnpm-lock.yaml | compute_hash)"
      else
        base_hash="$(cat package.json | compute_hash)"
      fi
      ${
        if injected == [ ] then
          ''
            ${resultVar}="$base_hash"
          ''
        else
          ''
            injected_hash="$(find ${
              lib.concatMapStringsSep " " (dep: "\"$DEVENV_ROOT/${dep}/src\"") injected
            } -type f \( -name "*.ts" -o -name "*.tsx" \) -exec cat {} + 2>/dev/null | compute_hash)"
            ${resultVar}="$base_hash $injected_hash"
          ''
      }
    '';

  # Install tasks run sequentially to avoid race conditions from overlapping workspaces.
  # Each task depends on the previous one completing.
  # Note: pnpm-workspace.yaml files are committed, so fresh clones can install without genie:run.
  mkInstallTask =
    {
      path,
      name,
      prevName,
      injected,
    }:
    {
      "pnpm:install:${name}" = {
        description = "Install dependencies for ${name}";
        # NOTE: Use --config.confirmModulesPurge=false to avoid TTY prompts in non-interactive mode.
        exec = trace.exec "pnpm:install:${name}" ''
          set -euo pipefail
          mkdir -p "${cacheRoot}"
          hash_file="${cacheRoot}/${name}.hash"

          # Cross-process lock: prevent overlapping pnpm installs within a worktree.
          #
          # Even though our per-package install tasks are chained sequentially within a
          # single task graph, multiple terminals can trigger installs concurrently
          # (e.g. simultaneous direnv loads). pnpm then races on node_modules/.pnpm
          # final renames, producing flaky filesystem errors like ENOTEMPTY/ENOENT.
          lockfile="${cacheRoot}/pnpm-install.lock"
          exec 200>"$lockfile"
          if ! ${flock} -w 600 200; then
            echo "[pnpm] Install lock timeout after 600s: $lockfile" >&2
            echo "[pnpm] Another pnpm install may be stuck; try: dt pnpm:clean && dt pnpm:install" >&2
            exit 1
          fi

          if [ ! -f pnpm-lock.yaml ]; then
            echo "[pnpm] Warning: pnpm-lock.yaml missing in ${path}." >&2
            echo "[pnpm] Install will proceed without a lockfile (non-deterministic)." >&2
            echo "[pnpm] Fix: run 'dt pnpm:update' to regenerate lockfiles." >&2
          fi

          if [ -n "''${CI:-}" ]; then
            pnpm install --config.confirmModulesPurge=false --frozen-lockfile
          else
            pnpm install --config.confirmModulesPurge=false
          fi

          ${computeHashFn}
          ${mkComputeCacheHash {
            inherit injected;
            resultVar = "cache_value";
          }}
          ${cache.writeCacheFile ''"$hash_file"''}
        '';
        cwd = path;
        # Sequential chaining: each task depends on the previous one to avoid race conditions.
        # First task has no dependency (workspace files are committed).
        after = if prevName == null then [ ] else [ "pnpm:install:${prevName}" ];
        status = trace.status "pnpm:install:${name}" "hash" ''
          set -euo pipefail
          hash_file="${cacheRoot}/${name}.hash"
          if [ ! -d "node_modules" ]; then
            exit 1
          fi
          if [ ! -f "$hash_file" ]; then
            exit 1
          fi
          ${computeHashFn}
          ${mkComputeCacheHash {
            inherit injected;
            resultVar = "current_hash";
          }}
          stored_hash="$(cat "$hash_file")"
          if [ "$current_hash" != "$stored_hash" ]; then
            exit 1
          fi
          exit 0
        '';
      };
    };

  nodeModulesPaths = lib.concatMapStringsSep " " (p: "${p}/node_modules") packages;
  lockFilePaths = lib.concatMapStringsSep " " (p: "${p}/pnpm-lock.yaml") packages;
  pnpmStorePath = "${config.devenv.root}/.pnpm-store";

  # Build a shell script that updates lockfiles for all packages
  # See: https://pnpm.io/cli/install#--fix-lockfile
  updateScript = lib.concatStringsSep "\n" (
    map (p: ''
      echo "Updating ${p}..."
      (cd "${p}" && pnpm install --fix-lockfile --config.confirmModulesPurge=false) || echo "Warning: ${p} update failed"
    '') packages
  );

in
{
  # Share pnpm's content-addressable cache globally to prevent duplicate downloads
  # across workspaces. Each workspace still has its own store (PNPM_STORE_DIR),
  # but downloaded tarballs are cached in ~/.cache/pnpm.
  # Note: This must be set in enterShell (not env) so that $HOME is expanded by
  # bash at runtime. Nix strings don't do shell variable expansion, and
  # builtins.getEnv "HOME" returns "" in pure flake evaluation.
  enterShell = lib.mkIf globalCache ''
    export npm_config_cache="$HOME/.cache/pnpm"
  '';

  tasks = lib.mkMerge (
    map mkInstallTask packagesWithPrev
    ++ [
      {
        "pnpm:install" = {
          description = "Install all pnpm dependencies";
          exec = "echo 'All pnpm packages installed'";
          after = map (p: "pnpm:install:${toName p}") packages;
        };
        "pnpm:update" = {
          description = "Update all pnpm lockfiles (use when adding new dependencies)";
          # Ensure generated package.json files are up to date before updating lockfiles.
          after = [ "genie:run" ];
          exec = trace.exec "pnpm:update" ''
            echo "Updating pnpm lockfiles for all packages..."
            ${updateScript}
            echo "Lockfiles updated. Run 'dt nix:hash' to update Nix hashes."
          '';
        };
        "pnpm:clean" = {
          description = "Remove node_modules for all managed packages";
          exec = trace.exec "pnpm:clean" "rm -rf ${nodeModulesPaths} ${pnpmStorePath}";
        };
        "pnpm:reset-lock-files" = {
          description = "Remove pnpm lock files for all managed packages (⚠ destructive, last resort)";
          exec = trace.exec "pnpm:reset-lock-files" "rm -f ${lockFilePaths}";
        };
      }
    ]
  );
}
