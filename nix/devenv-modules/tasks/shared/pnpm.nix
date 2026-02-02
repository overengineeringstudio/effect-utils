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
#     })
#   ];
#
# Provides: pnpm:install, pnpm:install:<name>, pnpm:update, pnpm:clean, pnpm:reset-lock-files
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
# Installs run in PARALLEL for faster builds (~3x speedup).
# This is safe because we no longer use enableGlobalVirtualStore (which had race conditions).
# See: context/workarounds/pnpm-issues.md for history.
#
# Shared caching rules live in ../lib/cache.nix (task-specific details below).
#
# Cache inputs (per package path):
# - package.json contents
# - pnpm-lock.yaml contents
#
# Cache files:
# - .direnv/task-cache/pnpm-install/<task-name>.hash
{ packages }:
{ lib, config, ... }:
let
  cache = import ../lib/cache.nix { inherit config; };
  cacheRoot = cache.mkCachePath "pnpm-install";
  # Convert path to task name:
  # "packages/@scope/foo" -> "foo"
  # "packages/@scope/foo/examples/basic" -> "foo-examples-basic"
  # "packages/app" -> "app"
  # "apps/example.com" -> "example-com"
  # "tests/wa-sqlite" -> "tests-wa-sqlite"
  # "scripts" -> "scripts"
  toName = path:
    let
      sanitize = s: builtins.replaceStrings ["/" "."] ["-" "-"] s;
      # Only strip "packages/" or "apps/" prefix, keep others like "tests/"
      stripped = lib.removePrefix "apps/" (lib.removePrefix "packages/" path);
      # Strip @scope/ pattern (e.g., "@overeng/foo" -> "foo")
      m = builtins.match "@[^/]+/(.*)" stripped;
      final = if m != null then builtins.head m else stripped;
    in
    sanitize final;

  # All install tasks depend only on genie:run (which generates pnpm-workspace.yaml files).
  # Installs run in parallel for ~3x speedup.
  mkInstallTask = path: {
    "pnpm:install:${toName path}" = {
      description = "Install dependencies for ${toName path}";
      # NOTE: Use --config.confirmModulesPurge=false to avoid TTY prompts in non-interactive mode.
      exec = ''
        set -euo pipefail
        mkdir -p "${cacheRoot}"
        hash_file="${cacheRoot}/${toName path}.hash"

        pnpm install --config.confirmModulesPurge=false

        if command -v sha256sum >/dev/null 2>&1; then
          hash_cmd="sha256sum"
        else
          hash_cmd="shasum -a 256"
        fi

        current_hash="$(cat package.json pnpm-lock.yaml | $hash_cmd | awk '{print $1}')"
        cache_value="$current_hash"
        ${cache.writeCacheFile ''"$hash_file"''}
      '';
      cwd = path;
      after = [ "genie:run" ];
        status = ''
          set -euo pipefail
          hash_file="${cacheRoot}/${toName path}.hash"
          if [ ! -d "node_modules" ]; then
            exit 1
          fi
          if [ ! -f "$hash_file" ]; then
            exit 1
          fi
          if command -v sha256sum >/dev/null 2>&1; then
            hash_cmd="sha256sum"
          else
            hash_cmd="shasum -a 256"
          fi
          current_hash="$(cat package.json pnpm-lock.yaml | $hash_cmd | awk '{print $1}')"
          stored_hash="$(cat "$hash_file")"
          if [ "$current_hash" != "$stored_hash" ]; then
            exit 1
          fi
          exit 0
        '';
      };
    };

  mkCheckTask = path: {
    "pnpm:check:${toName path}" = {
      description = "Check pnpm offline deps for ${toName path}";
      exec = ''
        set -euo pipefail
        pnpm fetch --offline --frozen-lockfile
      '';
      cwd = path;
      after = [ "genie:run" ];
    };
  };

  nodeModulesPaths = lib.concatMapStringsSep " " (p: "${p}/node_modules") packages;
  lockFilePaths = lib.concatMapStringsSep " " (p: "${p}/pnpm-lock.yaml") packages;

  # Build a shell script that updates lockfiles for all packages
  updateScript = lib.concatStringsSep "\n" (map (p: ''
    echo "Updating ${p}..."
    (cd "${p}" && pnpm install --no-frozen-lockfile --config.confirmModulesPurge=false) || echo "Warning: ${p} update failed"
  '') packages);

in {
  tasks = lib.mkMerge (map mkInstallTask packages ++ map mkCheckTask packages ++ [
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
        exec = ''
          echo "Updating pnpm lockfiles for all packages..."
          ${updateScript}
          echo "Lockfiles updated. Run 'dt nix:hash' to update Nix hashes."
        '';
      };
      "pnpm:check" = {
        description = "Check pnpm offline deps for all packages";
        after = map (p: "pnpm:check:${toName p}") packages;
      };
      "pnpm:clean" = {
        description = "Remove node_modules for all managed packages";
        exec = "rm -rf ${nodeModulesPaths}";
      };
      "pnpm:reset-lock-files" = {
        description = "Remove pnpm lock files for all managed packages (⚠ destructive, last resort)";
        exec = "rm -f ${lockFilePaths}";
      };
    }
  ]);
}
