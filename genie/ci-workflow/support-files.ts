import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'
import { resolveDevenvFnScript } from './shared.ts'

const withTrailingNewline = (content: string) => (content.endsWith('\n') ? content : `${content}\n`)
const dollar = '$'

const textArtifact = (content: string): GenieOutput<string> =>
  createGenieOutput({
    data: content,
    stringify: () => withTrailingNewline(content),
  })

export const ciWorkflowNixGcRaceRetryScriptPath = 'genie/ci-scripts/nix-gc-race-retry.sh'
export const ciWorkflowNixGcRaceRetryWrapperPath = 'genie/ci-scripts/run-with-nix-gc-race-retry.sh'
export const ciWorkflowJobLocalRustStateScriptPath =
  'genie/ci-scripts/prepare-job-local-rust-state.sh'
export const ciWorkflowResolveDevenvScriptPath = 'genie/ci-scripts/resolve-devenv.sh'

export const ciWorkflowNixGcRaceRetryScript = String.raw`#!/usr/bin/env bash

run_nix_gc_race_retry() {
  local task="$1"
  local max="${dollar}{NIX_GC_RACE_MAX_RETRIES:-10}"
  local heartbeat="${dollar}{CI_PROGRESS_HEARTBEAT_SECONDS:-60}"
  local daemon_socket_retry_delay="${dollar}{NIX_DAEMON_SOCKET_RETRY_DELAY_SECONDS:-2}"
  local attempt=1
  local log log_dir stdout_pipe stderr_pipe rc path start now elapsed hb_pid stdout_tee_pid stderr_tee_pid flattened saw_invalid_path saw_cachix_signature saw_fetch_signature saw_daemon_socket_failure had_errexit

  shift
  start="$(date +%s)"

  write_summary() {
    [ -n "${dollar}{GITHUB_STEP_SUMMARY:-}" ] || return 0
    {
      echo "### CI Task"
      echo "- Task: $task"
      echo "- Status: $1"
      echo "- Duration: $elapsed s"
      echo "- Attempts: $attempt/$max"
      [ -z "${dollar}{2:-}" ] || echo "- Note: $2"
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
    log_dir=$(mktemp -d)
    stdout_pipe="$log_dir/stdout"
    stderr_pipe="$log_dir/stderr"
    mkfifo "$stdout_pipe" "$stderr_pipe"
    tee -a "$log" < "$stdout_pipe" &
    stdout_tee_pid=$!
    tee -a "$log" < "$stderr_pipe" >&2 &
    stderr_tee_pid=$!
    had_errexit=false
    case $- in
      *e*) had_errexit=true ;;
    esac
    set +e
    "$@" > "$stdout_pipe" 2> "$stderr_pipe"
    rc=$?
    if [ "$had_errexit" = true ]; then
      set -e
    fi
    wait "$stdout_tee_pid" 2>/dev/null || true
    wait "$stderr_tee_pid" 2>/dev/null || true
    rm -rf "$log_dir"

    kill "$hb_pid" 2>/dev/null || true
    wait "$hb_pid" 2>/dev/null || true

    now=$(date +%s)
    elapsed=$((now - start))

    if [ "$rc" -eq 0 ]; then
      echo "::notice::[ci] completed $task in $elapsed s"
      if [ "$attempt" -gt 1 ]; then
        write_summary success "Recovered from transient Nix failure after retry"
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
    saw_fetch_signature=false
    saw_daemon_socket_failure=false
    [ -n "$path" ] && saw_invalid_path=true
    printf '%s' "$flattened" | grep -Eq 'error:[[:space:]]*.*Failed to convert config\.cachix to JSON' && saw_cachix_signature=true || true
    printf '%s' "$flattened" | grep -Eq 'error:[[:space:]]*.*while evaluating the option.*cachix\.package' && saw_cachix_signature=true || true
    printf '%s' "$flattened" | grep -Eq 'error:[[:space:]]*cannot read file from tarball:[[:space:]]*Truncated tar archive detected while reading data' && saw_fetch_signature=true || true
    printf '%s' "$flattened" | grep -Eq "error:[[:space:]]*cannot connect to socket at '/nix/var/nix/daemon-socket/socket'" && saw_daemon_socket_failure=true || true
    rm -f "$log"

    if [ "$saw_invalid_path" != true ] && [ "$saw_cachix_signature" != true ] && [ "$saw_fetch_signature" != true ] && [ "$saw_daemon_socket_failure" != true ]; then
      echo "::warning::[ci] $task failed after $elapsed s without a detected transient Nix failure"
      write_summary failure "No transient Nix failure signature detected"
      return "$rc"
    fi

    if [ "$saw_daemon_socket_failure" = true ]; then
      echo "::warning::Nix daemon socket failure detected for $task (attempt $attempt/$max); waiting $daemon_socket_retry_delay s for host supervision before retrying without mutating the host daemon"
    elif [ "$saw_fetch_signature" = true ]; then
      echo "::warning::Nix source fetch corruption detected for $task (attempt $attempt/$max); retrying with a refreshed eval cache"
    elif [ "$saw_cachix_signature" = true ] && [ -n "$path" ]; then
      echo "::warning::Nix store validity race detected for $task via cachix eval wrapper (attempt $attempt/$max): $path"
    elif [ "$saw_cachix_signature" = true ]; then
      echo "::warning::Nix store validity race detected for $task via cachix eval wrapper without extracted store path (attempt $attempt/$max)"
    else
      echo "::warning::Nix store validity race detected for $task (attempt $attempt/$max): $path"
    fi

    [ -z "$path" ] || nix-store --realise "$path" 2>/dev/null || true
    rm -rf ~/.cache/nix/eval-cache-*
    if [ "$saw_daemon_socket_failure" = true ] && [ "$attempt" -lt "$max" ]; then
      sleep "$daemon_socket_retry_delay"
    fi
    attempt=$((attempt + 1))
  done

  now=$(date +%s)
  elapsed=$((now - start))
  echo "::error::Transient Nix retry exhausted for $task ($max attempts)"
  write_summary failure "Transient Nix retry exhausted"
  return 1
}`

