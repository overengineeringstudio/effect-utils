#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

eval_setup_module_attr() {
  local run_on_enter_shell="$1"
  local attr_expr="$2"

  nix eval --impure --json --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      setupModule = import $ROOT/nix/devenv-modules/tasks/shared/setup.nix {
        requiredTasks = [ \"required\" ];
        optionalTasks = [ \"optional\" ];
        completionsCliNames = [ \"tool\" ];
        runOnEnterShell = $run_on_enter_shell;
      };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption {
              type = pkgs.lib.types.attrsOf pkgs.lib.types.anything;
              default = { };
            };
          })
          setupModule
        ];
        specialArgs = { inherit pkgs; lib = pkgs.lib; };
      };
    in $attr_expr
  "
}

echo "Running setup module option tests..."

disabled_after="$(eval_setup_module_attr false 'evaluated.config.tasks."devenv:enterShell".after')"
if [ "$disabled_after" != '[]' ]; then
  echo "FAIL: mutation-free shell must have no setup dependencies: $disabled_after" >&2
  exit 1
fi

disabled_tasks="$(eval_setup_module_attr false 'builtins.attrNames evaluated.config.tasks')"
if [[ "$disabled_tasks" == *'setup:gate'* || "$disabled_tasks" == *'setup:record-cache'* ]]; then
  echo "FAIL: mutation-free shell must not instantiate setup cache tasks: $disabled_tasks" >&2
  exit 1
fi
if [[ "$disabled_tasks" != *'setup:run'* || "$disabled_tasks" != *'setup:strict'* ]]; then
  echo "FAIL: explicit setup recovery tasks must remain available: $disabled_tasks" >&2
  exit 1
fi

enabled_after="$(eval_setup_module_attr true 'evaluated.config.tasks."devenv:enterShell".after')"
if [[ "$enabled_after" != *'required'* || "$enabled_after" != *'optional@completed'* ]]; then
  echo "FAIL: enabled shell setup must preserve required and optional dependencies: $enabled_after" >&2
  exit 1
fi

echo "Setup module option tests passed."
