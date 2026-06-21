#!/usr/bin/env bash
set -euo pipefail

# Proves the clean devenv OTEL trace contract with real otelite + real otel-span.
# The expensive outer systems are stubbed narrowly:
#   - dt is the real evaluated dt wrapper
#   - devenv delegates to the real evaluated ts:check task exec
#   - tsgo prints the captured extendedDiagnostics fixture

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
FIXTURE="$TESTS_DIR/fixtures/tsgo-extended-diagnostics.txt"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

resolve_otelite() {
  if [ -n "${OTELITE_BIN:-}" ]; then
    printf '%s\n' "$OTELITE_BIN"
  elif command -v otelite >/dev/null 2>&1; then
    command -v otelite
  else
    printf '%s/bin/otelite\n' "$(nix build --no-link --print-out-paths "$ROOT#otelite")"
  fi
}

resolve_otel_span() {
  if [ -n "${OTEL_SPAN_BIN:-}" ]; then
    printf '%s\n' "$OTEL_SPAN_BIN"
  elif command -v otel-span >/dev/null 2>&1; then
    command -v otel-span
  else
    nix build --no-link --print-out-paths --impure --expr "
      let
        flake = builtins.getFlake (toString $ROOT);
        pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      in import $ROOT/nix/devenv-modules/otel/otel-span.nix { inherit pkgs; }
    " | sed 's|$|/bin/otel-span|'
  fi
}

extract_dt_body() {
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in (import $ROOT/nix/devenv-modules/dt.nix { inherit pkgs; }).scripts.dt.exec
  "
}

extract_ts_check_exec() {
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/ts.nix {
            tsconfigFile = \"tsconfig.all.json\";
          }) {
            pkgs = pkgs;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"ts:check\".exec
  "
}

echo "Running ts otelite e2e test..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
mkdir -p "$tmpdir/bin"

otelite_bin="$(resolve_otelite)"
otel_span_bin="$(resolve_otel_span)"

{
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  extract_dt_body
} > "$tmpdir/bin/dt"
chmod +x "$tmpdir/bin/dt"

extract_ts_check_exec > "$tmpdir/ts-check.exec.sh"
chmod +x "$tmpdir/ts-check.exec.sh"

cat > "$tmpdir/bin/devenv" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = tasks ] && [ "\${2:-}" = run ] && [ "\${3:-}" = ts:check ] || {
  echo "unexpected devenv args: \$*" >&2
  exit 64
}
exec "$tmpdir/ts-check.exec.sh"
EOF
chmod +x "$tmpdir/bin/devenv"

cat > "$tmpdir/bin/tsgo" <<EOF
#!/usr/bin/env bash
cat "$FIXTURE"
EOF
chmod +x "$tmpdir/bin/tsgo"

ln -s "$otel_span_bin" "$tmpdir/bin/otel-span"

cap="$tmpdir/capture"
PATH="$tmpdir/bin:$PATH" DEVENV_ROOT="$tmpdir/workspace" \
  "$otelite_bin" run --out "$cap" --protocol http/json -- dt ts:check \
  > "$tmpdir/summary.json" 2> "$tmpdir/run.stderr"

"$otelite_bin" inspect "$cap" --signal traces > "$tmpdir/spans.ndjson"

jq -e '.counts.spans == 5 and .counts.rejected == 0 and .child.exit_code == 0' "$tmpdir/summary.json" >/dev/null \
  || fail "otelite summary should report 5 accepted spans and child exit 0"

span_count="$(wc -l < "$tmpdir/spans.ndjson" | tr -d ' ')"
[ "$span_count" -eq 5 ] || fail "expected 5 inspected spans, got $span_count"

trace_count="$(jq -r '.trace_id' "$tmpdir/spans.ndjson" | sort -u | wc -l | tr -d ' ')"
[ "$trace_count" -eq 1 ] || fail "expected one trace id, got $trace_count"

service_count="$(jq -r '.service' "$tmpdir/spans.ndjson" | sort -u | wc -l | tr -d ' ')"
[ "$service_count" -eq 1 ] || fail "expected one service.name, got $service_count"
jq -s -e 'all(.[]; .service == "effect-utils-devenv")' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "all spans should use service.name=effect-utils-devenv"

root_span="$(jq -r 'select(.name == "dt.run") | .span_id' "$tmpdir/spans.ndjson")"
task_span="$(jq -r 'select(.name == "devenv.task.exec") | .span_id' "$tmpdir/spans.ndjson")"
[ -n "$root_span" ] || fail "missing dt.run root span"
[ -n "$task_span" ] || fail "missing devenv.task.exec child span"

jq -s -e --arg root "$root_span" 'any(.[]; .name == "devenv.task.exec" and .parent_span_id == $root)' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "devenv.task.exec should parent to dt.run"
jq -s -e --arg task "$task_span" '
  all([.[] | select(.name == "typescript.project.check" or .name == "typescript.build.aggregate")][]; .parent_span_id == $task)
' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "TypeScript spans should parent to devenv.task.exec"

jq -s -e 'any(.[]; .name == "dt.run" and .attrs["tool.name"] == "dt" and .attrs["task.name"] == "ts:check" and .attrs["dt.fresh"] == "false")' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "dt.run is missing typed dt attrs"
jq -s -e 'any(.[]; .name == "devenv.task.exec" and .attrs["tool.name"] == "devenv" and .attrs["task.cached"] == "false" and .attrs["task.phase"] == "exec")' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "task span is missing typed task attrs"
jq -s -e 'any(.[]; .name == "typescript.project.check" and .attrs["span.label"] == "socket" and .attrs["ts.project"] == "context/effect/socket" and .attrs["typescript.total_time_s"] == "0.339")' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "socket TypeScript project span missing typed attrs"
jq -s -e 'any(.[]; .name == "typescript.build.aggregate" and .attrs["span.label"] == "aggregate" and .attrs["typescript.aggregate"] == "true" and .attrs["typescript.projects_built"] == "34")' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "aggregate TypeScript span missing typed attrs"

grep -q "warning TS377030" "$tmpdir/run.stderr" \
  || fail "tsgo warning should surface through the traced path"
if grep -qE "^(Files:|Parse time:|Total time:|Aggregate)" "$tmpdir/run.stderr"; then
  fail "diagnostic timing scaffolding leaked into stderr"
fi

trace_id="$(jq -r 'select(.name == "dt.run") | .trace_id' "$tmpdir/spans.ndjson")"
root_label="$(jq -r 'select(.name == "dt.run") | .attrs["span.label"]' "$tmpdir/spans.ndjson")"
task_label="$(jq -r 'select(.name == "devenv.task.exec") | .attrs["span.label"]' "$tmpdir/spans.ndjson")"

echo "Trace tree preview"
echo "trace $trace_id"
echo "\`-- effect-utils-devenv dt.run [$root_label] span=$root_span"
echo "    \`-- effect-utils-devenv devenv.task.exec [$task_label] span=$task_span parent=$root_span"
jq -r -s --arg task "$task_span" '
  [.[] | select(.parent_span_id == $task and (.name == "typescript.project.check" or .name == "typescript.build.aggregate"))]
  | sort_by(.name, .attrs["span.label"])
  | to_entries as $items
  | $items[]
  | "        " + (if .key + 1 == ($items | length) then "`-- " else "|-- " end)
    + .value.service + " " + .value.name + " ["
    + .value.attrs["span.label"] + "] span=" + .value.span_id
    + " parent=" + .value.parent_span_id
    + " total_s=" + (.value.attrs["typescript.total_time_s"] // "?")
' "$tmpdir/spans.ndjson"

echo ""
echo "ts otelite e2e test passed"
