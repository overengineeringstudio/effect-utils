#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

echo "Running Genie compiled import staging cleanup test..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

workspace="$tmpdir/workspace"
tmp_root="$tmpdir/os-tmp"
compiled_genie="$tmpdir/genie-compiled"

mkdir -p "$workspace/lib" "$tmp_root"

cat > "$workspace/lib/payload.ts" <<'EOF'
export const payload = { hello: 'compiled' }
EOF

cat > "$workspace/demo.json.genie.ts" <<'EOF'
import { payload } from './lib/payload.ts'

export default {
  data: payload,
  stringify: () => JSON.stringify(payload, null, 2),
}
EOF

echo "Test 1: compiled Genie generates output and exits"
(
  cd "$ROOT"
  bun build packages/@overeng/genie/bin/genie.tsx --compile --outfile "$compiled_genie" >/dev/null
)

for _ in 1 2 3; do
  rm -f "$workspace/demo.json"
  env -u OTEL_EXPORTER_OTLP_ENDPOINT \
    TMPDIR="$tmp_root" \
    timeout 20s "$compiled_genie" --cwd "$workspace" --output json >/dev/null
done

grep -q '"hello": "compiled"' "$workspace/demo.json"

echo "Test 2: compiled import staging dirs are removed after each run"
leaked_count="$(find "$tmp_root" -maxdepth 1 -mindepth 1 -type d -name 'genie-import-*' | wc -l | tr -d ' ')"
if [ "$leaked_count" != "0" ]; then
  find "$tmp_root" -maxdepth 1 -mindepth 1 -type d -name 'genie-import-*' -print >&2
  echo "Expected 0 leaked genie-import-* dirs, found $leaked_count" >&2
  exit 1
fi

echo ""
echo "Genie compiled import staging cleanup tests passed."
