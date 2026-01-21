{ ... }:
{
  tasks = {
    "ts:check" = {
      description = "Run TypeScript type checking";
      exec = "tsc --build tsconfig.all.json";
      after = [ "genie:run" ];
      execIfModified = [ "**/*.ts" "**/*.tsx" "**/tsconfig.json" "tsconfig.all.json" ];
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
