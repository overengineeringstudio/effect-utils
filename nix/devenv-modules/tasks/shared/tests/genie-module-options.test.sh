#!/usr/bin/env bash
set -euo pipefail
# Hooks export repository-local variables; every fixture and child owns its repo.
mapfile -t git_local_env < <(git rev-parse --local-env-vars)
unset "${git_local_env[@]}"

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

eval_genie_module_attr() {
  local module_config="$1"
  local attr_expr="$2"
  local extra_modules="${3:-}"

  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          $ROOT/nix/devenv-modules/tasks/shared/genie.nix
          $extra_modules
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

echo "Checking every Genie entrypoint waits for member setup when enabled..."
for lint_module in lint-genie lint-oxc; do
  lint_import="$ROOT/nix/devenv-modules/tasks/shared/$lint_module.nix"
  if [ "$lint_module" = lint-oxc ]; then
    lint_import="(import $lint_import { geniePatterns = []; genieCoverageDirs = []; })"
  fi
  graph="$(eval_genie_module_attr \
    '{}' \
    'builtins.toJSON (builtins.mapAttrs (_: task: task.after or [ ]) evaluated.config.tasks)' \
    "$lint_import (import $ROOT/nix/devenv-modules/tasks/shared/megarepo.nix {})")"
  GRAPH="$graph" node --input-type=module <<'EOF'
const graph = JSON.parse(process.env.GRAPH)
const reaches = (task, target, seen = new Set()) => {
  if (task === target) return true
  if (seen.has(task)) return false
  seen.add(task)
  return (graph[task] ?? []).some((dependency) => reaches(dependency, target, seen))
}
for (const task of ['genie:run', 'genie:check', 'genie:watch', 'lint:check:genie']) {
  if (!reaches(task, 'mr:setup')) throw new Error(`${task} can race member setup`)
}
if (reaches('mr:setup', 'genie:prepare')) throw new Error('member setup depends on Genie')
EOF
done
prepare_after="$(eval_genie_module_attr '{}' 'builtins.toJSON evaluated.config.tasks."genie:prepare".after')"
if [ "$prepare_after" != '[]' ]; then
  echo "FAIL: standalone Genie must not depend on an undefined mr:setup"
  exit 1
fi

echo "Checking commentless generated JSON ownership and warm-state drift..."
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin"
mkdir -p "$test_dir/semantic/nested"

cat > "$test_dir/bin/genie" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo "genie-test 1"
  exit 0
fi
if [ -f pnpm-lock.yaml ]; then
  mkdir -p buck2/dependencies
  sha256sum pnpm-lock.yaml > buck2/dependencies/BUCK
  sha256sum pnpm-lock.yaml > buck2/dependencies/pnpm-lock.sha256.json
fi
if [ -n "${GENIE_INPUT_MANIFEST:-}" ] && [ "${GENIE_FIXTURE_INPUTS:-current}" != old ]; then
  printf '%s\n' "${GENIE_FIXTURE_MANIFEST_VERSION:-genie-inputs-v1}" \
    "$PWD/pnpm-lock.yaml" "$PWD/optional-input.json" "$PWD/semantic/nested" > "$GENIE_INPUT_MANIFEST"
fi
EOF
chmod +x "$test_dir/bin/genie"

git -C "$test_dir" init -q
printf 'export default {}\n' > "$test_dir/contract.json.genie.ts"
printf '{"value":1}\n' > "$test_dir/contract.json"
mkdir -p "$test_dir/nested"
printf 'export default {}\n' > "$test_dir/nested/contract.json.genie.ts"
printf '{"nested":true}\n' > "$test_dir/nested/contract.json"
printf 'direct one\n' > "$test_dir/semantic/direct.ts"
printf 'nested one\n' > "$test_dir/semantic/nested/input.ts"
printf 'lockfileVersion: 9\n' > "$test_dir/pnpm-lock.yaml"
mkdir -p "$test_dir/buck2/dependencies"
printf 'export default {}\n' > "$test_dir/buck2/dependencies/BUCK.genie.ts"
printf 'export default {}\n' > "$test_dir/buck2/dependencies/pnpm-lock.sha256.json.genie.ts"
git -C "$test_dir" add \
  contract.json.genie.ts contract.json \
  nested/contract.json.genie.ts nested/contract.json \
  semantic/direct.ts semantic/nested/input.ts

module_config='{ effectUtils.genie.extraInputGlobs = [ "semantic/**/*.ts" ]; }'
run_exec="$(eval_genie_module_attr "$module_config" 'evaluated.config.tasks."genie:run".exec')"
run_status="$(eval_genie_module_attr "$module_config" 'evaluated.config.tasks."genie:run".status')"
check_exec="$(eval_genie_module_attr "$module_config" 'evaluated.config.tasks."genie:check".exec')"
(
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
)
run_fixture() {
  (
    cd "$test_dir"
    PATH="$test_dir/bin:$PATH" DEVENV_SETUP_OUTER_CACHE_HIT="$1" \
      OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
      bash -c "$2"
  )
}

echo "Checking lock-derived projections invalidate the warm cache without input globs..."
for outer_hit in 0 1; do
  run_fixture "$outer_hit" "$run_status"
  previous_output="$(cat "$test_dir/buck2/dependencies/BUCK")"
  printf '# changed lock %s\n' "$outer_hit" >> "$test_dir/pnpm-lock.yaml"
  if run_fixture "$outer_hit" "$run_status"; then
    echo "FAIL: pnpm-lock.yaml drift reused warm Genie state (outer hit=$outer_hit)"
    exit 1
  fi
  run_fixture "$outer_hit" "$run_exec"
  if [ "$(cat "$test_dir/buck2/dependencies/BUCK")" = "$previous_output" ]; then
    echo "FAIL: warm Genie run did not regenerate the lock-derived BUCK output"
    exit 1
  fi
  cmp "$test_dir/buck2/dependencies/BUCK" "$test_dir/buck2/dependencies/pnpm-lock.sha256.json"
  run_fixture "$outer_hit" "$run_status"
done

printf '{}\n' > "$test_dir/optional-input.json"
if run_fixture 1 "$run_status"; then
  echo "FAIL: creating a recorded missing input should invalidate Genie warm state"
  exit 1
fi
run_fixture 1 "$run_exec"
rm "$test_dir/optional-input.json"
if run_fixture 1 "$run_status"; then
  echo "FAIL: deleting a recorded input should invalidate Genie warm state"
  exit 1
fi
run_fixture 1 "$run_exec"

printf 'new member\n' > "$test_dir/semantic/nested/new.txt"
if run_fixture 1 "$run_status"; then
  echo "FAIL: adding a member to a recorded directory should invalidate Genie warm state"
  exit 1
fi
run_fixture 1 "$run_exec"
rm "$test_dir/semantic/nested/new.txt"
if run_fixture 1 "$run_status"; then
  echo "FAIL: removing a recorded directory member should invalidate Genie warm state"
  exit 1
fi
run_fixture 1 "$run_exec"

echo "Checking version skew never reuses an incomplete input fingerprint..."
for fixture_mode in old unknown; do
  if [ "$fixture_mode" = old ]; then
    export GENIE_FIXTURE_INPUTS=old
  else
    export GENIE_FIXTURE_MANIFEST_VERSION=genie-inputs-future
  fi
  # A previous successful manifest must not authorize the older/unknown CLI.
  run_fixture 1 "$run_exec"
  printf '# skewed lock %s\n' "$fixture_mode" >> "$test_dir/pnpm-lock.yaml"
  for outer_hit in 0 1; do
    if run_fixture "$outer_hit" "$run_status"; then
      echo "FAIL: unsupported input manifest reused warm state ($fixture_mode, outer hit=$outer_hit)"
      exit 1
    fi
  done
  run_fixture 1 "$run_exec"
  expected_output="$(cd "$test_dir" && sha256sum pnpm-lock.yaml)"
  [ "$(cat "$test_dir/buck2/dependencies/BUCK")" = "$expected_output" ]
  [ "$(cat "$test_dir/buck2/dependencies/pnpm-lock.sha256.json")" = "$expected_output" ]
  unset GENIE_FIXTURE_INPUTS GENIE_FIXTURE_MANIFEST_VERSION
  run_fixture 1 "$run_exec"
  run_fixture 1 "$run_status"
done

if ! grep -qxF 'contract.json' "$test_dir/.devenv/task-cache/genie-run/generated-files.txt"; then
  echo "FAIL: direct commentless JSON paired with a .genie.ts source was not collected"
  exit 1
fi
if ! grep -qxF 'nested/contract.json' "$test_dir/.devenv/task-cache/genie-run/generated-files.txt"; then
  echo "FAIL: nested commentless JSON paired with a .genie.ts source was not collected"
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
(
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
)
printf 'direct two\n' > "$test_dir/semantic/direct.ts"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" DEVENV_SETUP_OUTER_CACHE_HIT=0 \
    OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_status"
); then
  echo "FAIL: changing a direct extraInputGlobs match should invalidate Genie warm state"
  exit 1
