#!/usr/bin/env bash
set +x
set -euo pipefail

# PNG-only CI adapter for the public GitBucket service.
# GitHub Actions uses a repository-allowlisted OIDC exchange for a five-minute,
# upload-only PNG token. SSH remains usable outside Actions until live cutover
# proof permits removing it; OIDC denial NEVER falls back to SSH.
# Invocation: pipeline-traces-upload-png.sh PNG_PATH -> one public HTTPS URL.
# The caller bounds each invocation to 60s. OIDC/auth requests are <= 8s;
# upload is <= 40s. Authentication responses stay in mode-0700 scratch (0600 files).

[[ $# == 1 ]] || exit 1
png="$1"
[[ -f "$png" && -s "$png" ]] || exit 1
png_size="$(wc -c < "$png")"
(( png_size <= 5 * 1024 * 1024 )) || exit 1
[[ "$(od -An -tx1 -N8 "$png" | tr -d ' \n')" == 89504e470d0a1a0a ]] || exit 1

umask 077
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
trap 'exit 1' INT TERM
# Never forward raw HTTP/authentication diagnostics to a CI warning or stdout. The
# original stderr (fd 3) receives exactly one sanitized line on failure:
# `gitbucket-upload: <oidc|exchange|challenge|sign|verify|upload|url> <http NNN|exit N>`. It never
# carries response bodies, tokens, key material or ssh-keygen output.
exec 3>&2 2> "$scratch/diagnostics.log"
fail() {
  printf 'gitbucket-upload: %s %s\n' "$1" "$2" >&3
  exit 1
}
# request STAGE MAX_SECONDS OUTPUT CURL_ARGS...: the body goes to OUTPUT only. An HTTP
# error status (curl --fail, exit 22) is reported as `http NNN`; any other failure by
# curl's exit code, so a timeout reads `<stage> exit 28` even after headers arrived.
request() {
  local stage="$1" max_time="$2" output="$3" status code=0
  shift 3
  status="$(curl --fail --silent --show-error --connect-timeout 3 --max-time "$max_time" \
    --output "$output" --write-out '%{http_code}' "$@")" || code=$?
  (( code == 0 )) && return 0
  (( code == 22 )) && [[ "$status" =~ ^[1-9][0-9]{2}$ ]] && fail "$stage" "http $status"
  fail "$stage" "exit $code"
}
base=https://gitbucket.schickling.dev
if [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]]; then
  [[ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]] || fail oidc 'exit 1'
  printf 'Authorization: Bearer %s\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" > "$scratch/oidc-header"
  unset ACTIONS_ID_TOKEN_REQUEST_TOKEN PIPELINE_TRACES_ASSET_SSH_KEY
  request oidc 8 "$scratch/oidc-response.json" \
    --header "@$scratch/oidc-header" --get \
    --data-urlencode "audience=$base/api/auth/github-actions" "$ACTIONS_ID_TOKEN_REQUEST_URL"
  code=0
  jq -ce '{token:(.value | select(type == "string" and length > 0))}' \
    "$scratch/oidc-response.json" > "$scratch/exchange-request.json" || code=$?
  (( code == 0 )) || fail oidc "exit $code"
  request exchange 8 "$scratch/verify-response.json" \
    --request POST "$base/api/auth/github-actions" \
    --header 'Content-Type: application/json' \
    --data-binary "@$scratch/exchange-request.json"
  auth_stage=exchange
else
  [[ -n "${PIPELINE_TRACES_ASSET_USERNAME:-}" && -n "${PIPELINE_TRACES_ASSET_SSH_KEY:-}" ]] || fail challenge 'exit 1'
  printf '%s\n' "$PIPELINE_TRACES_ASSET_SSH_KEY" > "$scratch/key"
  unset PIPELINE_TRACES_ASSET_SSH_KEY
jq -cn --arg username "$PIPELINE_TRACES_ASSET_USERNAME" '{username:$username}' > "$scratch/challenge-request.json"
request challenge 8 "$scratch/challenge-response.json" \
  --request POST "$base/api/auth/ssh-challenge" \
  --header 'Content-Type: application/json' \
  --data-binary "@$scratch/challenge-request.json"
code=0
jq -ej '.challenge | select(type == "string" and length > 0)' \
  "$scratch/challenge-response.json" > "$scratch/challenge" || code=$?
(( code == 0 )) || fail challenge "exit $code"
# Sign exact challenge bytes without adding a newline, as the CLI does.
ssh-keygen -Y sign -n gitbucket -f "$scratch/key" - \
  < "$scratch/challenge" > "$scratch/signature" || code=$?
(( code == 0 )) || fail sign "exit $code"
base64 -w0 < "$scratch/signature" > "$scratch/signature-base64"
jq -cn --arg username "$PIPELINE_TRACES_ASSET_USERNAME" \
  --rawfile challenge "$scratch/challenge" --rawfile signature "$scratch/signature-base64" \
  '{username:$username,challenge:$challenge,signature:$signature}' > "$scratch/verify-request.json"
request verify 8 "$scratch/verify-response.json" \
  --request POST "$base/api/auth/ssh-verify" \
  --header 'Content-Type: application/json' \
  --data-binary "@$scratch/verify-request.json"
  auth_stage=verify
fi
jq -er '.access_token | select(type == "string" and length > 0 and (test("[\\r\\n]") | not)) | "Authorization: Bearer " + .' \
  "$scratch/verify-response.json" > "$scratch/authorization-header" || code=$?
(( code == 0 )) || fail "$auth_stage" "exit $code"
request upload 40 "$scratch/upload-response.json" \
  --request POST "$base/api/upload" \
  --header "@$scratch/authorization-header" \
  --form "file=@$png;type=image/png" --form 'public_ok=1' \
  --form 'tags=pipeline-traces'
# The supported API returns a relative path. Never accept a different origin,
# server diagnostic, or arbitrary response as an image URL.
jq -er --arg base "$base" \
  '.url | select(type == "string" and test("^/api/get/[a-f0-9]{64}$")) | $base + .' \
  "$scratch/upload-response.json" || code=$?
(( code == 0 )) || fail url "exit $code"
