# Playwright e2e test tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.test-playwright {
#       packages = [
#         { path = "apps/misc.schickling.dev"; name = "misc"; }
#       ];
#       # Optional: custom playwright binary (default: playwright)
#       playwrightBin = "node_modules/.bin/playwright";
#     })
#   ];
#
# Provides:
#   - test:pw:run - Run all playwright tests
#   - test:pw:<name> - Run playwright tests for specific package
{
  packages,
  playwrightBin ? "playwright",
}:
{ lib, ... }:
let
  mkTestTask = pkg: {
    "test:pw:${pkg.name}" = {
      description = "Run playwright tests for ${pkg.name}";
      exec = "${playwrightBin} test";
      cwd = pkg.path;
      after = [ "bun:install:${pkg.name}" ];
    };
  };

in {
  tasks = lib.mkMerge (
    map mkTestTask packages
    ++ [{
      "test:pw:run" = {
        description = "Run all playwright e2e tests";
        after = map (pkg: "test:pw:${pkg.name}") packages;
      };
    }]
  );
}
