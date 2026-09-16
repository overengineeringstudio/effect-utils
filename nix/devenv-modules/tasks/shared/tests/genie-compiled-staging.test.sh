#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

echo "Running Genie compiled import staging cleanup test..."
echo ""

tmpdir="$(mktemp -d)"
linked_packages=()
cleanup() {
  rm -rf "$tmpdir"
  for package in "${linked_packages[@]}"; do
    rm -f "$package"
  done
}
trap cleanup EXIT
# Genie reports realpath-resolved module locations, so the identity assertions below must compare
# against a canonical prefix (`mktemp -d` hands out `/var/...` on macOS, a symlink to
# `/private/var/...`, and `TMPDIR` itself is commonly a symlinked path).
tmpdir="$(cd "$tmpdir" && pwd -P)"

workspace="$tmpdir/workspace"
tmp_root="$tmpdir/os-tmp"
compiled_genie="$tmpdir/genie-compiled"

mkdir -p "$workspace/lib" "$tmp_root"
ln -s "$ROOT/packages/@overeng/genie/node_modules" "$workspace/node_modules"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    opentui_native="core-darwin-arm64"
    oxc_native="binding-darwin-arm64"
    ;;
  Darwin-x86_64)
    opentui_native="core-darwin-x64"
    oxc_native="binding-darwin-x64"
    ;;
  Linux-aarch64)
    opentui_native="core-linux-arm64"
    oxc_native="binding-linux-arm64-gnu"
    ;;
  Linux-x86_64)
    opentui_native="core-linux-x64"
    oxc_native="binding-linux-x64-gnu"
    ;;
  *)
    echo "Unsupported native dependency platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

link_native_package() {
  local scope="$1"
  local package="$2"
  local provider="$3"
  local provider_path
  provider_path="$(realpath "$ROOT/node_modules/$provider")"
  local dependency_root
  case "$provider" in
    @*/*) dependency_root="$(dirname "$(dirname "$provider_path")")" ;;
    *) dependency_root="$(dirname "$provider_path")" ;;
  esac
  local candidate="$dependency_root/$scope/$package"
  if [ ! -d "$candidate" ]; then
    echo "Expected one installed native package for $scope/$package" >&2
    return 1
  fi
  local destination="$ROOT/packages/@overeng/genie/node_modules/$scope/$package"
  if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
    mkdir -p "$(dirname "$destination")"
    ln -s "$candidate" "$destination"
    linked_packages+=("$destination")
  fi
}

link_native_package "@opentui" "$opentui_native" "@opentui/core"
link_native_package "@oxc-parser" "$oxc_native" "oxc-parser"

oxc_parser_candidate="$(realpath "$ROOT/node_modules/oxc-parser")"
if [ ! -d "$oxc_parser_candidate" ]; then
  echo "Expected one installed oxc-parser package" >&2
  exit 1
fi
oxc_parser_destination="$ROOT/packages/@overeng/genie/node_modules/oxc-parser"
if [ ! -e "$oxc_parser_destination" ] && [ ! -L "$oxc_parser_destination" ]; then
  ln -s "$oxc_parser_candidate" "$oxc_parser_destination"
  linked_packages+=("$oxc_parser_destination")
fi

oxc_native_libraries=(
  "$ROOT/node_modules/.pnpm/@oxc-parser+${oxc_native}@"*/node_modules/@oxc-parser/"$oxc_native"/parser."${oxc_native#binding-}".node
)
if [ "${#oxc_native_libraries[@]}" -ne 1 ] || [ ! -f "${oxc_native_libraries[0]}" ]; then
  echo "Expected one installed Oxc native library for $oxc_native" >&2
  exit 1
fi
oxc_native_library="${oxc_native_libraries[0]}"

cat > "$workspace/lib/payload.ts" <<'EOF'
import { Schema } from 'effect'

const NonEmptyString = Schema.String.check(
  Schema.makeFilter((value: string) => value.length > 0, { message: 'Expected a non-empty string' }),
)

export const payload = { hello: Schema.decodeUnknownSync(NonEmptyString)('compiled') }
EOF

cat > "$workspace/demo.json.genie.ts" <<'EOF'
import { payload } from './lib/payload.ts'

export default {
  data: payload,
  stringify: () => JSON.stringify(payload, null, 2),
}
EOF

typescript_package_dir="$(realpath "$ROOT/packages/@overeng/genie/node_modules/typescript")"
typescript_node_modules="$(dirname "$typescript_package_dir")"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) typescript_platform="darwin-arm64" ;;
  Darwin-x86_64) typescript_platform="darwin-x64" ;;
  Linux-aarch64) typescript_platform="linux-arm64" ;;
  Linux-x86_64) typescript_platform="linux-x64" ;;
  *)
    echo "Unsupported TypeScript API server platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac
