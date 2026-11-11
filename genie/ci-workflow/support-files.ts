import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'
import { defineRepoContext } from '../../packages/@overeng/genie/src/runtime/repo-context/mod.ts'
import { resolveDevenvFnScript } from './shared.ts'

const withTrailingNewline = (content: string) =>
  content.endsWith('\n') === true ? content : `${content}\n`
const dollar = '$'

const textArtifact = (content: string): GenieOutput<string> =>
  createGenieOutput({
    data: content,
    stringify: () => withTrailingNewline(content),
  })

/**
 * Reads a script that ships as a real file in this repo and emits it verbatim.
 *
 * Anchors on this module's own location so the file resolves out of the effect-utils checkout even
 * when read from a consumer repo, where effect-utils is mirrored under `repos/effect-utils/`. A
 * cwd-relative `readFileSync` would silently resolve against the consumer's root instead.
 *
 * Resolved lazily, not at module scope: this module is reachable from the barrel during genie's cold
 * bootstrap phase, where touching the filesystem or the repo-context machinery reaches packages that
 * do not exist yet. Deferring the read until the artifact is actually generated keeps the bootstrap
 * phase free of that dependency.
 */
let repoContext: ReturnType<typeof defineRepoContext> | undefined
const sharedScriptArtifact = (repoRelativePath: string): GenieOutput<string> => {
  repoContext ??= defineRepoContext({ name: 'effect-utils', importMetaUrl: import.meta.url })
  return textArtifact(repoContext.readText(repoRelativePath))
}

export const ciWorkflowNixGcRaceRetryScriptPath = 'genie/ci-scripts/nix-gc-race-retry.sh'
export const ciWorkflowMeasurementValidatorsPath = 'genie/ci-scripts/ci-measurement-validators.cjs'
/**
 * Where consumers emit the shared validator. Distinct from the `ciWorkflow*` paths below, which name
 * the source inside this repo: these are the paths in the consuming repository.
 */
export const emittedPrSnapshotValidatorPath = '.github/scripts/pr-snapshot-artifact.mjs'
export const emittedPrSnapshotValidatorTestPath = '.github/scripts/pr-snapshot-artifact.test.mjs'

export const ciWorkflowPrSnapshotArtifactScriptPath = 'genie/ci-scripts/pr-snapshot-artifact.mjs'
export const ciWorkflowPrSnapshotArtifactTestPath = 'genie/ci-scripts/pr-snapshot-artifact.test.mjs'
export const ciWorkflowNixGcRaceRetryWrapperPath = 'genie/ci-scripts/run-with-nix-gc-race-retry.sh'
export const ciWorkflowJobLocalRustStateScriptPath =
  'genie/ci-scripts/prepare-job-local-rust-state.sh'
export const ciWorkflowResolveDevenvScriptPath = 'genie/ci-scripts/resolve-devenv.sh'
export const ciWorkflowPrefetchLockedInputsScriptPath = 'genie/ci-scripts/prefetch-locked-inputs.sh'
export const ciWorkflowEvictPnpmDepsCachedOutputsScriptPath =
  'genie/ci-scripts/evict-pnpm-deps-cached-outputs.sh'

export const ciWorkflowResolveDevenvScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

source "${dollar}{BASH_SOURCE[0]%/*}/prefetch-locked-inputs.sh"

${resolveDevenvFnScript}

