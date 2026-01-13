#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURES="$ROOT/tests/mk-bun-cli/fixtures"

now() {
  date +%s
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
DIRTY=0
REFRESH_LOCKS=0
SKIP_EFFECT_UTILS=0
SKIP_PEER=0
SKIP_DEVENV=0
LINK_EFFECT_UTILS=0

usage() {
  cat <<'USAGE'
Usage: run.sh [options]

Options:
  --workspace <path>   Use a fixed temp workspace directory
  --keep               Keep the temp workspace after the run
  --dirty              Rebuild after modifying a peer source file
  --refresh-locks      Run bun install in fixtures to refresh bun.lock
  --skip-effect-utils  Skip building effect-utils CLIs
  --skip-peer          Skip building the peer fixture
  --skip-devenv        Skip devenv validation
  --link-effect-utils  Symlink effect-utils into the workspace
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
    --dirty)
      DIRTY=1
      shift
      ;;
    --refresh-locks)
      REFRESH_LOCKS=1
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
    --link-effect-utils)
      LINK_EFFECT_UTILS=1
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

echo "Workspace: $WORKSPACE"

cp -R "$FIXTURES/app" "$WORKSPACE/app"
cp -R "$FIXTURES/shared-lib" "$WORKSPACE/shared-lib"
cp -R "$FIXTURES/monorepo" "$WORKSPACE/monorepo"

