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

echo "Checking commentless generated JSON ownership and warm-state drift..."
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin"

cat > "$test_dir/bin/genie" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo "genie-test 1"
fi
EOF
chmod +x "$test_dir/bin/genie"

git -C "$test_dir" init -q
printf 'export default {}\n' > "$test_dir/contract.json.genie.ts"
printf '{"value":1}\n' > "$test_dir/contract.json"
git -C "$test_dir" add contract.json.genie.ts contract.json

run_exec="$(eval_genie_module_attr "{ }" 'evaluated.config.tasks."genie:run".exec')"
run_status="$(eval_genie_module_attr "{ }" 'evaluated.config.tasks."genie:run".status')"
(
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
)

if ! grep -qxF 'contract.json' "$test_dir/.devenv/task-cache/genie-run/generated-files.txt"; then
  echo "FAIL: commentless JSON paired with a .genie.ts source was not collected"
  exit 1
fi

printf '{"value":2}\n' > "$test_dir/contract.json"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" DEVENV_SETUP_OUTER_CACHE_HIT=0 \
    OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_status"
); then
  echo "FAIL: mutating commentless generated JSON should invalidate Genie warm state"
  exit 1
fi

printf '{"value":1}\n' > "$test_dir/contract.json"
sed -i 's/genie-test 1/genie-test 2/' "$test_dir/bin/genie"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" DEVENV_SETUP_OUTER_CACHE_HIT=0 \
    OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_status"
); then
  echo "FAIL: changing Genie binary identity should invalidate Genie warm state"
  exit 1
fi

echo "Genie module option smoke test passed."
