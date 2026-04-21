# Minimal lint tasks using only genie (no oxlint/oxfmt)
#
# Usage in devenv.nix:
#   imports = [
#     inputs.effect-utils.devenvModules.tasks.lint-genie
#   ];
#
# Provides: lint:check, lint:check:genie, lint:fix
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  megarepoStoreEnv = builtins.getEnv "MEGAREPO_STORE";
  genieTaskEnv = lib.optionalAttrs (megarepoStoreEnv != "") {
    MEGAREPO_STORE = megarepoStoreEnv;
  };
in
{
  tasks = cliGuard.stripGuards {
    "lint:check:genie" = {
      description = "Check generated files are up to date";
      after = [ "genie:prepare" ];
      env = genieTaskEnv;
      exec = trace.exec "lint:check:genie" "genie --check";
    };
    "lint:check:lockfile" = {
      description = "Verify pnpm-lock.yaml matches package.json specifiers";
      after = [ "pnpm:install" ];
      exec = trace.exec "lint:check:lockfile" ''
        set -euo pipefail
        export npm_config_manage_package_manager_versions=false
        pnpm install --frozen-lockfile --ignore-scripts --config.confirmModulesPurge=false
      '';
    };
    "lint:check" = {
      description = "Run all lint checks";
      after = [
        "lint:check:genie"
        "lint:check:lockfile"
      ];
    };
    "lint:fix" = {
      description = "Fix all lint issues (no formatter configured)";
      exec = "echo 'No lint fixer configured'";
    };
  };
}