copy_repo() {
  local src="$1"
  local dest="$2"
  local excludes=(
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

if [ "$LINK_EFFECT_UTILS" -eq 1 ]; then
  ln -s "$ROOT" "$WORKSPACE/effect-utils"
else
  copy_repo "$ROOT" "$WORKSPACE/effect-utils"
  if [ -f "$WORKSPACE/effect-utils/.devenv.flake.nix" ]; then
    perl -0777 -i -pe "s|^/\\.devenv\\.flake\\.nix\\n||m" "$WORKSPACE/effect-utils/.gitignore"
  fi
fi

rewrite_devenv_inputs() {
  local file="$WORKSPACE/app/devenv.yaml"
  perl -0777 -i -pe "s|path:\\.\\./effect-utils|path:$WORKSPACE_REAL/effect-utils|g; s|path:\\.\\.|path:$WORKSPACE_REAL|g" "$file"
}

rewrite_devenv_flake_inputs() {
  local file="$WORKSPACE/app/flake.nix"
  perl -0777 -i -pe "s|path:\\.\\./effect-utils|path:$WORKSPACE_REAL/effect-utils|g; s|path:\\.\\.|path:$WORKSPACE_REAL|g" "$file"
}

rewrite_devenv_inputs
rewrite_devenv_flake_inputs

mkdir -p "$WORKSPACE/@acme"
ln -s "../monorepo/packages/@acme/utils" "$WORKSPACE/@acme/utils"

init_repo() {
  local path="$1"
  if [ -d "$path/.git" ]; then
    return
  fi
  (cd "$path" && git init -q)
  (cd "$path" && git config user.email "mk-bun-cli@example.test")
  (cd "$path" && git config user.name "mk-bun-cli")
  (cd "$path" && git config commit.gpgsign false)
  (cd "$path" && git add .)
  (cd "$path" && git -c commit.gpgsign=false commit -q -m "init")
}

commit_repo() {
  local path="$1"
  (cd "$path" && git add .)
  (cd "$path" && git -c commit.gpgsign=false commit -q -m "update" || true)
}

init_repo "$WORKSPACE/shared-lib"
init_repo "$WORKSPACE/monorepo"
init_repo "$WORKSPACE/app"

print_timing "workspace setup" "$setup_start"

if [ "$REFRESH_LOCKS" -eq 1 ]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun not found in PATH (required for --refresh-locks)" >&2
    exit 1
  fi
  refresh_start="$(now)"
  (cd "$WORKSPACE/shared-lib" && bun install)
  (cd "$WORKSPACE/monorepo/packages/@acme/utils" && bun install)
  (cd "$WORKSPACE/app" && bun install)
  commit_repo "$WORKSPACE/shared-lib"
  commit_repo "$WORKSPACE/monorepo"
  commit_repo "$WORKSPACE/app"
  print_timing "refresh locks" "$refresh_start"
fi

ensure_bun_hash() {
  local target="$1"
  local file="$2"
  local workdir="$3"

  local output
  local status
  set +e
  output="$(cd "$workdir" && nix build "$target" --no-link 2>&1)"
  status=$?
  set -e

  if [ "$status" -eq 0 ]; then
    return 0
  fi

  local hash
  hash="$(printf '%s' "$output" | sed -nE 's/.*got:[[:space:]]*(sha256-[A-Za-z0-9+/=]+).*/\1/p' | head -n 1 || true)"
  if [ -z "$hash" ]; then
    hash="$(printf '%s' "$output" | grep -Eo 'sha256-[A-Za-z0-9+/=]+' | head -n 1 || true)"
  fi
  if [ -z "$hash" ]; then
    printf '%s\n' "$output" >&2
    exit 1
  fi

  perl -0777 -i -pe "s|bunDepsHash = [^;]+|bunDepsHash = \"$hash\"|g" "$file"
}

enable_dirty_flag() {
  local file="$1"
  perl -0777 -i -pe '
    if (/\bdirty\s*=/) {
      s/\bdirty\s*=\s*false\s*;/dirty = true;/g;
    } else {
      s/(\n\s*)bunDepsHash\s*=\s*[^;]+;/$&$1dirty = true;/;
    }
  ' "$file"
}

if [ "$SKIP_EFFECT_UTILS" -eq 0 ]; then
  echo "Building effect-utils CLIs..."
  effect_utils_start="$(now)"
  nix build "$ROOT#genie" "$ROOT#dotdot"
  print_timing "effect-utils build" "$effect_utils_start"
fi

if [ "$SKIP_PEER" -eq 0 ] || [ "$SKIP_DEVENV" -eq 0 ]; then
  echo "Resolving peer bunDepsHash..."
  peer_hash_start="$(now)"
  ensure_bun_hash ".#app-cli" "$WORKSPACE/app/flake.nix" "$WORKSPACE/app"
  print_timing "peer bunDepsHash" "$peer_hash_start"
  app_hash="$(grep -Eo 'sha256-[A-Za-z0-9+/=]+' "$WORKSPACE/app/flake.nix" | head -n 1 || true)"
  if [ -n "$app_hash" ]; then
    perl -0777 -i -pe "s|bunDepsHash = [^;]+|bunDepsHash = \"$app_hash\"|g" "$WORKSPACE/app/devenv.nix"
  fi
fi

if [ "$SKIP_PEER" -eq 0 ]; then
  echo "Building peer fixture..."
  peer_build_start="$(now)"
  (cd "$WORKSPACE/app" && nix build ".#app-cli")
  print_timing "peer nix build" "$peer_build_start"

  "${WORKSPACE}/app/result/bin/app-cli" | grep -q "shared-lib" || {
    echo "Unexpected output from app-cli" >&2
    exit 1
  }

  if [ "$DIRTY" -eq 1 ]; then
    echo "Testing dirty sources..."
    dirty_start="$(now)"
    cat <<'MSG' > "$WORKSPACE/shared-lib/src/index.ts"
export const sharedMessage = 'shared-lib-dirty'
MSG
    enable_dirty_flag "$WORKSPACE/app/flake.nix"
    enable_dirty_flag "$WORKSPACE/app/devenv.nix"
    (cd "$WORKSPACE/app" && nix flake update workspace)
    (cd "$WORKSPACE/app" && nix build ".#app-cli")
    "${WORKSPACE}/app/result/bin/app-cli" | grep -q "shared-lib-dirty" || {
      echo "Dirty source output not detected" >&2
      exit 1
    }
    print_timing "dirty rebuild" "$dirty_start"
  fi
fi

if [ "$SKIP_DEVENV" -eq 0 ]; then
  if ! command -v devenv >/dev/null 2>&1; then
    echo "devenv not found in PATH (skipping)" >&2
  else
    echo "Validating devenv..."
    devenv_start="$(now)"
    devenv_args=(
      --override-input effect-utils "path:$WORKSPACE_REAL/effect-utils"
      --override-input workspace "path:$WORKSPACE_REAL"
    )
    devenv_log="$WORKSPACE/devenv-shell.log"
    set +e
    (cd "$WORKSPACE/app" && devenv shell "${devenv_args[@]}" bash -lc "app-cli") 2>&1 | tee "$devenv_log"
    devenv_status="${PIPESTATUS[0]}"
    set -e
    if [ "$devenv_status" -ne 0 ]; then
      exit "$devenv_status"
    fi
    print_timing "devenv shell" "$devenv_start"
    if command -v rg >/dev/null 2>&1; then
      devenv_reported="$(sed -E 's/\\x1b\\[[0-9;]*[A-Za-z]//g' "$devenv_log" | tr -d '\r' | rg -o 'Building shell in [0-9.]+s' | tail -n 1 || true)"
    else
      devenv_reported="$(sed -E 's/\\x1b\\[[0-9;]*[A-Za-z]//g' "$devenv_log" | tr -d '\r' | grep -Eo 'Building shell in [0-9.]+s' | tail -n 1 || true)"
    fi
    if [ -n "$devenv_reported" ]; then
      echo "Timing: devenv reported ${devenv_reported#Building shell in }"
    fi
  fi
fi

print_timing "total" "$overall_start"