main() {
  local lock_file="${dollar}{1:-devenv.lock}"
  if [ ! -f "${dollar}lock_file" ]; then
    echo "::error::${dollar}lock_file is missing" >&2
    exit 1
  fi
  DEVENV_REV="${dollar}(jq -r .nodes.devenv.locked.rev "${dollar}lock_file")"
  if [ -z "${dollar}DEVENV_REV" ] || [ "${dollar}DEVENV_REV" = null ]; then
    echo "::error::${dollar}lock_file missing .nodes.devenv.locked.rev" >&2
    exit 1
  fi

  local state_root="${dollar}{RUNNER_TEMP:?RUNNER_TEMP not set}/composition-state"
  DIAG_ROOT="${dollar}state_root/nix-store-diagnostics/${dollar}{GITHUB_JOB:-job}-${dollar}{RUNNER_OS:-unknown}-${dollar}{GITHUB_RUN_ATTEMPT:-0}"
  mkdir -p "${dollar}DIAG_ROOT"
  printf 'NIX_STORE_DIAGNOSTICS_DIR=%s\n' "${dollar}DIAG_ROOT" >> "${dollar}GITHUB_ENV"

  {
    echo "timestamp_utc=${dollar}(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "runner_name=${dollar}{RUNNER_NAME:-unknown}"
    echo "runner_os=${dollar}{RUNNER_OS:-unknown}"
    echo "runner_arch=${dollar}{RUNNER_ARCH:-unknown}"
    echo "github_job=${dollar}{GITHUB_JOB:-unknown}"
    echo "github_run_id=${dollar}{GITHUB_RUN_ID:-unknown}"
    echo "nix_user_conf_files=${dollar}{NIX_USER_CONF_FILES:-}"
    nix --version || true
  } > "${dollar}DIAG_ROOT/environment.txt" 2>&1

  # Keep all warming inside this operation and its existing timeout boundary.
  local prefetch_pid
  prefetch_locked_inputs "${dollar}lock_file" "${dollar}DIAG_ROOT/locked-input-prefetch" &
  prefetch_pid="${dollar}!"
  trap '[ -z "${dollar}{prefetch_pid:-}" ] || { kill "${dollar}prefetch_pid" 2>/dev/null || true; wait "${dollar}prefetch_pid" 2>/dev/null || true; }' EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT

  if ! DEVENV_OUT="${dollar}(resolve_devenv 2> >(tee "${dollar}DIAG_ROOT/resolve-devenv.log" >&2))"; then
    echo "::error::resolve_devenv failed. Last 30 lines of log:" >&2
    tail -30 "${dollar}DIAG_ROOT/resolve-devenv.log" >&2 || true
    exit 1
  fi
  DEVENV_BIN="${dollar}DEVENV_OUT/bin/devenv"

  if ! nix-store --check-validity "${dollar}DEVENV_OUT" 2>/dev/null; then
    echo "::warning::devenv store path invalid, repairing targeted path..." >&2
    nix-store --repair-path "${dollar}DEVENV_OUT" > "${dollar}DIAG_ROOT/nix-store-verify-repair.log" 2>&1 || true
    rm -rf "${dollar}{XDG_CACHE_HOME:-${dollar}HOME/.cache}"/nix/eval-cache-* ~/.cache/nix/eval-cache-*
    if ! DEVENV_OUT="${dollar}(resolve_devenv 2> >(tee "${dollar}DIAG_ROOT/resolve-devenv-post-repair.log" >&2))"; then
      echo "::error::resolve_devenv failed after repair. Last 30 lines of log:" >&2
      tail -30 "${dollar}DIAG_ROOT/resolve-devenv-post-repair.log" >&2 || true
      exit 1
    fi
    DEVENV_BIN="${dollar}DEVENV_OUT/bin/devenv"
  fi

  if [ ! -L "${dollar}DEVENV_GC_ROOT" ] || [ ! "${dollar}DEVENV_GC_ROOT" -ef "${dollar}DEVENV_OUT" ]; then
    echo "::error::devenv resolution did not publish the expected job-scoped GC root: ${dollar}DEVENV_GC_ROOT" >&2
    exit 1
  fi

  printf 'DEVENV_REV=%s\nDEVENV_GC_ROOT=%s\nDEVENV_BIN=%s\n' \
    "${dollar}DEVENV_REV" "${dollar}DEVENV_GC_ROOT" "${dollar}DEVENV_BIN" >> "${dollar}GITHUB_ENV"
  wait "${dollar}prefetch_pid" || true
  prefetch_pid=''
  trap - EXIT TERM INT
  "${dollar}DEVENV_BIN" version | tee "${dollar}DIAG_ROOT/devenv-version.txt"
}

