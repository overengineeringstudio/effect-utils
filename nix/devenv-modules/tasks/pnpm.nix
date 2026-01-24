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
# Provides: pnpm:install, pnpm:install:<name> for each package
#
# ---
# How we avoid TypeScript TS2742 errors:
#
# Two-part approach:
#
# 1. PRIMARY: Use `link:` protocol for internal packages
#    Internal deps use link: instead of file: in package.json (configured via genie).
#    link: creates a symlink to the source directory, so the package uses its OWN node_modules.
#    This matches how published packages behave and avoids TS2742 errors.
#
# 2. BACKUP: `enableGlobalVirtualStore` for remaining file: deps
#    Some locations (docs, tests) still use file:. For these, we use pnpm's
#    enableGlobalVirtualStore which makes all packages symlink to a central store
#    at ~/Library/pnpm/store/v10/links/. Dependencies with identical graphs
#    resolve to the exact same path, eliminating TS2742 errors.
#
# IMPORTANT: Installs run SEQUENTIALLY to avoid pnpm store corruption.
# Parallel pnpm installs with enableGlobalVirtualStore cause race conditions.
# See: https://github.com/pnpm/pnpm/issues/10232
# See: context/workarounds/pnpm-issues.md for full details.
#
# Shared caching rules live in ./lib/cache.nix (task-specific details below).
{ packages }:
{ lib, config, ... }:
let
  cache = import ./lib/cache.nix { inherit config; };
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

  # Build sequential dependency chain to avoid parallel pnpm installs
  # which cause store corruption with enableGlobalVirtualStore.
  # See: https://github.com/pnpm/pnpm/issues/10232
  mkInstallTask = idx: path:
    let
      prevTask = if idx == 0
        then "genie:run"
        else "pnpm:install:${toName (builtins.elemAt packages (idx - 1))}";
    in {
      "pnpm:install:${toName path}" = {
        description = "Install dependencies for ${toName path}";
        # Use global virtual store to ensure all packages resolve dependencies to the same path.
        # This prevents TypeScript TS2742 errors when packages depend on each other via link: protocol.
        # Without this, each package gets its own .pnpm directory with different paths for the same deps.
        # NOTE: Use --config.confirmModulesPurge=false to avoid TTY prompts.
        # CI=true would disable GVS (see pnpm docs: "Default: false (always false in CI)").
        exec = ''
          set -euo pipefail
          mkdir -p "${cacheRoot}"
          hash_file="${cacheRoot}/${toName path}.hash"

          npm_config_enable_global_virtual_store=true pnpm install --config.confirmModulesPurge=false

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
        after = [ prevTask ];
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

  # Generate indexed list for sequential chaining
  indexedPackages = lib.imap0 (idx: path: { inherit idx path; }) packages;

  nodeModulesPaths = lib.concatMapStringsSep " " (p: "${p}/node_modules") packages;
  lockFilePaths = lib.concatMapStringsSep " " (p: "${p}/pnpm-lock.yaml") packages;

in {
  tasks = lib.mkMerge (map (p: mkInstallTask p.idx p.path) indexedPackages ++ [
    {
      "pnpm:install" = {
        description = "Install all pnpm dependencies";
        exec = "echo 'All pnpm packages installed'";
        after = map (p: "pnpm:install:${toName p}") packages;
      };
      "pnpm:clean" = {
        description = "Remove node_modules for all managed packages";
        exec = "rm -rf ${nodeModulesPaths}";
      };
      "pnpm:clean-lock-files" = {
        description = "Remove pnpm lock files for all managed packages";
        exec = "rm -f ${lockFilePaths}";
      };
    }
  ]);
}
