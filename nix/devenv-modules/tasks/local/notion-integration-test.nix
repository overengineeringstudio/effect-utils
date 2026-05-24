# Notion integration tests
#
# Runs vitest with --include for *.integration.test.ts files in Notion packages.
# Requires each package's Notion token environment variable; skips gracefully if not set.
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
      tokenEnv = "NOTION_API_TOKEN";
    }
    {
      path = "packages/@overeng/notion-cli";
      name = "notion-cli";
      tokenEnv = "NOTION_API_TOKEN";
    }
    {
      path = "packages/@overeng/notion-md";
      name = "notion-md";
      tokenEnv = "NOTION_TOKEN";
    }
  ];
  vitestExec = tokenEnv: ''
    set -euo pipefail
    token_name=${lib.escapeShellArg tokenEnv}
    if [ -z "''${!token_name:-}" ]; then
      echo "$token_name not set, skipping integration tests"
      exit 0
    fi
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
    run_package_bin vitest vitest run --config vitest.integration.config.ts
  '';
  mkTestTask = pkg: {
    "test:notion-integration:${pkg.name}" = {
      description = "Run Notion integration tests for ${pkg.name}";
      exec = trace.exec "test:notion-integration:${pkg.name}" (vitestExec pkg.tokenEnv);
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
          description = "Run all Notion integration tests";
          after = map (pkg: "test:notion-integration:${pkg.name}") packages;
        };
      }
    ]
  );
}
