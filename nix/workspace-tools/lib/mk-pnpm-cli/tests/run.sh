#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
FIXTURES="$TESTS_DIR/fixtures"

SYSTEM="${NIX_SYSTEM:-}"
SKIP_GENIE=0
SKIP_MEGAREPO=0
SKIP_OXLINT=0
SKIP_DEVENV_SHELL=0
SKIP_DOWNSTREAM=0
SKIP_DOWNSTREAM_MEGAREPO=0
WORKSPACE=""
KEEP=0

usage() {
  cat <<'USAGE'
Usage: run.sh [options]

Options:
  --system <system>   Nix system to build (defaults to builtins.currentSystem)
  --workspace <path>  Use a fixed temp workspace directory for downstream tests
  --keep              Keep the temp workspace after the run
  --skip-genie        Skip building the genie CLI
  --skip-megarepo     Skip building the megarepo CLI
  --skip-oxlint       Skip the downstream oxlint-npm regression build
  --skip-devenv-shell Skip downstream devenv shell coverage
  --skip-downstream   Skip downstream flake-input regression coverage
  --skip-downstream-megarepo
                     Skip the downstream megarepo regression build
  --help              Show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --system)
      if [ $# -lt 2 ]; then
        usage
        exit 1
      fi
      SYSTEM="$2"
      shift 2
      ;;
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
    --skip-genie)
      SKIP_GENIE=1
      shift
      ;;
    --skip-megarepo)
      SKIP_MEGAREPO=1
      shift
      ;;
    --skip-oxlint)
      SKIP_OXLINT=1
      shift
      ;;
    --skip-devenv-shell)
      SKIP_DEVENV_SHELL=1
      shift
      ;;
    --skip-downstream)
      SKIP_DOWNSTREAM=1
      shift
      ;;
    --skip-downstream-megarepo)
      SKIP_DOWNSTREAM_MEGAREPO=1
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

if [ -z "$SYSTEM" ]; then
  SYSTEM="$(nix eval --impure --raw --expr builtins.currentSystem)"
fi

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

build_and_smoke() {
  local attr="$1"
  local bin_name="$2"

  echo "Build: $attr ($SYSTEM)"
  local out
  out="$(
    cd "$ROOT" &&
      nix build --no-link --no-write-lock-file --print-out-paths ".#packages.$SYSTEM.$attr"
  )"

  echo "Smoke: $bin_name --help"
  "$out/bin/$bin_name" --help >/dev/null

  check_completions "$out" "$bin_name"
}

prepare_downstream_workspace() {
  if [ -z "$WORKSPACE" ]; then
    WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/mk-pnpm-cli-downstream.XXXXXX")"
  else
    EXPLICIT_WORKSPACE=1
    mkdir -p "$WORKSPACE"
    if [ -n "$(ls -A "$WORKSPACE")" ]; then
      echo "Workspace directory is not empty: $WORKSPACE" >&2
      exit 1
    fi
  fi

  WORKSPACE_REAL="$(cd "$WORKSPACE" && pwd -P)"
  DOWNSTREAM_DIR="$WORKSPACE_REAL/downstream"

  cp -R "$FIXTURES/downstream" "$DOWNSTREAM_DIR"
  copy_repo "$ROOT" "$WORKSPACE_REAL/effect-utils"
  mkdir -p "$WORKSPACE_REAL/repos"
  copy_repo "$ROOT" "$WORKSPACE_REAL/repos/effect-utils"
}

check_completions() {
  local out="$1"
  local bin_name="$2"

  echo "Check: $bin_name shell completions"
  local fish_file="$out/share/fish/vendor_completions.d/${bin_name}.fish"
  local bash_file="$out/share/bash-completion/completions/${bin_name}"
  local zsh_file="$out/share/zsh/site-functions/_${bin_name}"
  for f in "$fish_file" "$bash_file" "$zsh_file"; do
    if [ ! -f "$f" ] && [ ! -L "$f" ]; then
      echo "error: missing completion file: $f" >&2
      exit 1
    fi
    if [ ! -s "$f" ]; then
      echo "error: empty completion file: $f" >&2
      exit 1
    fi
  done
}

run_downstream_regression() {
  local attr="$1"
  local bin_name="${2:-}"
  local start
  start="$(date +%s)"

  echo "Build: downstream $attr (standalone effect-utils path)"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/effect-utils" \
    "path:$DOWNSTREAM_DIR#packages.$SYSTEM.$attr"

  echo "Build: downstream $attr (composed repos/effect-utils path)"
  local out
  out="$(nix build --no-link --no-write-lock-file --print-out-paths \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#packages.$SYSTEM.$attr")"

  if [ -n "$bin_name" ]; then
    check_completions "$out" "$bin_name"
  fi

  if [ "$SKIP_DEVENV_SHELL" -eq 0 ]; then
    echo "Devenv: downstream shell with composed repos/effect-utils path"
    (
      cd "$DOWNSTREAM_DIR" &&
        devenv shell \
          --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
          --no-tui \
          -- true
    )
  fi

  echo "Timing: downstream-$attr $(( $(date +%s) - start ))s"
}

run_downstream_pure_eval_regression() {
  local start
  start="$(date +%s)"

  echo "Build: downstream pure-eval regression (standalone effect-utils path)"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.pure-eval-external-install-roots"

  echo "Build: downstream pure-eval derived-workspace-root regression (standalone effect-utils path)"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.pure-eval-derived-workspace-root"

  echo "Build: downstream pure-eval regression (composed repos/effect-utils path)"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.pure-eval-external-install-roots"

  echo "Build: downstream pure-eval derived-workspace-root regression (composed repos/effect-utils path)"
  nix build --no-link --no-write-lock-file \
    --override-input effect-utils "path:$WORKSPACE_REAL/repos/effect-utils" \
    "path:$DOWNSTREAM_DIR#checks.$SYSTEM.pure-eval-derived-workspace-root"

  echo "Timing: downstream-pure-eval $(( $(date +%s) - start ))s"
}

if [ "$SKIP_GENIE" -eq 0 ]; then
  build_and_smoke "genie" "genie"
fi

if [ "$SKIP_MEGAREPO" -eq 0 ]; then
  build_and_smoke "megarepo" "mr"
fi

if [ "$SKIP_DOWNSTREAM" -eq 0 ]; then
  prepare_downstream_workspace
  run_downstream_pure_eval_regression
  run_downstream_regression "genie" "genie"
  if [ "$SKIP_DOWNSTREAM_MEGAREPO" -eq 0 ]; then
    run_downstream_regression "megarepo" "mr"
  fi
  if [ "$SKIP_OXLINT" -eq 0 ]; then
    run_downstream_regression "oxlint-npm"
  fi
fi

echo "mk-pnpm-cli smoke tests passed"