typescript_api_server="$typescript_node_modules/@typescript/typescript-$typescript_platform/lib/tsc"
if [ ! -x "$typescript_api_server" ]; then
  echo "TypeScript API server is missing or not executable: $typescript_api_server" >&2
  exit 1
fi

echo "Test 1: compiled Genie generates output and exits"
(
  cd "$ROOT"
  bun build packages/@overeng/genie/bin/genie.tsx --compile --no-tree-shaking \
    --outfile "$compiled_genie" >/dev/null
)

for _ in 1 2 3; do
  rm -f "$workspace/demo.json"
  env -u OTEL_EXPORTER_OTLP_ENDPOINT \
    GENIE_TYPESCRIPT_API_SERVER="$typescript_api_server" \
    NAPI_RS_NATIVE_LIBRARY_PATH="$oxc_native_library" \
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

echo "Test 3: compiled Genie strict export proof uses explicit compiler executable"
strict_workspace="$tmpdir/strict-workspace"
fake_compiler="$tmpdir/fake-tsgo"
compiler_log="$tmpdir/fake-tsgo.log"


mkdir -p "$strict_workspace/src"

cat > "$strict_workspace/src/mod.ts" <<'EOF'
export const value = 1
EOF

cat > "$strict_workspace/package.json.genie.ts" <<EOF
import { exportEntry, packageJson } from '$ROOT/packages/@overeng/genie/src/runtime/mod.ts'

export default packageJson({
  name: '@test/compiled-strict-proof',
  version: '1.0.0',
  exports: {
    '.': exportEntry('./src/mod.ts', {
      environment: 'isomorphic-es2024',
      typeProof: 'strict',
    }),
  },
})
EOF

cat > "$fake_compiler" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  echo "Fake TypeScript 1.0.0"
  exit 0
fi
printf "%s\n" "\$@" > "$compiler_log"
EOF
chmod +x "$fake_compiler"

env -u OTEL_EXPORTER_OTLP_ENDPOINT \
  NAPI_RS_NATIVE_LIBRARY_PATH="$oxc_native_library" \
  GENIE_EXPORT_TYPE_PROOF_COMPILER="$fake_compiler" \
  GENIE_TYPESCRIPT_API_SERVER="$typescript_api_server" \
  TMPDIR="$tmp_root" \
  timeout 20s "$compiled_genie" --cwd "$strict_workspace" --output json >/dev/null

grep -q -- '--project' "$compiler_log"

echo "Test 4: compiled Genie keeps each generator's own module identity"
# Staged modules are bundled into one temporary entry before import, so a bundle-wide
# `import.meta` would report the bundle path to every generator. Generators that derive
# their repository and package identity from `import.meta.url` — the Cargo Buck projections
# do — must still see their own source location.
identity_repo="$tmpdir/identity-repo"
mkdir -p "$identity_repo/.git" "$identity_repo/generators"

cat > "$identity_repo/generators/identity.json.genie.ts" <<EOF
import {
  defineRepoContext,
  modulePathFromUrl,
} from '$ROOT/packages/@overeng/genie/src/runtime/repo-context/mod.ts'

// This comment mentions import.meta.url and must not be rewritten.
const repo = defineRepoContext({ name: 'identity-fixture', importMetaUrl: import.meta.url })
const emittedLiteral = 'import.meta.url' // trailing comment: import.meta.filename
const spacedIdentity = modulePathFromUrl(import
  . meta
  . url)
const payload = {
  root: repo.rootPath,
  source: modulePathFromUrl(import.meta.url),
  spacedSource: spacedIdentity,
  emittedLiteral,
}

export default { data: payload, stringify: () => JSON.stringify(payload, null, 2) }
EOF

env -u OTEL_EXPORTER_OTLP_ENDPOINT \
  GENIE_TYPESCRIPT_API_SERVER="$typescript_api_server" \
  NAPI_RS_NATIVE_LIBRARY_PATH="$oxc_native_library" \
  TMPDIR="$tmp_root" \
  timeout 20s "$compiled_genie" --cwd "$identity_repo" --output json >/dev/null

grep -q "\"root\": \"$identity_repo\"" "$identity_repo/generators/identity.json"
grep -q "\"source\": \"$identity_repo/generators/identity.json.genie.ts\"" \
  "$identity_repo/generators/identity.json"
# The pin is syntax-aware: a string literal a generator emits keeps its bytes even though it spells
# the pinned property access, and whitespace-split accesses are still pinned.
grep -q "\"spacedSource\": \"$identity_repo/generators/identity.json.genie.ts\"" \
  "$identity_repo/generators/identity.json"
grep -q '"emittedLiteral": "import.meta.url"' "$identity_repo/generators/identity.json"

echo ""
echo "Genie compiled import staging cleanup tests passed."
