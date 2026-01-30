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
{ tsconfigFile ? "tsconfig.all.json" }:
{ ... }:
{
  tasks = {
    "ts:check" = {
      description = "Run TypeScript type checking";
      exec = "tsc --build ${tsconfigFile}";
      after = [ "genie:run" "pnpm:install" ];
    };
    "ts:watch" = {
      description = "Run TypeScript in watch mode";
      exec = "tsc --build --watch ${tsconfigFile}";
      after = [ "genie:run" "pnpm:install" ];
    };
    "ts:build" = {
      description = "Build all packages (tsc --build)";
      exec = "tsc --build ${tsconfigFile}";
      after = [ "genie:run" "pnpm:install" ];
    };
    "ts:clean" = {
      description = "Remove TypeScript build artifacts";
      exec = "tsc --build --clean ${tsconfigFile}";
    };
  };
}
