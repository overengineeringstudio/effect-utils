{ lib, ... }:
let
  packages = import ./packages.nix { inherit lib; };
  inherit (packages) packagesWithTests toName;

  # Use vitest/playwright from utils package (has all deps)
  vitest = "packages/@overeng/utils/node_modules/.bin/vitest";
  vitestConfig = "packages/@overeng/utils/vitest.config.ts";
  playwright = "packages/@overeng/utils/node_modules/.bin/playwright";

  mkTestTask = path: {
    "test:${toName path}" = {
      description = "Run tests for ${toName path}";
      # Run from package dir using utils' vitest binary and config
      exec = "../utils/node_modules/.bin/vitest run --config ../utils/vitest.config.ts";
      cwd = path;
      execIfModified = [ "${path}/src/**/*.ts" "${path}/src/**/*.test.ts" "${path}/vitest.config.ts" ];
      after = [ "bun:install:${toName path}" "bun:install:utils" ];
    };
  };

in {
  tasks = lib.mkMerge (map mkTestTask packagesWithTests ++ [
    {
      # Aggregate task to run all package tests
      "test:run" = {
        description = "Run all tests";
        after = map (p: "test:${toName p}") packagesWithTests;
      };

      # Watch mode - run from utils dir
      "test:watch" = {
        description = "Run tests in watch mode";
        exec = "./node_modules/.bin/vitest";
        cwd = "packages/@overeng/utils";
        after = [ "bun:install:utils" ];
      };

      # Integration tests (playwright)
      "test:integration" = {
        description = "Run integration tests (playwright)";
        exec = "./node_modules/.bin/playwright test";
        cwd = "packages/@overeng/utils";
        after = [ "bun:install:utils" ];
      };
    }
  ]);
}
