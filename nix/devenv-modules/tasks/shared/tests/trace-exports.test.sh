#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

eval_trace() {
  local method="$1"
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      trace = import $ROOT/nix/devenv-modules/tasks/lib/trace.nix { lib = pkgs.lib; };
    in trace.$method \"test:export\" [ \"EXPORTED_VALUE\" ] \"export EXPORTED_VALUE=from-child\"
  "
}

fake_otel_span="$tmpdir/otel-span"
cat > "$fake_otel_span" <<'EOF'
#!/usr/bin/env bash
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  shift
done
[ "${1:-}" = "--" ] || exit 64
shift
exec "$@"
EOF
chmod +x "$fake_otel_span"

decode_export() {
  local exports_file="$1"
  local name encoded
  while IFS= read -r -d '' name && IFS= read -r -d '' encoded; do
    if [ "$name" = "EXPORTED_VALUE" ]; then
      printf '%s' "$encoded" | base64 --decode
      return
    fi
  done < "$exports_file"
}

echo "Running traced task export tests..."

traced_exec="$tmpdir/traced-exec.sh"
eval_trace execWithExports > "$traced_exec"

exports_file="$tmpdir/traced.exports"
: > "$exports_file"
DEVENV_TASK_EXPORTS_FILE="$exports_file" \
  OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318" \
  OTEL_SPAN_BIN="$fake_otel_span" \
  bash "$traced_exec"
[ "$(decode_export "$exports_file")" = "from-child" ] \
  || fail "trace.execWithExports must persist values from inside the traced child"

exports_file="$tmpdir/bare.exports"
: > "$exports_file"
DEVENV_TASK_EXPORTS_FILE="$exports_file" \
  OTEL_EXPORTER_OTLP_ENDPOINT="" \
  OTEL_SPAN_BIN="$fake_otel_span" \
  bash "$traced_exec"
[ "$(decode_export "$exports_file")" = "from-child" ] \
  || fail "trace.execWithExports must preserve bare execution semantics"

missing_exec="$tmpdir/missing-exec.sh"
nix eval --impure --raw --expr "
  let
    flake = builtins.getFlake (toString $ROOT);
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    trace = import $ROOT/nix/devenv-modules/tasks/lib/trace.nix { lib = pkgs.lib; };
  in trace.execWithExports \"test:export\" [ \"EXPORTED_VALUE\" ] \"unset EXPORTED_VALUE\"
" > "$missing_exec"

exports_file="$tmpdir/missing.exports"
: > "$exports_file"
DEVENV_TASK_EXPORTS_FILE="$exports_file" \
  OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318" \
  OTEL_SPAN_BIN="$fake_otel_span" \
  bash "$missing_exec"
[ ! -s "$exports_file" ] \
  || fail "trace.execWithExports must not invent an unset export"

echo "traced task export tests passed"
