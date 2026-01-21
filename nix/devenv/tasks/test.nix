{ ... }:
{
  tasks = {
    "test:run" = {
      description = "Run tests with vitest";
      exec = "vitest run";
      execIfModified = [ "**/*.ts" "**/*.tsx" "**/*.test.ts" "**/*.test.tsx" "vitest.config.ts" ];
    };
    "test:watch" = {
      description = "Run tests in watch mode";
      exec = "vitest";
    };
  };
}
