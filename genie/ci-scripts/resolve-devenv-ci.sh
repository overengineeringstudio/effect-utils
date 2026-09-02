#!/usr/bin/env bash
set -euo pipefail

lock_file="${1:-devenv.lock}"
if [ ! -f "$lock_file" ]; then
  echo "::error::$lock_file is missing" >&2
  exit 1
fi
DEVENV_REV="$(jq -r .nodes.devenv.locked.rev "$lock_file")"
if [ -z "$DEVENV_REV" ] || [ "$DEVENV_REV" = null ]; then
  echo "::error::$lock_file missing .nodes.devenv.locked.rev" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=resolve-devenv.sh
. "$script_dir/resolve-devenv.sh"

state_root="${RUNNER_TEMP:?RUNNER_TEMP not set}/composition-state"
DIAG_ROOT="$state_root/nix-store-diagnostics/${GITHUB_JOB:-job}-${RUNNER_OS:-unknown}-${GITHUB_RUN_ATTEMPT:-0}"
mkdir -p "$DIAG_ROOT"
printf 'NIX_STORE_DIAGNOSTICS_DIR=%s\n' "$DIAG_ROOT" >> "$GITHUB_ENV"

{
  echo "timestamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "runner_name=${RUNNER_NAME:-unknown}"
  echo "runner_os=${RUNNER_OS:-unknown}"
  echo "runner_arch=${RUNNER_ARCH:-unknown}"
  echo "github_job=${GITHUB_JOB:-unknown}"
  echo "github_run_id=${GITHUB_RUN_ID:-unknown}"
  echo "nix_user_conf_files=${NIX_USER_CONF_FILES:-}"
  nix --version || true
} > "$DIAG_ROOT/environment.txt" 2>&1

if ! DEVENV_OUT="$(resolve_devenv 2> >(tee "$DIAG_ROOT/resolve-devenv.log" >&2))"; then
  echo "::error::resolve_devenv failed. Last 30 lines of log:" >&2
  tail -30 "$DIAG_ROOT/resolve-devenv.log" >&2 || true
  exit 1
fi
DEVENV_BIN="$DEVENV_OUT/bin/devenv"

if ! nix-store --check-validity "$DEVENV_OUT" 2>/dev/null; then
  echo "::warning::devenv store path invalid, repairing targeted path..." >&2
  nix-store --repair-path "$DEVENV_OUT" > "$DIAG_ROOT/nix-store-verify-repair.log" 2>&1 || true
  rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}"/nix/eval-cache-* ~/.cache/nix/eval-cache-*
  if ! DEVENV_OUT="$(resolve_devenv 2> >(tee "$DIAG_ROOT/resolve-devenv-post-repair.log" >&2))"; then
    echo "::error::resolve_devenv failed after repair. Last 30 lines of log:" >&2
    tail -30 "$DIAG_ROOT/resolve-devenv-post-repair.log" >&2 || true
    exit 1
  fi
  DEVENV_BIN="$DEVENV_OUT/bin/devenv"
fi

if [ ! -L "$DEVENV_GC_ROOT" ] || [ ! "$DEVENV_GC_ROOT" -ef "$DEVENV_OUT" ]; then
  echo "::error::devenv resolution did not publish the expected job-scoped GC root: $DEVENV_GC_ROOT" >&2
  exit 1
fi

printf 'DEVENV_REV=%s\nDEVENV_GC_ROOT=%s\nDEVENV_BIN=%s\n' \
  "$DEVENV_REV" "$DEVENV_GC_ROOT" "$DEVENV_BIN" >> "$GITHUB_ENV"
"$DEVENV_BIN" version | tee "$DIAG_ROOT/devenv-version.txt"
