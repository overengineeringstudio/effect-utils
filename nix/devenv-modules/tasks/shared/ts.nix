# TypeScript tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.ts {})
#     # Or with custom tsconfig:
#     (inputs.effect-utils.devenvModules.tasks.ts { tsconfigFile = "tsconfig.dev.json"; })
#   ];
#
# Provides: ts:check, ts:watch, ts:build, ts:clean
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
#   the Effect Language Service patch (effect-language-service patch runs as a
#   postinstall and patches node_modules/typescript). The Nix-provided tsc is
#   unpatched, so Effect plugin diagnostics are silently skipped unless a patched
#   binary is used.
{ tsconfigFile ? "tsconfig.all.json", tscBin ? "tsc" }:
{ ... }:
{
  tasks = {
    "ts:check" = {
      description = "Run TypeScript type checking";
      exec = "${tscBin} --build ${tsconfigFile}";
      after = [ "genie:run" "pnpm:install" ];
    };
    "ts:watch" = {
      description = "Run TypeScript in watch mode";
      exec = "${tscBin} --build --watch ${tsconfigFile}";
      after = [ "genie:run" "pnpm:install" ];
    };
    "ts:build" = {
      description = "Build all packages (tsc --build)";
      exec = "${tscBin} --build ${tsconfigFile}";
      after = [ "genie:run" "pnpm:install" ];
    };
    "ts:clean" = {
      description = "Remove TypeScript build artifacts";
      exec = "${tscBin} --build --clean ${tsconfigFile}";
    };
  };
}
