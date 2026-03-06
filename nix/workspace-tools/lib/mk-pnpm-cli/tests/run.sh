#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

SYSTEM="${NIX_SYSTEM:-}"
SKIP_GENIE=0
SKIP_MEGAREPO=0

usage() {
  cat <<'USAGE'
Usage: run.sh [options]

Options:
  --system <system>   Nix system to build (defaults to builtins.currentSystem)
  --skip-genie        Skip building the genie CLI
  --skip-megarepo     Skip building the megarepo CLI
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
    --skip-genie)
      SKIP_GENIE=1
      shift
      ;;
    --skip-megarepo)
      SKIP_MEGAREPO=1
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

if [ -z "$SYSTEM" ]; then
  SYSTEM="$(nix eval --impure --raw --expr builtins.currentSystem)"
fi

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
}

if [ "$SKIP_GENIE" -eq 0 ]; then
  build_and_smoke "genie" "genie"
fi

if [ "$SKIP_MEGAREPO" -eq 0 ]; then
  build_and_smoke "megarepo" "mr"
fi

echo "mk-pnpm-cli smoke tests passed"
