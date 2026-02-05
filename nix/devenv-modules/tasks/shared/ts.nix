# TypeScript tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.ts {})
#     # Or with custom tsconfig:
#     (inputs.effect-utils.devenvModules.tasks.ts { tsconfigFile = "tsconfig.dev.json"; })
#   ];
#
# Provides: ts:check, ts:watch, ts:build, ts:clean, and optionally ts:patch-lsp
#
# Dependencies:
#   - genie:run: config files must be generated before tsc can resolve paths
#   - pnpm:install: node_modules must exist for tsc to resolve types
#
# Caching notes:
#   TypeScript's incremental build (--build) uses .tsbuildinfo files to cache
#   results. If you suspect stale cache issues (e.g., cross-package signature
#   changes not detected), run `dt ts:clean` first to clear the cache.
#   Ensure all packages are listed in tsconfig.all.json references.
#
# tscBin:
#   Path to the tsc binary. Use a package-local node_modules/.bin/tsc to pick up
#   the Effect Language Service patch. The Nix-provided tsc is unpatched, so
#   Effect plugin diagnostics are silently skipped unless a patched binary is used.
#
# lspPatchCmd:
#   Command to patch TypeScript with the Effect Language Service plugin. When set,
#   creates a ts:patch-lsp task that runs before ts:check/ts:watch/ts:build.
#   This replaces per-package postinstall scripts, centralizing the patch in dt.
#   Example: "packages/@overeng/utils/node_modules/.bin/effect-language-service patch"
{ tsconfigFile ? "tsconfig.all.json", tscBin ? "tsc", lspPatchCmd ? null }:
{ ... }:
let
  lspAfter = if lspPatchCmd != null then [ "ts:patch-lsp" ] else [];
in
{
  tasks = {
    "ts:check" = {
      description = "Run TypeScript type checking";
      exec = "${tscBin} --build ${tsconfigFile}";
      after = [ "genie:run" "pnpm:install" ] ++ lspAfter;
    };
    "ts:watch" = {
      description = "Run TypeScript in watch mode";
      exec = "${tscBin} --build --watch ${tsconfigFile}";
      after = [ "genie:run" "pnpm:install" ] ++ lspAfter;
    };
    "ts:build" = {
      description = "Build all packages (tsc --build)";
      exec = "${tscBin} --build ${tsconfigFile}";
      after = [ "genie:run" "pnpm:install" ] ++ lspAfter;
    };
    "ts:clean" = {
      description = "Remove TypeScript build artifacts";
      # Use Nix tsc (always available) since clean doesn't need the Effect LSP patch
      exec = "tsc --build --clean ${tsconfigFile}";
    };
  } // (if lspPatchCmd != null then {
    "ts:patch-lsp" = {
      description = "Patch TypeScript with Effect Language Service";
      exec = lspPatchCmd;
      after = [ "pnpm:install" ];
    };
  } else {});
}
