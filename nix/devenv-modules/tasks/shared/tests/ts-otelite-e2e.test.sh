#!/usr/bin/env bash
set -euo pipefail

# Proves the clean devenv OTEL trace contract with real otelite + real otel-span.
# The expensive outer systems are stubbed narrowly:
#   - devenv tasks run delegates to the real evaluated ts:check task exec
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

resolve_otel_scrape() {
  if [ -n "${OTEL_SCRAPE_BIN:-}" ]; then
    printf '%s\n' "$OTEL_SCRAPE_BIN"
  elif command -v otel-scrape >/dev/null 2>&1; then
    command -v otel-scrape
  else
    printf '%s/bin/otel-scrape\n' "$(nix build --no-link --print-out-paths "$ROOT#otel-scrape")"
  fi
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
otel_scrape_bin="$(resolve_otel_scrape)"

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
ln -s "$otel_scrape_bin" "$tmpdir/bin/otel-scrape"

cap="$tmpdir/capture"
env -u TRACEPARENT -u OTEL_TASK_TRACEPARENT -u OTEL_SHELL_ENTRY_NS \
  PATH="$tmpdir/bin:$PATH" DEVENV_ROOT="$tmpdir/workspace" DEVENV_TUI=false \
  "$otelite_bin" run --out "$cap" --protocol http/json -- devenv tasks run ts:check \
  > "$tmpdir/summary.json" 2> "$tmpdir/run.stderr"

"$otelite_bin" inspect "$cap" --signal traces > "$tmpdir/spans.ndjson"

# New cooperation model (decision 0018): task span + one `tsgo` command span +
# the TypeScript phase spans. The pre-0018 blanket otel_scrape.command wrapper and
# its separate otel_scrape.process span are gone (5 spans for this fixture, not 6).
jq -e '.counts.spans >= 5 and .counts.rejected == 0 and .child.exit_code == 0' "$tmpdir/summary.json" >/dev/null \
  || fail "otelite summary should report accepted task/command/phase spans and child exit 0"

span_count="$(wc -l < "$tmpdir/spans.ndjson" | tr -d ' ')"
[ "$span_count" -ge 5 ] || fail "expected at least 5 inspected spans, got $span_count"

trace_count="$(jq -r '.trace_id' "$tmpdir/spans.ndjson" | sort -u | wc -l | tr -d ' ')"
[ "$trace_count" -eq 1 ] || fail "expected one trace id, got $trace_count"

jq -s -e 'all(.[]; (.service | type == "string") and (.service | length > 0))' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "all spans should carry service.name"
jq -s -e '
  all(
    [.[] | select(.name == "devenv.task.exec" or .name == "typescript.project.check" or .name == "typescript.build.aggregate")][];
    .service == "effect-utils-devenv"
  )
' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "task and TypeScript spans should use service.name=effect-utils-devenv"

# Decision 0018 — devenv task cooperation: the TASK span (otel-span
# devenv.task.exec) owns the task level; there is NO generic otel-scrape wrapper
# ABOVE it. otel-scrape wraps only the concrete compiler BENEATH the task span,
# yielding a `tsgo`-named command span (adapter=none). The TypeScript phase spans
# are emitted from the task shell (outside otel-scrape) and so remain task-
# siblings of the `tsgo` span (experiment 0009 wrap-only-compiler tradeoff).
jq -s -e 'all(.[]; .name != "otel_scrape.command")' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "blanket otel_scrape.command wrapper span should be gone (decision 0018)"

task_span="$(jq -r 'select(.name == "devenv.task.exec") | .span_id' "$tmpdir/spans.ndjson")"
[ -n "$task_span" ] || fail "missing devenv.task.exec task span"

cmd_span="$(jq -r 'select(.name == "tsgo") | .span_id' "$tmpdir/spans.ndjson")"
[ -n "$cmd_span" ] || fail "missing tsgo command span (compiler-level otel-scrape instrumentation)"

jq -s -e --arg task "$task_span" 'any(.[]; .name == "tsgo" and .parent_span_id == $task)' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "tsgo command span should parent to devenv.task.exec"
jq -s -e --arg task "$task_span" '
  all([.[] | select(.name == "typescript.project.check" or .name == "typescript.build.aggregate")][]; .parent_span_id == $task)
' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "TypeScript phase spans should parent to devenv.task.exec (task-siblings of tsgo)"

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

trace_id="$(jq -r 'select(.name == "devenv.task.exec") | .trace_id' "$tmpdir/spans.ndjson")"
task_label="$(jq -r 'select(.name == "devenv.task.exec") | .attrs["span.label"]' "$tmpdir/spans.ndjson")"

echo "Trace tree preview"
echo "trace $trace_id"
echo "\`-- effect-utils-devenv devenv.task.exec [$task_label] span=$task_span"
echo "    |-- effect-utils-devenv tsgo [command] span=$cmd_span parent=$task_span"
jq -r -s --arg task "$task_span" '
  [.[] | select(.parent_span_id == $task and (.name == "typescript.project.check" or .name == "typescript.build.aggregate"))]
  | sort_by(.name, .attrs["span.label"])
  | to_entries as $items
  | $items[]
  | "    " + (if .key + 1 == ($items | length) then "`-- " else "|-- " end)
    + .value.service + " " + .value.name + " ["
    + .value.attrs["span.label"] + "] span=" + .value.span_id
    + " parent=" + .value.parent_span_id
    + " total_s=" + (.value.attrs["typescript.total_time_s"] // "?")
' "$tmpdir/spans.ndjson"

echo ""
echo "ts otelite e2e test passed"