fi

printf 'direct one\n' > "$test_dir/semantic/direct.ts"
(
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
)
printf 'nested two\n' > "$test_dir/semantic/nested/input.ts"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" DEVENV_SETUP_OUTER_CACHE_HIT=0 \
    OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_status"
); then
  echo "FAIL: changing a nested extraInputGlobs match should invalidate Genie warm state"
  exit 1
fi

printf 'nested one\n' > "$test_dir/semantic/nested/input.ts"
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

retained_state="$(cat "$test_dir/.devenv/task-cache/genie-run/state.hash")"
rm "$test_dir/contract.json.genie.ts"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
); then
  echo "FAIL: deleting a Genie owner while retaining its generated output should fail closed"
  exit 1
fi
if ! grep -qxF 'contract.json' "$test_dir/.devenv/task-cache/genie-run/generated-files.txt"; then
  echo "FAIL: rejected owner deletion should retain the previous ownership manifest"
  exit 1
fi
if [ "$(cat "$test_dir/.devenv/task-cache/genie-run/state.hash")" != "$retained_state" ]; then
  echo "FAIL: rejected owner deletion should retain the previous warm-state hash"
  exit 1
fi

rm "$test_dir/contract.json"
(
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
)
if grep -qxF 'contract.json' "$test_dir/.devenv/task-cache/genie-run/generated-files.txt"; then
  echo "FAIL: deleting an owner and its output together should retire retained ownership"
  exit 1
