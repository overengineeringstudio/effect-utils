#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected exit code: $expected"
    echo "  actual exit code:   $actual"
    exit 1
  fi
}

extract_ts_emit_script() {
  local attr="$1"
  local output_path="$2"

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
            tscBin = \"tsc\";
          }) {
            pkgs = pkgs;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"ts:emit\".${attr}
  " > "$output_path"
  chmod +x "$output_path"
}

echo "Running ts task smoke test..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

workspace="$tmpdir/workspace"
mkdir -p \
  "$workspace/node_modules/typescript" \
  "$workspace/packages/no-emit" \
  "$workspace/packages/emit" \
  "$tmpdir/bin"

cat > "$workspace/tsconfig.all.json" <<'EOF'
{
  // Root-level comment should be ignored
  "files": [],
  "references": [
    { "path": "packages/no-emit/tsconfig.json" }, // explicit file path
    // This mid-file comment used to break the old JSON.parse path.
    { "path": "packages/emit" }
  ]
}
EOF

cat > "$workspace/packages/no-emit/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    // This comment is intentionally mid-file.
    "composite": true,
    "noEmit": true
  }
}
EOF

cat > "$workspace/packages/emit/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "composite": true,
    // Keep this project in the emit graph.
    "declaration": true
  }
}
EOF

cat > "$workspace/node_modules/typescript/package.json" <<'EOF'
{"name":"typescript","main":"./index.js"}
EOF

cat > "$workspace/node_modules/typescript/index.js" <<'EOF'
const stripLineComments = (source) => {
  let result = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === '\\\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      continue
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1
      }
      if (index < source.length) {
        result += '\n'
      }
      continue
    }

    result += char
  }

  return result
}

const parseJsonc = (source) =>
  JSON.parse(
    stripLineComments(source)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/,\s*([}\]])/g, '$1')
  )

exports.readConfigFile = (filePath, readFile) => {
  try {
    return { config: parseJsonc(readFile(filePath)) }
  } catch (error) {
    return { error: { messageText: String(error.message ?? error) } }
  }
}
EOF

cat > "$tmpdir/bin/tsc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TEST_TSC_LOG:?}"

config_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--build" ]; then
    config_path="$arg"
    break
  fi
  prev="$arg"
done

if [ -z "$config_path" ]; then
  echo "missing --build tsconfig path" >&2
  exit 1
fi

TEST_CAPTURED_TSCONFIG="${TEST_CAPTURED_TSCONFIG:?}" \
node - "$config_path" <<'NODE'
const fs = require('node:fs')

const [configPath] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

if (!Array.isArray(config.references)) {
  throw new Error('references missing from generated emit tsconfig')
}

const paths = config.references.map((reference) => reference.path)
if (paths.includes('packages/no-emit/tsconfig.json')) {
  throw new Error('noEmit project should be removed from generated emit tsconfig')
}
if (!paths.includes('packages/emit')) {
  throw new Error('emit project should remain in generated emit tsconfig')
}

fs.copyFileSync(configPath, process.env.TEST_CAPTURED_TSCONFIG)
NODE
EOF
chmod +x "$tmpdir/bin/tsc"

extract_ts_emit_script "exec" "$tmpdir/ts-emit.exec.sh"
extract_ts_emit_script "status" "$tmpdir/ts-emit.status.sh"

export PATH="$tmpdir/bin:$PATH"
export TEST_TSC_LOG="$tmpdir/tsc.log"
export TEST_CAPTURED_TSCONFIG="$tmpdir/captured-tsconfig.json"

echo "Test 1: ts:emit exec filters noEmit refs even with inline comments"
(
  cd "$workspace"
  bash "$tmpdir/ts-emit.exec.sh"
)
test -f "$TEST_CAPTURED_TSCONFIG"

echo "Test 2: ts:emit status uses the same filtered graph"
(
  cd "$workspace"
  : > "$TEST_TSC_LOG"
  rm -f "$TEST_CAPTURED_TSCONFIG"
  set +e
  bash "$tmpdir/ts-emit.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 0 "$exit_code" "ts:emit status should succeed for an already-clean filtered graph"
)
test -f "$TEST_CAPTURED_TSCONFIG"
grep -q -- '--dry --noCheck --verbose --pretty false' "$TEST_TSC_LOG"

echo ""
echo "ts task smoke test passed"
