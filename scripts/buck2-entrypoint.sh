#!@shell@
# Keep a warm pinned-Buck loop out of the JavaScript runtime. Cache only complete
# read-only invocations with identical config, arguments and exported environment.
set -euo pipefail
# Keep local actions in the gate's cgroup. Native Buck cannot route individual
# commands back to their client's cgroup from a shared daemon-owned scope.
if [[ -n "${GATE_SLOT_CLASS:-}" && "${BUCK2_GATE_WRAPPER_ACTIVE:-}" != 1 ]]; then
  export BUCK2_GATE_WRAPPER_ACTIVE=1
  gate_args=("$@")
  gate_child=""
  gate_exit_signal=""
  gate_cleanup() {
    trap - EXIT
    trap '' INT TERM HUP
    @launcher@ @native@ --gate-cleanup "${gate_args[@]}" || true
  }
  gate_finish() {
    local result="$1"
    gate_cleanup
    if [[ -n "$gate_exit_signal" ]]; then
      # Re-signal in normal flow, outside both signal and EXIT trap contexts.
      trap - "$gate_exit_signal"
      kill -s "$gate_exit_signal" "$$"
    fi
    exit "$result"
  }
  gate_signal() {
    gate_exit_signal="$1"
    trap '' INT TERM HUP
    if [[ -n "$gate_child" ]]; then
      kill -s "$gate_exit_signal" "$gate_child" 2>/dev/null || true
      wait "$gate_child" 2>/dev/null || true
    fi
    return 0
  }
  trap gate_cleanup EXIT
  trap 'gate_signal INT' INT
  trap 'gate_signal TERM' TERM
  trap 'gate_signal HUP' HUP
  gate_result=0
  @launcher@ @native@ --gate-admit "${gate_args[@]}" || gate_result=$?
  if [[ "$gate_result" != 0 || -n "$gate_exit_signal" ]]; then
    gate_finish "$gate_result"
  fi
  # Bash otherwise makes asynchronous commands inherit ignored INT/QUIT.
  # Reset before exec without changing the process group.
  (trap - INT QUIT TERM HUP; exec "$0" "$@") <&0 &
  gate_child=$!
  if [[ -n "$gate_exit_signal" ]]; then
    gate_signal "$gate_exit_signal"
    gate_finish 0
  fi
  gate_result=0
  wait "$gate_child" || gate_result=$?
  gate_finish "$gate_result"
fi
root="$PWD"
while [[ ! -f "$root/.buckroot" && "$root" != / ]]; do root="${root%/*}"; [[ -n "$root" ]] || root=/; done
cache=""
if [[ $# -gt 0 && -n "${HOME:-}${XDG_CACHE_HOME:-}" && -f "$root/.buckroot" && -f "$root/.buckconfig" && ! -d "$root/.buckconfig.d" \
  && -z "${CI_BUCK2_CACHE_EVIDENCE_PATH:-}" \
  && -z "${BUCK2_PRIVATE_CACHE_WRITE_AUTH:-}${BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH:-}${BUCK2_CACHE_WRITE_BASIC_AUTH:-}" ]]; then
  tracked="$(< "$root/.buckconfig")"
  local_config=""
  if [[ -f "$root/.buckconfig.local" ]]; then local_config="$(< "$root/.buckconfig.local")"; fi
  watchman_config=""
  if [[ -f "$root/.watchmanconfig" ]]; then watchman_config="$(< "$root/.watchmanconfig")"; fi
  simple=true
  case "$tracked$local_config" in *'<file:'*) simple=false ;; esac
  for arg in "$@"; do
    case "$arg" in @*|--flagfile|--config-file|--config-file=*) simple=false ;; esac
  done
  provider_marker=""
  case "$tracked$local_config" in
    *watchman*)
      isolation="${BUCK_ISOLATION_DIR:-v2}"
      expect_isolation=false
      for arg in "$@"; do
        if [[ "$expect_isolation" = true ]]; then
          isolation="$arg"
          expect_isolation=false
        else
          case "$arg" in
            --) break ;;
            --isolation-dir) expect_isolation=true ;;
            --isolation-dir=*) isolation="${arg#--isolation-dir=}" ;;
          esac
        fi
      done
      case "$isolation" in ""|.|..|*/*) simple=false ;; esac
      marker="${HOME:-}/.buck/file-watcher-admission-v1/${root#/}/$isolation.json"
      if [[ -f "$marker" && ! -L "$marker" ]]; then
        provider_marker="$(< "$marker")"
      else
        simple=false
      fi
      ;;
  esac
  if [[ "$simple" = true ]]; then
    key="$( { printf '%s\0' "$PWD" "$root" "$tracked" "$local_config" "$watchman_config" "$provider_marker"; export -p; printf '%s\0' "$@"; } | @sha256@ )"
    cache="${XDG_CACHE_HOME:-$HOME/.cache}/effect-utils/buck2-launch-v2/${key%% *}"
    if [[ -f "$cache" && ! -L "$cache" ]]; then
      exec 3< "$cache"
      if read -r expires <&3 && [[ "$expires" =~ ^[0-9]+$ ]] \
        && (( EPOCHSECONDS < expires && expires - EPOCHSECONDS <= 5 )); then
        mapfile -d '' -t admitted <&3
        exec 3<&-
        exec @native@ "${admitted[@]}"
      fi
      exec 3<&-
    fi
  fi
fi
exec @launcher@ @native@ --launch-cache "$cache" "$@"