fi

echo "Checking stateless output-side ownership..."
printf 'export default {}\n' > "$test_dir/marked.txt.genie.ts"
printf '%s\n' '// Generated file - DO NOT EDIT' '// Source: marked.txt.genie.ts' 'value' \
  > "$test_dir/marked.txt"
printf 'export default {}\n' > "$test_dir/projection.json.genie.ts"
printf '%s\n' '{' '  "provenance": {' \
  '    "source": "projection.json.genie.ts",' \
  '    "warning": "GENERATED FILE - DO NOT EDIT"' '  }' '}' \
  > "$test_dir/projection.json"
git -C "$test_dir" add \
  marked.txt.genie.ts marked.txt projection.json.genie.ts projection.json
(
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
)

rm "$test_dir/marked.txt.genie.ts"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
); then
  echo "FAIL: a marked output whose declared owner is missing should fail closed"
  exit 1
fi
rm "$test_dir/marked.txt"

# A fresh CI checkout has no retained local ownership manifest. The embedded
# source in commentless JSON is therefore the stateless ownership authority.
rm "$test_dir/projection.json.genie.ts"
rm -rf "$test_dir/.devenv"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$check_exec"
); then
  echo "FAIL: fresh Genie check should reject commentless JSON whose declared owner is missing"
  exit 1
fi

echo "Genie module option smoke test passed."
