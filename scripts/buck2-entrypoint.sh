#!@shell@
# Keep a warm pinned-Buck loop out of the JavaScript runtime. Cache only complete
# read-only invocations with identical config, arguments and exported environment.
set -euo pipefail
root="$PWD"
while [[ ! -f "$root/.buckroot" && "$root" != / ]]; do root="${root%/*}"; [[ -n "$root" ]] || root=/; done
cache=""
if [[ $# -gt 0 && -n "${HOME:-}${XDG_CACHE_HOME:-}" && -f "$root/.buckroot" && -f "$root/.buckconfig" && ! -d "$root/.buckconfig.d" \
  && -z "${BUCK2_PRIVATE_CACHE_WRITE_AUTH:-}${BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH:-}${BUCK2_CACHE_WRITE_BASIC_AUTH:-}" ]]; then
  tracked="$(< "$root/.buckconfig")"
  local_config=""
  if [[ -f "$root/.buckconfig.local" ]]; then local_config="$(< "$root/.buckconfig.local")"; fi
  simple=true
  case "$tracked$local_config" in *'<file:'*) simple=false ;; esac
  for arg in "$@"; do
    case "$arg" in @*|--flagfile|--config-file|--config-file=*) simple=false ;; esac
  done
  if [[ "$simple" = true ]]; then
    key="$( { printf '%s\0' "$PWD" "$root" "$tracked" "$local_config"; export -p; printf '%s\0' "$@"; } | @sha256@ )"
    cache="${XDG_CACHE_HOME:-$HOME/.cache}/effect-utils/buck2-launch-v1/${key%% *}"
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
