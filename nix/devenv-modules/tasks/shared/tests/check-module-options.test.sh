#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

eval_check_module() {
  local module_args="$1"
  local quick_task="$2"
  local all_task="$3"
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption {
              type = pkgs.lib.types.attrsOf pkgs.lib.types.anything;
              default = { };
            };
            config.tasks = pkgs.lib.genAttrs (pkgs.lib.unique [ "$quick_task" "$all_task" ]) (_: {
              exec = "true";
            });
          })
          (import $ROOT/nix/devenv-modules/tasks/shared/check.nix $module_args)
        ];
      };
      tasks = evaluated.config.tasks;
    in builtins.toJSON {
      allAfter = tasks.\"check:all\".after;
      hasAllTask = builtins.hasAttr "$all_task" tasks;
      hasQuickTask = builtins.hasAttr "$quick_task" tasks;
      quickAfter = tasks.\"check:quick\".after;
    }
  "
}

minimal_args='{ hasTests = false; hasLint = false; hasNixCheck = false; hasMegarepoCheck = false; }'
assert_eq \
  '{"allAfter":["ts:check"],"hasAllTask":true,"hasQuickTask":true,"quickAfter":["ts:check"]}' \
  "$(eval_check_module "$minimal_args" 'ts:check' 'ts:check')" \
  'compatibility default references the consumer-owned ts:check task'

buck_args='{ hasTests = false; hasLint = false; hasNixCheck = false; hasMegarepoCheck = false; checkQuickTypecheckTask = "buck2:quick"; checkAllTypecheckTask = "buck2:all"; }'
assert_eq \
  '{"allAfter":["buck2:all"],"hasAllTask":true,"hasQuickTask":true,"quickAfter":["buck2:quick"]}' \
  "$(eval_check_module "$buck_args" 'buck2:quick' 'buck2:all')" \
  'consumer may select explicit Buck aggregate tasks'
