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

# ── Install-state component hashes (miss attribution) ─────────────────────────
#
# The monolithic install-state hash stays the sole hit/miss decision. These
# narrower component hashes are a diagnostic computed only after that monolithic
# hash already mismatched, so a miss can name WHICH surface changed instead of a
# bare `exit 1`. See pnpm.nix for the invalidation contract these encode.
#
# Components are deliberately overlapping (one edit can touch several), so the
# reported reason is the highest-severity first match in this order:
#   gvs-link -> lockfile -> policy -> manifest+config
# That order also IS the invalidation contract: gvs-link forces a GVS-link purge
# plus a forced reinstall; lockfile/policy/manifest force a plain reinstall.
# gvs-link is checked before lockfile because a steady-state packageExtensions
# edit also bumps pnpm-lock.yaml, and the higher-severity `links/` purge it
# triggers must win the report. This is safe because the gvs-link hash EXCLUDES
# pnpm-lock.yaml, so a pure-lockfile change does not trip gvs-link and still
# correctly reports `lockfile`.
#
# All components read files from $PWD (the workspace root). Callers parameterize
# the version, install flags, pre-install hook, manifest paths, and resolved GVS
# links dir via the PNPM_COMPONENT_* environment variables so the same helper
# bodies run in task scripts and in the sourced shell tests.

# lockfile: the resolved dependency graph (pnpm-lock.yaml).
compute_component_lockfile_hash() {
  {
    if [ -f pnpm-lock.yaml ]; then
      cat pnpm-lock.yaml
    fi
  } | compute_hash
}

# gvs-link: the narrow surface that forces a pnpm 11 GVS `links/` purge. pnpm
# reuses existing GVS link projections without re-resolving packageExtensions,
# so this surface (pnpm version + packageExtensions + allowBuilds + the active
# links projection root, which pnpm bakes into absolute paths) must invalidate
# the link cache, not just node_modules. This is the same fingerprint the exec
# path uses to decide whether to drop `links/`.
#
# Note: the issue's literal taxonomy grouped packageExtensions/allowBuilds/version
# under `policy`. They live in `gvs-link` here instead because only that lets a
# packageExtensions edit be reported as the GVS-link purge it actually triggers;
# `policy` below is the install-policy surface MINUS this gvs-link surface.
compute_component_gvs_link_hash() {
  {
    printf '%s\n' "${PNPM_COMPONENT_PNPM_VERSION:-}"
    sed -n '/^packageExtensions:/,/^[a-zA-Z]/p' pnpm-workspace.yaml 2>/dev/null || true
    sed -n '/^allowBuilds:/,/^[a-zA-Z]/p' pnpm-workspace.yaml 2>/dev/null || true
    printf '%s\n' "${PNPM_COMPONENT_GVS_LINKS_DIR:-}"
  } | compute_hash
}

# policy: the install-policy surface that is NOT already covered by gvs-link.
# pnpm-workspace.yaml spells these knobs in camelCase; PNPM_COMPONENT_POLICY_KEYS
# carries that key list (kept beside pnpm-install-policy.nix). installFlags and
# preInstall complete the per-task policy surface. Hashing the workspace.yaml
# keys keeps this component a faithful subset of the monolithic install-state
# inputs, so it stays reachable in real installs and not just in unit tests.
compute_component_policy_hash() {
  {
    local key
    for key in ${PNPM_COMPONENT_POLICY_KEYS:-}; do
      grep -E "^${key}:" pnpm-workspace.yaml 2>/dev/null || true
    done
    printf '%s\n' "${PNPM_COMPONENT_INSTALL_FLAGS:-}"
    printf '%s\n' "${PNPM_COMPONENT_PRE_INSTALL:-}"
  } | compute_hash
}

# manifest+config: the catch-all for everything else (root + member manifests,
# the rest of pnpm-workspace.yaml, .npmrc, injected source trees). pnpm-lock.yaml
# is deliberately excluded (it is the `lockfile` component) so a lockfile-only
# change is never misreported here.
#
# In this repo package.json, member manifests, and pnpm-workspace.yaml are all
# genie-generated from `.genie.ts` sources, so the generated-config surface is
# not separable from the manifest surface today; they are grouped together and
# this limitation is documented in pnpm.nix.
compute_component_manifest_config_hash() {
  {
    if [ -f package.json ]; then
      cat package.json
    fi
    if [ -f pnpm-workspace.yaml ]; then
      cat pnpm-workspace.yaml
    fi
    if [ -f .npmrc ]; then
      cat .npmrc
    fi

    local manifest
    for manifest in ${PNPM_COMPONENT_MANIFEST_PATHS:-}; do
      if [ -f "$manifest" ]; then
        cat "$manifest"
      fi
    done

    local injected_dir
    for injected_dir in ${PNPM_COMPONENT_INJECTED_DIRS:-}; do
      emit_dir_state "$injected_dir"
    done
  } | compute_hash
}

# Compare each component hash against its stored value and print the
# highest-severity component that changed. Stored values come from the
# matching PNPM_STORED_* environment variables. Prints nothing (and returns 1)
# when every component matches, which means the install-state mismatch is caused
# by an input outside this decomposition.
classify_install_state_miss() {
  if [ "$(compute_component_gvs_link_hash)" != "${PNPM_STORED_GVS_LINK_HASH:-}" ]; then
    printf '%s\n' "gvs-link"
    return 0
  fi
  if [ "$(compute_component_lockfile_hash)" != "${PNPM_STORED_LOCKFILE_HASH:-}" ]; then
    printf '%s\n' "lockfile"
    return 0
  fi
  if [ "$(compute_component_policy_hash)" != "${PNPM_STORED_POLICY_HASH:-}" ]; then
    printf '%s\n' "policy"
    return 0
  fi
  if [ "$(compute_component_manifest_config_hash)" != "${PNPM_STORED_MANIFEST_CONFIG_HASH:-}" ]; then
    printf '%s\n' "manifest+config"
    return 0
  fi
  return 1
}

# Emit a miss reason to stderr and to the OTEL status attribute sidecar. The
# /dev/null fallback keeps this byte-identical on the OTEL and non-OTEL branches
# so callers need no `if OTEL` guard. See trace.nix for the --attr-file plumbing.
report_install_miss_reason() {
  local reason="$1"
  echo "[pnpm] install cache miss: $reason" >&2
  printf 'install.miss_reason=%s\n' "$reason" > "${OTEL_STATUS_ATTR_FILE:-/dev/null}"
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
