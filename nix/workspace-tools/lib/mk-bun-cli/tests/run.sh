#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
FIXTURES="$TESTS_DIR/fixtures"

if ! ulimit -n 4096 2>/dev/null; then
  echo "Warning: could not raise ulimit -n; current $(ulimit -n 2>/dev/null || echo unknown)" >&2
fi

now() {
  date +%s
}

detect_system() {
  local os
  local arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin)
      case "$arch" in
        arm64) echo "aarch64-darwin" ;;
        x86_64) echo "x86_64-darwin" ;;
      esac
      ;;
    Linux)
      case "$arch" in
        aarch64) echo "aarch64-linux" ;;
        x86_64) echo "x86_64-linux" ;;
      esac
      ;;
  esac
}

print_timing() {
  local label="$1"
  local start="$2"
  local end
  end="$(now)"
  echo "Timing: $label $((end - start))s"
}

WORKSPACE=""
KEEP=0
SKIP_EFFECT_UTILS=0
SKIP_PEER=0
SKIP_DEVENV=0
SKIP_NESTED=0

usage() {
  cat <<'USAGE'
Usage: run.sh [options]

Options:
  --workspace <path>   Use a fixed temp workspace directory
  --keep               Keep the temp workspace after the run
  --skip-effect-utils  Skip building effect-utils CLI
  --skip-peer          Skip building the peer fixture
  --skip-devenv        Skip devenv validation
  --skip-nested        Skip nested megarepo validation
  --help               Show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace)
      if [ $# -lt 2 ]; then
        usage
        exit 1
      fi
      WORKSPACE="$2"
      shift 2
      ;;
    --keep)
      KEEP=1
      shift
      ;;
    --skip-effect-utils)
      SKIP_EFFECT_UTILS=1
      shift
      ;;
    --skip-peer)
      SKIP_PEER=1
      shift
      ;;
    --skip-devenv)
      SKIP_DEVENV=1
      shift
      ;;
    --skip-nested)
      SKIP_NESTED=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

cleanup() {
  if [ "$KEEP" -eq 0 ] && [ -n "$WORKSPACE" ] && [ -d "$WORKSPACE" ] && [ -z "${EXPLICIT_WORKSPACE:-}" ]; then
    rm -rf "$WORKSPACE"
  fi
}
trap cleanup EXIT

copy_repo() {
  local src="$1"
  local dest="$2"
  local excludes=(
    ".git"
    ".direnv"
    ".devenv"
    ".cache"
    ".turbo"
    ".next"
    ".bun"
    "node_modules"
    "dist"
    "result"
    "coverage"
    "tmp"
    "out"
  )
  local tar_args=()
  for name in "${excludes[@]}"; do
    tar_args+=(--exclude="$name")
  done
  mkdir -p "$dest"
  (cd "$src" && tar "${tar_args[@]}" -cf - .) | (cd "$dest" && tar -xf -)
}

write_megarepo_json() {
  local root="$1"
  cat <<'JSON' > "$root/megarepo.json"
{
  "members": {
    "effect-utils": "./effect-utils",
    "app": "./app",
    "shared-lib": "./shared-lib",
    "monorepo": "./monorepo"
  },
  "generators": {
    "nix": { "enabled": true }
  }
}
JSON
}

sync_megarepo() {
  local root="$1"
  local env_root="${2:-}"
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required to run mr sync" >&2
    exit 1
  fi
  if [ -n "$env_root" ]; then
    (cd "$root" && MEGAREPO_ROOT_OUTERMOST="$env_root" bun "$ROOT/packages/@overeng/megarepo/bin/mr.ts" sync)
    (cd "$root" && MEGAREPO_ROOT_OUTERMOST="$env_root" bun "$ROOT/packages/@overeng/megarepo/bin/mr.ts" generate nix)
  else
    (cd "$root" && bun "$ROOT/packages/@overeng/megarepo/bin/mr.ts" sync)
    (cd "$root" && bun "$ROOT/packages/@overeng/megarepo/bin/mr.ts" generate nix)
  fi
}

run_build() {
  local label="$1"
  local target="$2"
  local extra_args="${3:-}"
  local start
  start="$(now)"
  echo "Build: $label"
  # shellcheck disable=SC2086
  nix build --no-link --no-write-lock-file -L $extra_args "$target"
  print_timing "$label" "$start"
}

run_devenv() {
  local label="$1"
  local dir="$2"
  local override=()
  local start
  start="$(now)"
  echo "Devenv: $label"
  if [ -n "${WORKSPACE_REAL:-}" ] && [ -d "$WORKSPACE_REAL/.direnv/megarepo-nix/workspace/effect-utils" ]; then
    override=(--override-input effect-utils "path:$WORKSPACE_REAL/.direnv/megarepo-nix/workspace/effect-utils")
  fi
  (cd "$dir" && devenv shell "${override[@]}" -- true)
  print_timing "$label" "$start"
}

