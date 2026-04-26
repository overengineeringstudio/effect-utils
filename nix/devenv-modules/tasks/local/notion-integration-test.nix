# Notion integration tests
#
# Runs vitest with --include for *.integration.test.ts files in Notion packages.
# Requires NOTION_TOKEN environment variable; skips gracefully if not set.
#
# Provides:
#   - test:notion-integration - Run all Notion integration tests
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ../shared/pnpm-task-helpers.sh
  );
  packages = [
    {
      path = "packages/@overeng/notion-effect-client";
      name = "notion-effect-client";
    }
    {
      path = "packages/@overeng/notion-cli";
      name = "notion-cli";
    }
  ];
  vitestExec = ''
    set -euo pipefail
    if [ -z "''${NOTION_TOKEN:-}" ]; then
      echo "NOTION_TOKEN not set, skipping integration tests"
      exit 0
    fi
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
    run_package_bin vitest vitest run --config vitest.integration.config.ts
  '';
  mkTestTask = pkg: {
    "test:notion-integration:${pkg.name}" = {
      description = "Run Notion integration tests for ${pkg.name}";
      exec = trace.exec "test:notion-integration:${pkg.name}" vitestExec;
      cwd = pkg.path;
      after = [ "pnpm:install" ];
    };
  };
in
{
  tasks = lib.mkMerge (
    (map mkTestTask packages)
    ++ [
      {
        "test:notion-integration" = {
          description = "Run all Notion integration tests (requires NOTION_TOKEN)";
          after = map (pkg: "test:notion-integration:${pkg.name}") packages;
        };
      }
    ]
  );
}
