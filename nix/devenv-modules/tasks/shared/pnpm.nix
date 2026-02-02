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

  # Build list of {path, name, prevName} for sequential chaining
  packagesWithPrev = lib.imap0 (i: path: {
    inherit path;
    name = toName path;
    prevName = if i == 0 then null else toName (builtins.elemAt packages (i - 1));
  }) packages;

  # Install tasks run sequentially to avoid race conditions from overlapping workspaces.
  # Each task depends on the previous one completing.
  # Note: pnpm-workspace.yaml files are committed, so fresh clones can install without genie:run.
  mkInstallTask = { path, name, prevName }: {
    "pnpm:install:${name}" = {
      description = "Install dependencies for ${name}";
      # NOTE: Use --config.confirmModulesPurge=false to avoid TTY prompts in non-interactive mode.
      exec = ''
        set -euo pipefail
        mkdir -p "${cacheRoot}"
        hash_file="${cacheRoot}/${name}.hash"

        if [ ! -f pnpm-lock.yaml ]; then
          echo "[pnpm] Warning: pnpm-lock.yaml missing in ${path}." >&2
          echo "[pnpm] Install will proceed without a lockfile (non-deterministic)." >&2
          echo "[pnpm] Fix: run 'dt pnpm:update' to regenerate lockfiles." >&2
        fi

        if [ -n "${CI:-}" ]; then
          pnpm install --config.confirmModulesPurge=false --frozen-lockfile
        else
          pnpm install --config.confirmModulesPurge=false
        fi

        if command -v sha256sum >/dev/null 2>&1; then
          hash_cmd="sha256sum"
        else
          hash_cmd="shasum -a 256"
        fi

        if [ -f pnpm-lock.yaml ]; then
          hash_input="package.json pnpm-lock.yaml"
        else
          hash_input="package.json"
        fi
        current_hash="$(cat $hash_input | $hash_cmd | awk '{print $1}')"
        cache_value="$current_hash"
        ${cache.writeCacheFile ''"$hash_file"''}
      '';
      cwd = path;
      # Sequential chaining: each task depends on the previous one to avoid race conditions.
      # First task has no dependency (workspace files are committed).
      after = if prevName == null then [ ] else [ "pnpm:install:${prevName}" ];
      status = ''
        set -euo pipefail
        hash_file="${cacheRoot}/${name}.hash"
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
          if [ -f pnpm-lock.yaml ]; then
            hash_input="package.json pnpm-lock.yaml"
          else
            hash_input="package.json"
          fi
          current_hash="$(cat $hash_input | $hash_cmd | awk '{print $1}')"
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
  updateScript = lib.concatStringsSep "\n" (map (p: ''
    echo "Updating ${p}..."
    (cd "${p}" && pnpm install --fix-lockfile --config.confirmModulesPurge=false) || echo "Warning: ${p} update failed"
  '') packages);

in {
  tasks = lib.mkMerge (map mkInstallTask packagesWithPrev ++ [
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
      "pnpm:clean" = {
        description = "Remove node_modules for all managed packages";
        exec = "rm -rf ${nodeModulesPaths} ${pnpmStorePath}";
      };
      "pnpm:reset-lock-files" = {
        description = "Remove pnpm lock files for all managed packages (⚠ destructive, last resort)";
        exec = "rm -f ${lockFilePaths}";
      };
    }
  ]);
}
