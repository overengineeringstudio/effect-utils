#!/usr/bin/env bash

compute_hash() {
  sha256sum | awk '{print $1}'
}

ensure_local_pnpm_home_default() {
  local workspace_root="$1"

  if [ -z "${PNPM_HOME:-}" ]; then
    export PNPM_HOME="${workspace_root}/.pnpm-home"
  fi
}

emit_dir_state() {
  local dir="$1"

  if [ ! -d "$dir" ]; then
    return
  fi

  find "$dir" \
    \( \
      -name .git -o \
      -name .devenv -o \
      -name .turbo -o \
      -name .cache -o \
      -name node_modules -o \
      -name dist -o \
      -name coverage -o \
      -name result -o \
      -name tmp \
    \) -prune -o -type f -print \
    | LC_ALL=C sort \
    | while IFS= read -r file; do
      printf '%s ' "${file#"$dir"/}"
      sha256sum "$file" | awk '{print $1}'
    done
}

resolve_gvs_links_dir() {
  # pnpm 11 stores the GVS links under the effective store-dir. Prefer the
  # explicit store setting when tasks share storage across isolated PNPM_HOME
  # directories.
  if [ -n "${npm_config_store_dir:-}" ]; then
    printf '%s\n' "${npm_config_store_dir}/v11/links"
  elif [ -n "${PNPM_STORE_DIR:-}" ]; then
    printf '%s\n' "${PNPM_STORE_DIR}/v11/links"
  elif [ -n "${PNPM_HOME:-}" ]; then
    printf '%s\n' "${PNPM_HOME}/store/v11/links"
  elif [ -n "${XDG_DATA_HOME:-}" ] && [ -d "${XDG_DATA_HOME}/pnpm/store/v11" ]; then
    printf '%s\n' "${XDG_DATA_HOME}/pnpm/store/v11/links"
  elif [ -d "$HOME/.local/share/pnpm/store/v11" ]; then
    printf '%s\n' "$HOME/.local/share/pnpm/store/v11/links"
  elif [ -d "$HOME/Library/pnpm/store/v11" ]; then
    printf '%s\n' "$HOME/Library/pnpm/store/v11/links"
  fi
}

cache_fingerprint() {
  local workspace_state_hash="$1"
  local gvs_links_dir="$2"

  # pnpm 11 bakes absolute paths into the live GVS projection, so two installs
  # with identical manifests but different projection roots are not equivalent.
  {
    printf '%s\n' "$workspace_state_hash"
    printf '%s\n' "$gvs_links_dir"
  } | compute_hash
}

resolve_pnpm_install_contract_file() {
  local dir="${1:-$PWD}"

  while [ "$dir" != "/" ]; do
    if [ -f "$dir/pnpm-install-contract.json" ]; then
      printf '%s\n' "$dir/pnpm-install-contract.json"
      return 0
    fi

    dir="$(dirname "$dir")"
  done

  return 1
}

pnpm_contract_section_json() {
  local node_bin="$1"
  local contract_file="$2"
  local section="$3"

  "$node_bin" - "$contract_file" "$section" <<'EOF'
const fs = require('node:fs')

const [contractFile, section] = process.argv.slice(2)
const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'))

const stableJson = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableJson)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableJson(nested)]),
  )
}

if (!Object.prototype.hasOwnProperty.call(contract, section)) {
  console.error(`[pnpm] pnpm install contract ${contractFile} has no section '${section}'`)
  process.exit(1)
}

process.stdout.write(`${JSON.stringify(stableJson(contract[section]))}\n`)
EOF
}

compute_pnpm_contract_section_hash() {
  local node_bin="$1"
  local contract_file="$2"
  local section="$3"

  pnpm_contract_section_json "$node_bin" "$contract_file" "$section" | compute_hash
}

classify_pnpm_contract_change() {
  local node_bin="$1"
  local previous_contract="$2"
  local current_contract="$3"

  "$node_bin" - "$previous_contract" "$current_contract" <<'EOF'
const fs = require('node:fs')
const crypto = require('node:crypto')

const [previousContractFile, currentContractFile] = process.argv.slice(2)

const stableJson = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableJson)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableJson(nested)]),
  )
}

const sectionHash = (contract, section, contractFile) => {
  if (!Object.prototype.hasOwnProperty.call(contract, section)) {
    console.error(`[pnpm] pnpm install contract ${contractFile} has no section '${section}'`)
    process.exit(1)
  }

  return crypto
    .createHash('sha256')
    .update(`${JSON.stringify(stableJson(contract[section]))}\n`)
    .digest('hex')
}