if [[ "${dollar}{BASH_SOURCE[0]}" == "${dollar}0" ]]; then
  main "${dollar}@"
fi`

// Below even the shortest measured Resolve devenv deadline (macOS); observation only.
export const preparationDiagnosticSeconds = 120

export const ciWorkflowNixGcRaceRetryScript = String.raw`#!/usr/bin/env bash

run_nix_gc_race_retry() {
  local task="$1"
  local max="${dollar}{NIX_GC_RACE_MAX_RETRIES:-10}"
  local heartbeat="${dollar}{CI_PROGRESS_HEARTBEAT_SECONDS:-60}"
  local daemon_socket_retry_delay="${dollar}{NIX_DAEMON_SOCKET_RETRY_DELAY_SECONDS:-2}"
  # Diagnostic threshold only: one bounded dump per attempt, never a deadline.
  local preparation_threshold="${dollar}{CI_PREPARATION_DIAGNOSTIC_SECONDS:-${preparationDiagnosticSeconds}}"
  local attempt=1
  local repaired_missing_subpaths=()
  # The guillemets Nix wraps a flake reference in, built from their UTF-8 bytes so this
  # generator template stays ASCII: a non-ASCII literal here can be re-encoded by the
  # transpiler into an escape sequence that String.raw would emit verbatim.
  local flake_ref_open flake_ref_close nix_cache_root
  flake_ref_open=$'\302\253'
  flake_ref_close=$'\302\273'
  nix_cache_root="${dollar}{XDG_CACHE_HOME:-${dollar}HOME/.cache}/nix"
  local log log_dir stdout_pipe stderr_pipe rc path missing_subpath repaired_missing_subpath start now elapsed hb_pid stdout_tee_pid stderr_tee_pid flattened saw_invalid_path saw_cachix_signature saw_fetch_signature saw_daemon_socket_failure saw_missing_flake_subpath missing_subpath_was_repaired had_errexit preparation_start

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

  # Observe the existing tee log; leave the foreground command and its signals alone.
  preparation_diagnostics() {
    python3 - "$log" "$log_dir" "$$" "$hb_pid" "$stdout_tee_pid" "$stderr_tee_pid" "$1" "$preparation_threshold" <<'PY'
import os
import re
import subprocess
import sys

log, state, root, *args = sys.argv[1:]
excluded = set(args[:3])
elapsed, threshold = map(int, args[3:])
pending = {}
overflow = False
started = False
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
with open(log, errors="replace") as stream:
    for raw in stream:
        line = ansi.sub("", raw).strip()
        if re.search(r"(?:^|[\u2022\u2713]\s+)Running tasks\b", line):
            started = True
        activity = re.search(r"[\u2022\u2713]\s+(Building|Downloading)\s+(.+?)(?:\s+in\s+[\d.]+\s*[a-z]+)?$", line)
        if activity:
            kind, name = activity.groups()
            key = (kind, name)
            if "\u2713" in line:
                pending.pop(key, None)
            elif len(pending) < 24:
                pending[key] = None
            else:
                overflow = True
if started:
    marker = os.path.join(state, "tasks-started")
    if not os.path.exists(marker):
        open(marker, "w").close()
        print("::notice::[ci] phase: tasks started (observed devenv output)", flush=True)
    sys.exit()
marker = os.path.join(state, "preparation-dumped")
if elapsed < 0 or elapsed < threshold or os.path.exists(marker):
    sys.exit()
open(marker, "w").close()

def redact(value):
    # Do not expose URL credentials/query tokens, secret argv options, or known env secrets.
    value = re.sub(r"(?i)\b[a-z][a-z0-9+.-]*://[^\s]+", "[REDACTED_URL]", value)
    value = re.sub(r"""(?i)((?:--)?[\w-]*(?:token|password|secret|authorization|credential|api[_-]?key)[\w-]*[=:\s]+)(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s]+)""", r"\1[REDACTED]", value)
    value = re.sub(r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b", "[REDACTED]", value)
    for key, secret in os.environ.items():
        if re.search(r"(?i)token|password|secret|credential|api.?key", key) and secret:
            value = value.replace(secret, "[REDACTED]")
    home = os.environ.get("HOME")
    return value.replace(home, "~") if home else value

snapshot = ["Preparation snapshot (best effort; no lock ownership inferred)"]
def probe(argv):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=2)
        return result.stdout if result.returncode == 0 else "unavailable"
    except (OSError, subprocess.SubprocessError):
        return "unavailable"

try:
    group = os.getpgid(int(root))
    # pgid is used only for selection; include wait channel and bounded argv in evidence.
    processes = probe(["ps", "-axo", "pid=,ppid=,pgid=,stat=,wchan:32=,etime=,args="])
    rows = [raw.split(None, 6) for raw in processes.splitlines()]
    rows = [row for row in rows if len(row) == 7 and all(x.isdigit() for x in row[:3])]
    if not rows:
        processes = probe(["ps", "-axo", "pid=,ppid=,pgid=,stat=,etime=,args="])
        for raw in processes.splitlines():
            fields = raw.split(None, 5)
            if len(fields) == 6 and all(x.isdigit() for x in fields[:3]):
                rows.append(fields[:4] + ["-"] + fields[4:])
    snapshot.append("pid ppid stat wchan etime args (argv truncated to 240 characters)")
    nix_pids = []
    for pid, parent, pgid, status, channel, age, argv in rows:
        if re.search(r"(?:^|/|\s)nix(?:-daemon|-store)?(?:\s|$)", argv):
            nix_pids.append(pid)
        if pgid == str(group):
            if len(snapshot) < 66:
                snapshot.append(f"{pid} {parent} {status} {channel} {age} {redact(argv)[:240]}")
            elif len(snapshot) == 66:
                snapshot.append("[truncated: process group]")
    if sys.platform == "darwin":
        daemon = "unavailable"
        for label in ["org.nixos.nix-daemon", "systems.determinate.nix-daemon"]:
            daemon = probe(["launchctl", "print", "system/" + label])
            if daemon != "unavailable":
                break
        daemon = "\n".join(daemon.splitlines()[:12])
    else:
        daemon = probe(["systemctl", "show", "nix-daemon.service",
            "--property=ActiveState,SubState,MainPID", "--no-pager"])
    snapshot.append("nix daemon: " + daemon[:1024])
    snapshot.append("open /nix/var/nix descriptors (not proof of lock ownership):")
    for pid in nix_pids[:16]:
        try:
            for fd in list(os.scandir(f"/proc/{pid}/fd"))[:256]:
                try:
                    target = os.readlink(fd.path)
                    if target.startswith("/nix/var/nix/"):
                        snapshot.append(f"pid={pid} fd={fd.name} {target}")
                except OSError:
                    pass
        except OSError:
            snapshot.append(f"pid={pid}: descriptors unavailable")
except (OSError, ValueError):
    snapshot.append("process group unavailable")

# The resolving child sets this directory too; derive it here because child env cannot
# propagate back to the retry wrapper. Each attempt has its own marker and snapshot.
diag = os.environ.get("NIX_STORE_DIAGNOSTICS_DIR") or os.path.join(
    os.environ.get("RUNNER_TEMP", state), "composition-state", "nix-store-diagnostics",
    "-".join(os.environ.get(key, default) for key, default in
        [("GITHUB_JOB", "job"), ("RUNNER_OS", "unknown"), ("GITHUB_RUN_ATTEMPT", "0")]))
try:
    import glob
    for path in sorted(glob.glob(os.path.join(diag, "locked-input-prefetch", "*.log")))[:8]:
        if not os.path.isfile(path):
            continue
        with open(path, "rb") as stream:
            stream.seek(max(0, os.fstat(stream.fileno()).st_size - 4096))
            snapshot.append("prefetch tail: " + os.path.basename(path))
            snapshot.extend(stream.read().decode(errors="replace").splitlines()[-20:])
    os.makedirs(diag, exist_ok=True)
    import tempfile
    with tempfile.NamedTemporaryFile(mode="w", prefix="preparation-", suffix=".log",
                                     dir=diag, delete=False) as stream:
        stream.write(redact("\n".join(snapshot))[:24576] + "\n")
except OSError:
    pass

def safe_name(value):
    # Only basenames: never replay paths, URL credentials/query strings or argv.
    value = value.split("?", 1)[0].split("#", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    return re.sub(r"[^a-zA-Z0-9_.+-]", "_", value)[:120] or "unknown"

lines = ["::notice::[ci] preparation diagnostics begin (observed pending activities; not lock ownership)"]
try:
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,etime=,comm="],
        capture_output=True, text=True, timeout=2, check=True,
    )
    rows = [line.split(None, 3) for line in result.stdout.splitlines()]
    children = [row for row in rows if len(row) == 4 and row[1] == root and row[0] not in excluded]
    tree = list(children)
    for row in tree:
        tree.extend(child for child in rows if len(child) == 4 and child[1] == row[0])
    for pid, parent, age, command in tree[:8]:
        lines.append(f"process pid={pid} parent={parent} elapsed={age} command={safe_name(command)}")
    if len(tree) > 8:
        lines.append("[truncated: process tree exceeds 8 entries]")
    if not tree:
        lines.append("process tree unavailable (invocation may have exited)")
except (OSError, subprocess.SubprocessError):
    lines.append("process tree unavailable (probe failed or exceeded 2 s)")
for kind, name in pending:
    lines.append(f"pending {kind.lower()}: {safe_name(name)}")
if not pending:
    lines.append("pending Nix activities: unknown (no unmatched output markers)")
if overflow:
    lines.append("[truncated: more than 24 pending activities observed]")
lines.append("::notice::[ci] preparation diagnostics end")
payload = "\n".join(lines)
if len(lines) > 40 or len(payload.encode()) > 8192:
    payload = "\n".join(lines[:38]).encode()[:8000].decode(errors="ignore") + "\n[truncated: diagnostic output cap]"
print(payload, flush=True)
PY
  }

  while [ "$attempt" -le "$max" ]; do
    echo "::notice::[ci] starting $task (attempt $attempt/$max)"
    log=$(mktemp)
    log_dir=$(mktemp -d)
    echo "::notice::[ci] phase: environment realization started (attempt $attempt/$max)"
    preparation_start=$(date +%s)
    stdout_pipe="$log_dir/stdout"
    stderr_pipe="$log_dir/stderr"
    mkfifo "$stdout_pipe" "$stderr_pipe"
    tee -a "$log" < "$stdout_pipe" &
    stdout_tee_pid=$!
    tee -a "$log" < "$stderr_pipe" >&2 &
    stderr_tee_pid=$!
    (
      hb_pid=$BASHPID
      heartbeat_sleep_pid=''
      trap '[ -z "$heartbeat_sleep_pid" ] || kill "$heartbeat_sleep_pid" 2>/dev/null || true; exit 0' TERM INT
      while true; do
        sleep "$heartbeat" &
        heartbeat_sleep_pid=$!
        wait "$heartbeat_sleep_pid" || exit 0
        now=$(date +%s)
        elapsed=$((now - start))
        echo "::notice::[ci] $task still running after $elapsed s (attempt $attempt/$max)"
        preparation_diagnostics "$((now - preparation_start))" || true
      done
    ) &
    hb_pid=$!
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
    kill "$hb_pid" 2>/dev/null || true
    wait "$hb_pid" 2>/dev/null || true

    # Always report task start even for commands shorter than one heartbeat.
    preparation_diagnostics -1 || true
    rm -rf "$log_dir"

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
    # A flake input whose source landed in the local fetcher/Git/tarball caches
    # incompletely renders as an error naming a path INSIDE a flake reference:
    #   error: path 'FLAKE_REF/<subpath>' does not exist
    # where Nix wraps FLAKE_REF in guillemets. A genuinely absent store path is reported
    # with the same wording, so the match is anchored on the guillemet-wrapped form
    # (built above from its UTF-8 bytes) and on 'path' directly following 'error:'.
    missing_subpath=$(printf '%s' "$flattened" |
      grep -o "error:[[:space:]]*path '${dollar}{flake_ref_open}[^']*${dollar}{flake_ref_close}[^']*' does not exist" |
      head -1 |
      sed -E "s/^error:[[:space:]]*path '//; s/' does not exist${dollar}//" || true)
    saw_invalid_path=false
    saw_cachix_signature=false
    saw_fetch_signature=false
    saw_daemon_socket_failure=false
    saw_missing_flake_subpath=false
    [ -n "$path" ] && saw_invalid_path=true
    [ -n "$missing_subpath" ] && saw_missing_flake_subpath=true
    printf '%s' "$flattened" | grep -Eq 'error:[[:space:]]*.*Failed to convert config\.cachix to JSON' && saw_cachix_signature=true || true
    printf '%s' "$flattened" | grep -Eq 'error:[[:space:]]*.*while evaluating the option.*cachix\.package' && saw_cachix_signature=true || true
    printf '%s' "$flattened" | grep -Eq 'error:[[:space:]]*cannot read file from tarball:[[:space:]]*Truncated tar archive detected while reading data' && saw_fetch_signature=true || true
    # fetchurl gives up after its own curl retries with this exact wording; an origin 5xx
    # (GitHub release assets) is a transient network failure, not a build defect.
    printf '%s' "$flattened" | grep -Eq 'error:[[:space:]]*cannot download [^[:space:]]+ from any mirror' && saw_fetch_signature=true || true
    # Nix can resume an already complete body at EOF after an HTTP/2 drop; the server
    # correctly returns 416. No nix.conf setting fixes this resume-at-EOF bug.
    printf '%s' "$flattened" | grep -Eq "error:[[:space:]]*unable to download '[^']+': HTTP error 416([^0-9]|${dollar})" && saw_fetch_signature=true || true
    # Cachix can return a transient conflict for narinfo GETs; Nix treats 409 as permanent.
    printf '%s' "$flattened" | grep -Eq "error:[[:space:]]*unable to download 'https?://[^']+\\.narinfo': HTTP error 409([^0-9]|${dollar})" && saw_fetch_signature=true || true
    printf '%s' "$flattened" | grep -Eq "error:[[:space:]]*cannot connect to socket at '/nix/var/nix/daemon-socket/socket'" && saw_daemon_socket_failure=true || true
    rm -f "$log"

    # The guillemet form can also describe a path that upstream removed permanently, which
    # no amount of cache purging fixes. Repair each exact path once; a repeated failure for
    # that same path is reported as the permanent path error it is, with its own summary
    # note, rather than falling through to the generic "no transient signature" message or
    # burning $max attempts.
    missing_subpath_was_repaired=false
    if [ "$saw_missing_flake_subpath" = true ] && [ "${dollar}{repaired_missing_subpaths[0]+present}" = present ]; then
      for repaired_missing_subpath in "${dollar}{repaired_missing_subpaths[@]}"; do
        if [ "$repaired_missing_subpath" = "$missing_subpath" ]; then
          missing_subpath_was_repaired=true
          break
        fi
      done
    fi
    if [ "$missing_subpath_was_repaired" = true ]; then
      echo "::error::Nix flake input subpath still missing for $task after one cache repair: $missing_subpath; treating it as a permanent missing path"
      write_summary failure "Nix flake input subpath still missing after one cache repair: $missing_subpath"
      return "$rc"
    fi

    if [ "$saw_invalid_path" != true ] && [ "$saw_cachix_signature" != true ] && [ "$saw_fetch_signature" != true ] && [ "$saw_daemon_socket_failure" != true ] && [ "$saw_missing_flake_subpath" != true ]; then
      echo "::warning::[ci] $task failed after $elapsed s without a detected transient Nix failure"
      write_summary failure "No transient Nix failure signature detected"
      return "$rc"
    fi

    if [ "$saw_daemon_socket_failure" = true ]; then
      echo "::warning::Nix daemon socket failure detected for $task (attempt $attempt/$max); waiting $daemon_socket_retry_delay s for host supervision before retrying without mutating the host daemon"
    elif [ "$saw_missing_flake_subpath" = true ]; then
      echo "::warning::Incomplete Nix flake input cache detected for $task (attempt $attempt/$max): $missing_subpath; retrying with a refreshed input cache"
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
    # Both cache roots: the legacy HOME-relative path and the XDG root this helper resolves,
    # which diverge whenever XDG_CACHE_HOME is set away from $HOME/.cache.
    rm -rf ~/.cache/nix/eval-cache-* "${dollar}nix_cache_root"/eval-cache-*
    if [ "$saw_missing_flake_subpath" = true ]; then
      # Determinate Nix versions these caches, so the bare legacy names match nothing.
      # The sqlite globs intentionally cover the -shm/-wal sidecars: leaving those behind
      # next to a deleted database is what turns a repair into a corrupt-cache failure.
      rm -rf "${dollar}nix_cache_root"/tarball-cache-v* "${dollar}nix_cache_root"/tarball-cache
      rm -rf "${dollar}nix_cache_root"/gitv*
      rm -f "${dollar}nix_cache_root"/fetcher-cache-v*.sqlite*
      repaired_missing_subpaths+=("$missing_subpath")
    fi
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
  measurementValidators: {
    path: ciWorkflowMeasurementValidatorsPath,
    get output() {
      return sharedScriptArtifact(ciWorkflowMeasurementValidatorsPath)
    },
  },
  jobLocalRustState: {
    path: ciWorkflowJobLocalRustStateScriptPath,
    output: textArtifact(ciWorkflowJobLocalRustStateScript),
  },
  evictPnpmDepsCachedOutputs: {
    path: ciWorkflowEvictPnpmDepsCachedOutputsScriptPath,
    get output() {
      return sharedScriptArtifact(ciWorkflowEvictPnpmDepsCachedOutputsScriptPath)
    },
  },
  resolveDevenv: {
    path: ciWorkflowResolveDevenvScriptPath,
    output: textArtifact(ciWorkflowResolveDevenvScript),
  },
  prefetchLockedInputs: {
    path: ciWorkflowPrefetchLockedInputsScriptPath,
    get output() {
      return sharedScriptArtifact(ciWorkflowPrefetchLockedInputsScriptPath)
    },
  },
  nixGcRaceRetry: {
    path: ciWorkflowNixGcRaceRetryScriptPath,
    output: textArtifact(ciWorkflowNixGcRaceRetryScript),
  },
  nixGcRaceRetryWrapper: {
    path: ciWorkflowNixGcRaceRetryWrapperPath,
    output: textArtifact(ciWorkflowNixGcRaceRetryWrapperScript),
  },
  /**
   * The PR snapshot artifact validator, and its adversarial boundary suite.
   *
   * Read from disk rather than embedded as a template literal: the validator is ~456 lines of real
   * JavaScript containing 66 `${...}` template expressions, which a `String.raw` literal would require
   * escaping one by one — unreviewable, and it would stop the shared source being the exact file that
   * runs. Consumers emit it verbatim, so every repo validates candidates with identical code.
   */
  prSnapshotArtifact: {
    path: ciWorkflowPrSnapshotArtifactScriptPath,
    get output() {
      return sharedScriptArtifact(ciWorkflowPrSnapshotArtifactScriptPath)
    },
  },
  prSnapshotArtifactTest: {
    path: ciWorkflowPrSnapshotArtifactTestPath,
    get output() {
      return sharedScriptArtifact(ciWorkflowPrSnapshotArtifactTestPath)
    },
  },
} as const

export type CiWorkflowSupportFiles = typeof ciWorkflowSupportFiles
