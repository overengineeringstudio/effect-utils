#!@shell@
# Keep a warm pinned-Buck loop out of the JavaScript runtime. Cache only complete
# read-only invocations with identical config, arguments and exported environment.
set -euo pipefail
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
