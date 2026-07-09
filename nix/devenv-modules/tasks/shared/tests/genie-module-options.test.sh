#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

eval_genie_module_attr() {
  local module_config="$1"
  local attr_expr="$2"

  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          $ROOT/nix/devenv-modules/tasks/shared/genie.nix
          ({ ... }: $module_config)
        ];
        specialArgs = { inherit pkgs; lib = pkgs.lib; };
      };
    in $attr_expr
  "
}

echo "Running Genie module option smoke test..."

default_globs="$(eval_genie_module_attr "{ }" 'builtins.toJSON evaluated.config.effectUtils.genie.extraInputGlobs')"
if [ "$default_globs" != "[]" ]; then
  echo "FAIL: default extraInputGlobs should be empty"
  echo "  actual: $default_globs"
  exit 1
fi

package_count="$(eval_genie_module_attr "{ effectUtils.genie.package = pkgs.hello; }" 'builtins.toString (builtins.length evaluated.config.packages)')"
if [ "$package_count" != "1" ]; then
  echo "FAIL: setting effectUtils.genie.package should add one guarded package"
  echo "  actual package count: $package_count"
  exit 1
fi

configured_globs="$(eval_genie_module_attr "{ effectUtils.genie.extraInputGlobs = [ \"registry.json\" ]; }" 'builtins.toJSON evaluated.config.effectUtils.genie.extraInputGlobs')"
if [ "$configured_globs" != '["registry.json"]' ]; then
  echo "FAIL: extraInputGlobs option should accept repo-specific generator inputs"
  echo "  actual: $configured_globs"
  exit 1
fi

echo "Genie module option smoke test passed."
