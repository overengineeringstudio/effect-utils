#!/usr/bin/env bash
# Run only in an isolated checkout of the documented historical revision.
# Setup JSON and raw evidence must stay outside Git. Do not enable shell tracing.
set -euo pipefail
mode=${1:?local, remote or remote-warm}
label=${2:?unique evidence row label}
: "${BUCK2:?absolute pinned Buck2 binary}" "${EVIDENCE_DIR:?private evidence directory}"
mkdir -p "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR"
case "$mode" in
  local)
    printf '[buck2]\n  remote_cache_enabled = false\n  allow_cache_uploads = false\n[build]\n  threads = 8\n' > .buckconfig.local
    args=(-j 8 --local-only)
    ;;
  remote|remote-warm)
    : "${NS_SETUP_FILE:?0600 setup JSON}" "${NS_POOL:?fresh owned pool label}"
    caps=$(readlink -f .buck2/capabilities)
    export NS_RE_TOKEN
    NS_RE_TOKEN=$(jq -r .ingress_auth_token "$NS_SETUP_FILE")
    {
      printf '[buck2]\n  remote_cache_enabled = true\n  allow_cache_uploads = true\n[build]\n  threads = 64\n[buck2_re_client]\n  tls = true\n  instance_name = \n  http_headers = x-nsc-ingress-auth:Bearer $NS_RE_TOKEN\n  execution_concurrency_limit = 32\n'
      jq -r '"  engine_address = " + (.scheduler_endpoint|sub("^grpcs://";"")), "  action_cache_address = " + (.storage_endpoint|sub("^grpcs://";"")), "  cas_address = " + (.storage_endpoint|sub("^grpcs://";""))' "$NS_SETUP_FILE"
      printf '[namespace_re]\n  enabled = true\n  pool = %s\n  closure_paths = ' "$NS_POOL"
      jq -jrs '[.[].closureStorePaths[]]|unique|join(" ")' "$caps"/generations/*/*/*/manifest.json
      printf ' %s\n' "$caps"
    } > .buckconfig.local
    args=(-j 64 --prefer-remote)
    if [[ $mode == remote-warm ]]; then args+=(--no-remote-cache); fi
    ;;
  *) printf 'Unknown mode: %s\n' "$mode" >&2; exit 2 ;;
esac
# Clean is outside the timed interval and stops the previous isolated daemon.
"$BUCK2" --isolation-dir fairconcurrency clean
start=$(date +%s.%N)
set +e
"$BUCK2" --isolation-dir fairconcurrency build //:quick "${args[@]}" --overall-timeout 6m --event-log "$EVIDENCE_DIR/$label.pb.zst" > "$EVIDENCE_DIR/$label.log" 2>&1
rc=$?
set -e
end=$(date +%s.%N)
printf '%s\t%s\t%s\t%s\n' "$label" "$start" "$end" "$rc" >> "$EVIDENCE_DIR/times.tsv"
"$BUCK2" --isolation-dir fairconcurrency log what-ran --format json > "$EVIDENCE_DIR/$label.what-ran.jsonl"
"$BUCK2" --isolation-dir fairconcurrency log summary > "$EVIDENCE_DIR/$label.summary"
"$BUCK2" --isolation-dir fairconcurrency log show > "$EVIDENCE_DIR/$label.events.jsonl"
exit "$rc"