const previousContract = JSON.parse(fs.readFileSync(previousContractFile, 'utf8'))
const currentContract = JSON.parse(fs.readFileSync(currentContractFile, 'utf8'))

for (const [section, reason] of [
  ['packageManager', 'toolchain'],
  ['gvsLinkContract', 'gvs-link'],
  ['installPolicy', 'policy'],
  ['storeContract', 'store'],
  ['workspaceManifestContract', 'manifest_config'],
]) {
  if (
    sectionHash(previousContract, section, previousContractFile) !==
    sectionHash(currentContract, section, currentContractFile)
  ) {
    process.stdout.write(`${reason}\n`)
    process.exit(0)
  }
}

process.stdout.write('unknown\n')
EOF
}

emit_pnpm_install_miss_span() {
  local task_name="$1"
  local reason="$2"

  if command -v otel-span >/dev/null 2>&1 && { [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] || [ -n "${OTEL_SPAN_SPOOL_DIR:-}" ]; }; then
    otel-span emit-span "dt-task" "${task_name}:status:miss" \
      --attr "task.phase=status" \
      --attr "task.cached=false" \
      --attr-string "span.label=${reason}" \
      --attr-string "install.miss_reason=${reason}" >/dev/null 2>&1 || true
  fi
}

check_node_modules_links_healthy() {
  local node_bin="$1"
  local projection_script="$2"
  shift 2

  for node_modules_dir in "$@"; do
    if [ ! -d "$node_modules_dir" ]; then
      continue
    fi

    broken_link="$(
      find "$node_modules_dir" -mindepth 1 -maxdepth 2 -type l ! -exec test -e {} \; -print -quit
    )"
    if [ -n "$broken_link" ]; then
      echo "[pnpm] Broken node_modules symlink detected: $broken_link" >&2
      return 1
    fi
  done

  # Feed the projection checker the exact node_modules directories we validated
  # for broken symlinks so the fast path and the authoritative task share the
  # same notion of a healthy pnpm projection.
  NODE_MODULES_DIRS="$(printf '%s\n' "$@")" "$node_bin" "$projection_script"
}

purge_node_modules() {
  for node_modules_dir in "$@"; do
    rm -rf "$node_modules_dir"
  done
}

resolve_package_bin() {
  local package_name="$1"
  local bin_name="${2:-$1}"
  local cwd="${3:-$PWD}"
  local node_bin="${NODE_BIN:-node}"
  local shim_path="$cwd/node_modules/.bin/$bin_name"

  if [ -x "$shim_path" ]; then
    printf '%s\n' "$shim_path"
    return 0
  fi

  "$node_bin" - "$package_name" "$bin_name" "$cwd" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')

const [packageName, binName, cwd] = process.argv.slice(2)

const manifestPath = require.resolve(`${packageName}/package.json`, { paths: [cwd] })
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const packageDir = path.dirname(manifestPath)

const candidates = []
if (typeof manifest.bin === 'string') {
  candidates.push(manifest.bin)
} else if (manifest.bin && typeof manifest.bin === 'object') {
  if (typeof manifest.bin[binName] === 'string') {
    candidates.push(manifest.bin[binName])
  }
  if (typeof manifest.bin[packageName] === 'string' && manifest.bin[packageName] !== manifest.bin[binName]) {
    candidates.push(manifest.bin[packageName])
  }
  for (const value of Object.values(manifest.bin)) {
    if (typeof value === 'string' && !candidates.includes(value)) {
      candidates.push(value)
    }
  }
}

if (candidates.length === 0) {
  console.error(`[pnpm] Package '${packageName}' does not declare a usable bin entry for '${binName}'`)
  process.exit(1)
}

for (const candidate of candidates) {
  const resolved = path.resolve(packageDir, candidate)
  if (fs.existsSync(resolved)) {
    process.stdout.write(`${resolved}\n`)
    process.exit(0)
  }
}

console.error(`[pnpm] Could not resolve an existing bin path for '${packageName}' from ${manifestPath}`)
process.exit(1)
EOF
}

run_package_bin() {
  local package_name="$1"
  local bin_name="${2:-$1}"
  shift 2

  local bin_path
  bin_path="$(resolve_package_bin "$package_name" "$bin_name")"
  "$bin_path" "$@"
}