export const ciWorkflowNixGcRaceRetryWrapperScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <label> <shell-command>" >&2
  exit 2
fi

label="$1"
command="$2"
script_dir="$(cd -- "$(dirname -- "${dollar}{BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=genie/ci-scripts/nix-gc-race-retry.sh
. "$script_dir/nix-gc-race-retry.sh"

run_nix_gc_race_retry "$label" bash -euo pipefail -c "$command"`

export const ciWorkflowJobLocalRustStateScript = String.raw`#!/usr/bin/env bash

# Source this helper at the task boundary. Ambient job-level Cargo state can be
# materialized during environment bootstrap by a different process identity.
: "${dollar}{RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${dollar}{GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${dollar}{GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
: "${dollar}{GITHUB_JOB:?GITHUB_JOB is required}"
: "${dollar}{RUNNER_NAME:?RUNNER_NAME is required}"

export CARGO_TARGET_DIR="${dollar}RUNNER_TEMP/cargo-target-${dollar}GITHUB_RUN_ID-${dollar}GITHUB_RUN_ATTEMPT-${dollar}GITHUB_JOB"
mkdir -p "$CARGO_TARGET_DIR"

# sccache's default TCP server is host-wide. A short per-runner UDS prevents a
# server owned by one self-hosted runner identity from creating another job's
# Cargo artifacts while retaining reuse through the shared cache directory.
sccache_server_key="$(printf '%s' "${dollar}GITHUB_RUN_ID-${dollar}GITHUB_RUN_ATTEMPT-${dollar}GITHUB_JOB-${dollar}RUNNER_NAME" | git hash-object --stdin | cut -c1-16)"
export SCCACHE_SERVER_UDS="${dollar}RUNNER_TEMP/sc-${dollar}sccache_server_key.sock"
unset sccache_server_key`

export const ciWorkflowSupportFiles = {
  jobLocalRustState: {
    path: ciWorkflowJobLocalRustStateScriptPath,
    output: textArtifact(ciWorkflowJobLocalRustStateScript),
  },
  resolveDevenv: {
    path: ciWorkflowResolveDevenvScriptPath,
    output: textArtifact(`#!/usr/bin/env bash\n\n${resolveDevenvFnScript}`),
  },
  nixGcRaceRetry: {
    path: ciWorkflowNixGcRaceRetryScriptPath,
    output: textArtifact(ciWorkflowNixGcRaceRetryScript),
  },
  nixGcRaceRetryWrapper: {
    path: ciWorkflowNixGcRaceRetryWrapperPath,
    output: textArtifact(ciWorkflowNixGcRaceRetryWrapperScript),
  },
} as const

export type CiWorkflowSupportFiles = typeof ciWorkflowSupportFiles
