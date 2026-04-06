#!/usr/bin/env bash

run_nix_gc_race_retry() {
  local task="$1"
  local command="$2"
  local max="${NIX_GC_RACE_MAX_RETRIES:-10}"
  local heartbeat="${CI_PROGRESS_HEARTBEAT_SECONDS:-60}"
  local attempt=1
  local log rc path start now elapsed hb_pid flattened saw_invalid_path saw_cachix_signature had_errexit

  start="$(date +%s)"

  write_summary() {
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
    {
      echo "### CI Task"
      echo "- Task: $task"
      echo "- Status: $1"
      echo "- Duration: $elapsed s"
      echo "- Attempts: $attempt/$max"
      [ -z "${2:-}" ] || echo "- Note: $2"
    } >> "$GITHUB_STEP_SUMMARY"
  }

  while [ "$attempt" -le "$max" ]; do
    echo "::notice::[ci] starting $task (attempt $attempt/$max)"
    (
      while sleep "$heartbeat"; do
        now=$(date +%s)
        elapsed=$((now - start))
        echo "::notice::[ci] $task still running after $elapsed s (attempt $attempt/$max)"
      done
    ) &
    hb_pid=$!

    log=$(mktemp)
    had_errexit=false
    case $- in
      *e*) had_errexit=true ;;
    esac
    set +e
    eval "$command" > >(tee -a "$log") 2> >(tee -a "$log" >&2)
    rc=$?
    if [ "$had_errexit" = true ]; then
      set -e
    fi

    kill "$hb_pid" 2>/dev/null || true
    wait "$hb_pid" 2>/dev/null || true

    now=$(date +%s)
    elapsed=$((now - start))

    if [ "$rc" -eq 0 ]; then
      echo "::notice::[ci] completed $task in $elapsed s"
      if [ "$attempt" -gt 1 ]; then
        write_summary success "Recovered from Nix GC race after retry"
      else
        write_summary success
      fi
      rm -f "$log"
      return 0
    fi

    flattened=$(tr '\r\n' '  ' < "$log" | sed -E $'s/\x1B\\[[0-9;]*m//g')
    path=$(printf '%s' "$flattened" |
      grep -o "error:[[:space:]]*path '/nix/store/[^']*'[[:space:]]*is not valid" |
      head -1 |
      grep -o "/nix/store/[^']*" |
      tr -d '[:space:]' || true)
    saw_invalid_path=false
    saw_cachix_signature=false
    [ -n "$path" ] && saw_invalid_path=true
    printf '%s' "$flattened" | grep -q 'Failed to convert config\.cachix to JSON' && saw_cachix_signature=true || true
    printf '%s' "$flattened" | grep -q 'while evaluating the option' && printf '%s' "$flattened" | grep -q 'cachix\.package' && saw_cachix_signature=true || true
    rm -f "$log"

    if [ "$saw_invalid_path" != true ] && [ "$saw_cachix_signature" != true ]; then
      echo "::warning::[ci] $task failed after $elapsed s without a detected Nix store validity race"
      write_summary failure "No Nix GC race signature detected"
      return "$rc"
    fi

    if [ "$saw_cachix_signature" = true ] && [ -n "$path" ]; then
      echo "::warning::Nix store validity race detected for $task via cachix eval wrapper (attempt $attempt/$max): $path"
    elif [ "$saw_cachix_signature" = true ]; then
      echo "::warning::Nix store validity race detected for $task via cachix eval wrapper without extracted store path (attempt $attempt/$max)"
    else
      echo "::warning::Nix store validity race detected for $task (attempt $attempt/$max): $path"
    fi

    [ -z "$path" ] || nix-store --realise "$path" 2>/dev/null || true
    rm -rf ~/.cache/nix/eval-cache-*
    attempt=$((attempt + 1))
  done

  now=$(date +%s)
  elapsed=$((now - start))
  echo "::error::Nix GC race retry exhausted for $task ($max attempts)"
  write_summary failure "Nix GC race retry exhausted"
  return 1
}
