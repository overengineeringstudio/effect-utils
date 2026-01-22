# TypeScript tasks
#
# Usage in devenv.nix:
#   imports = [ inputs.effect-utils.devenvModules.tasks.ts ];
#
# Provides: ts:check, ts:watch, ts:build, ts:clean
{ ... }:
{
  tasks = {
    "ts:check" = {
      description = "Run TypeScript type checking";
      exec = "tsc --build tsconfig.all.json";
      after = [ "genie:run" ];
    };
    "ts:watch" = {
      description = "Run TypeScript in watch mode";
      exec = "tsc --build --watch tsconfig.all.json";
      after = [ "genie:run" ];
    };
    "ts:build" = {
      description = "Build all packages (tsc --build)";
      exec = "tsc --build tsconfig.all.json";
      after = [ "genie:run" ];
    };
    "ts:clean" = {
      description = "Remove TypeScript build artifacts";
      exec = "tsc --build --clean tsconfig.all.json";
    };
  };
}
