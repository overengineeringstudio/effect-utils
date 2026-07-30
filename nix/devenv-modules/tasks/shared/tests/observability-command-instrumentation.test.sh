#!/usr/bin/env bash
set -euo pipefail

# Proves that the observability module's opt-in command instrumentation supplies
# the real otel-scrape binary and that trace.instr composes it beneath a task
# span. Expensive devenv evaluation is replaced only by a basename-preserving
# command stub; otelite, otel-span, and otel-scrape are all real.

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

module_attr() {
  local enabled="$1"
  local attr="$2"
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake (\"git+file://\" + toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (flake.devenvModules.observability {
        project = \"module-smoke\";
        profile = null;
        commandInstrumentation = $enabled;
      }) {
        inherit pkgs;
        lib = pkgs.lib;
      };
    in module.env.$attr
  "
}

echo "Running observability command-instrumentation test..."

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
mkdir -p "$tmpdir/bin"

disabled_has_scrape="$(nix eval --impure --json --expr "
  let
    flake = builtins.getFlake (\"git+file://\" + toString $ROOT);
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    module = (flake.devenvModules.observability {
      project = \"module-smoke\";
      profile = null;
      commandInstrumentation = false;
    }) {
      inherit pkgs;
      lib = pkgs.lib;
    };
  in builtins.hasAttr \"OTEL_SCRAPE_BIN\" module.env
")"
[ "$disabled_has_scrape" = "false" ] \
  || fail "disabled module should not expose OTEL_SCRAPE_BIN"

disabled_supplies_scrape="$(nix eval --impure --json --expr "
  let
    flake = builtins.getFlake (\"git+file://\" + toString $ROOT);
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    module = (import $ROOT/nix/devenv-modules/observability.nix {
      project = \"module-smoke\";
      profile = null;
      commandInstrumentation = false;
    }) {
      inherit pkgs;
      lib = pkgs.lib;
    };
  in builtins.any (package: (package.meta.mainProgram or null) == \"otel-scrape\") module.packages
")"
[ "$disabled_supplies_scrape" = "false" ] \
  || fail "disabled module should not add otel-scrape to packages"

otel_span_bin="$(module_attr true OTEL_SPAN_BIN)"
otel_scrape_bin="$(module_attr true OTEL_SCRAPE_BIN)"
otelite_bin="$(nix build --no-link --print-out-paths "$ROOT#otelite")/bin/otelite"

[ -x "$otel_span_bin" ] || fail "enabled module should provide executable otel-span"
[ -x "$otel_scrape_bin" ] || fail "enabled module should provide executable otel-scrape"
[ -x "$otelite_bin" ] || fail "otelite should be executable"

otel_scrape_version="$("$otel_scrape_bin" --version 2>/dev/null)"
case "$otel_scrape_version" in
  "otel-scrape 0.0.0+"*)
    ;;
  *)
    fail "module-provided otel-scrape should carry a build-correlated machine version"
    ;;
esac
case "$otel_scrape_version" in
  *"+unknown"* | *"+dev"*)
    fail "module-provided otel-scrape should preserve the flake source stamp"
    ;;
esac

nix eval --impure --raw --expr "
  let
    flake = builtins.getFlake (\"git+file://\" + toString $ROOT);
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    trace = import $ROOT/nix/devenv-modules/tasks/lib/trace.nix { lib = pkgs.lib; };
  in trace.exec \"test:command-instrumentation\" ''
    \${trace.instr {
      adapter = \"none\";
      name = \"devenv:build:test-output\";
    }}
    \"''\${_otel_instr[@]}\" devenv build outputs.example
  ''
" > "$tmpdir/task-exec.sh"
chmod +x "$tmpdir/task-exec.sh"

cat > "$tmpdir/bin/devenv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$#" -eq 2 ] && [ "$1" = build ] && [ "$2" = outputs.example ]
EOF
chmod +x "$tmpdir/bin/devenv"

capture="$tmpdir/capture"
env -u TRACEPARENT -u OTEL_TASK_TRACEPARENT -u OTEL_SHELL_ENTRY_NS \
  PATH="$tmpdir/bin:$PATH" \
  DEVENV_ROOT="$tmpdir/workspace" \
  OTEL_DEVENV_PROJECT="module-smoke" \
  OTEL_SPAN_BIN="$otel_span_bin" \
  OTEL_SCRAPE_BIN="$otel_scrape_bin" \
  "$otelite_bin" run --out "$capture" --protocol http/json -- bash "$tmpdir/task-exec.sh" \
  > "$tmpdir/summary.json"

"$otelite_bin" inspect "$capture" --signal traces > "$tmpdir/spans.ndjson"

jq -e '
  .child.exit_code == 0
  and .counts.rejected == 0
  and .counts.spans == 2
' "$tmpdir/summary.json" >/dev/null \
  || fail "capture should contain exactly the accepted task and command spans"

task_span="$(jq -r 'select(.name == "devenv.task.exec") | .span_id' "$tmpdir/spans.ndjson")"
[ -n "$task_span" ] || fail "missing devenv.task.exec task span"

jq -s -e --arg task "$task_span" '
  ([.[].trace_id] | unique | length) == 1
  and any(.[];
    .service == "effect-utils-devenv"
    and .name == "devenv.task.exec"
    and .attrs["task.name"] == "test:command-instrumentation"
    and .attrs["devenv.project.name"] == "module-smoke"
  )
  and any(.[];
    .service == "effect-utils-devenv"
    and .name == "devenv"
    and .attrs["otel_scrape.span.origin"] == "otel-scrape"
    and .parent_span_id == $task
  )
' "$tmpdir/spans.ndjson" >/dev/null \
  || fail "real devenv command span should be a direct child of the task span"

echo "observability command-instrumentation test passed"