overall_start="$(now)"
setup_start="$overall_start"

if [ -z "$WORKSPACE" ]; then
  WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/mk-bun-cli-workspace.XXXXXX")"
else
  EXPLICIT_WORKSPACE=1
  mkdir -p "$WORKSPACE"
  if [ -n "$(ls -A "$WORKSPACE")" ]; then
    echo "Workspace directory is not empty: $WORKSPACE" >&2
    exit 1
  fi
fi
WORKSPACE_REAL="$(cd "$WORKSPACE" && pwd -P)"
NIX_SYSTEM="$(detect_system)"
if [ -z "$NIX_SYSTEM" ]; then
  echo "Unable to detect Nix system for $(uname -s)/$(uname -m)" >&2
  exit 1
fi

echo "Workspace: $WORKSPACE_REAL"

cp -R "$FIXTURES/app" "$WORKSPACE_REAL/app"
cp -R "$FIXTURES/shared-lib" "$WORKSPACE_REAL/shared-lib"
cp -R "$FIXTURES/monorepo" "$WORKSPACE_REAL/monorepo"
copy_repo "$ROOT" "$WORKSPACE_REAL/effect-utils"
# TODO(devenv2): drop this stub when devenv 2 fixes generated .devenv.flake.nix handling:
# https://github.com/cachix/devenv/issues/2392
cat <<'EOF' > "$WORKSPACE_REAL/effect-utils/.devenv.flake.nix"
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs, ... }: { };
}
EOF
if [ -f "$WORKSPACE_REAL/effect-utils/.gitignore" ]; then
  if ! rg -q '^!/.devenv\.flake\.nix$' "$WORKSPACE_REAL/effect-utils/.gitignore"; then
    cat <<'EOF' >> "$WORKSPACE_REAL/effect-utils/.gitignore"

# Allow mk-bun-cli devenv stub to be included in path: flake inputs.
!/.devenv.flake.nix
EOF
  fi
fi
cp -R "$FIXTURES/shared-lib" "$WORKSPACE_REAL/app/shared-lib"

write_megarepo_json "$WORKSPACE_REAL"

sync_megarepo "$WORKSPACE_REAL"

print_timing "workspace setup" "$setup_start"

if [ "$SKIP_EFFECT_UTILS" -eq 0 ]; then
  run_build "effect-utils (workspace)" "path:$WORKSPACE_REAL/.direnv/megarepo-nix/workspace#packages.$NIX_SYSTEM.effect-utils.genie"
  run_build "effect-utils (standalone)" "path:$WORKSPACE_REAL/effect-utils#genie"
fi

if [ "$SKIP_PEER" -eq 0 ]; then
  run_build "peer app (workspace)" "path:$WORKSPACE_REAL/.direnv/megarepo-nix/workspace#packages.$NIX_SYSTEM.app.app-cli"
  run_build "peer app (standalone)" "path:$WORKSPACE_REAL/app#app-cli" \
    "--override-input effect-utils path:$WORKSPACE_REAL/effect-utils"
fi

if [ "$SKIP_DEVENV" -eq 0 ]; then
  if command -v devenv >/dev/null 2>&1; then
    run_devenv "peer app" "$WORKSPACE_REAL/app"
  else
    echo "devenv not available; skipping devenv validation" >&2
  fi
fi

if [ "$SKIP_NESTED" -eq 0 ]; then
  nested_start="$(now)"
  NESTED_ROOT="$WORKSPACE_REAL/nested"
  mkdir -p "$NESTED_ROOT"
  cp -R "$WORKSPACE_REAL/app" "$NESTED_ROOT/app"
  cp -R "$WORKSPACE_REAL/shared-lib" "$NESTED_ROOT/shared-lib"
  ln -s "../effect-utils" "$NESTED_ROOT/effect-utils"
  ln -s "../monorepo" "$NESTED_ROOT/monorepo"
  write_megarepo_json "$NESTED_ROOT"
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required to run nested megarepo validation" >&2
    exit 1
  fi
  (cd "$WORKSPACE_REAL" && bun "$ROOT/packages/@overeng/megarepo/bin/mr.ts" sync --deep)
  nested_root="$(cd "$NESTED_ROOT" && bun "$ROOT/packages/@overeng/megarepo/bin/mr.ts" root)"
  nested_root="${nested_root%/}"
  expected_root="${WORKSPACE_REAL%/}"
  if [ "$nested_root" != "$expected_root" ]; then
    echo "Nested megarepo root mismatch: expected $expected_root, got $nested_root" >&2
    exit 1
  fi
  print_timing "nested setup" "$nested_start"
fi

print_timing "total" "$overall_start"
