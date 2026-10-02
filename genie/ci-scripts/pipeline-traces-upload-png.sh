#!/usr/bin/env bash
set +x
set -euo pipefail

# PNG-only CI adapter for the public GitBucket service. The challenge/sign/verify
# protocol mirrors dotfiles nixpkgs/shared/packages/gitbucket-cli.nix at
# fb74c4a59f1d2c6c6413ffcd84c30e4b1d818808. This intentionally small duplication
# avoids pulling a private flake or an unpinned CLI into public CI.
# Invocation: pipeline-traces-upload-png.sh PNG_PATH -> one public HTTPS URL.
# Explicit configuration: PIPELINE_TRACES_ASSET_USERNAME and step-only
# PIPELINE_TRACES_ASSET_SSH_KEY (private key material, not a bearer token).
# GitBucket grants permissions to the GitHub user, not an individual key. A fresh
# key can be independently revoked but is NOT upload-only. Provisioning and user
# authorization are operator responsibilities; never default to an assistant key.
# The caller bounds the complete invocation to 30s; each HTTP request is <= 8s.
# Authentication responses/key/token stay in mode-0700 scratch, files mode 0600.

[[ $# == 1 ]] || exit 1
png="$1"
[[ -f "$png" && -s "$png" ]] || exit 1
png_size="$(wc -c < "$png")"
(( png_size <= 5 * 1024 * 1024 )) || exit 1
[[ "$(od -An -tx1 -N8 "$png" | tr -d ' \n')" == 89504e470d0a1a0a ]] || exit 1
[[ -n "${PIPELINE_TRACES_ASSET_USERNAME:-}" && -n "${PIPELINE_TRACES_ASSET_SSH_KEY:-}" ]] || exit 1

umask 077
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
trap 'exit 1' INT TERM
# Never forward raw HTTP/authentication diagnostics to a CI warning or stdout.
exec 2> "$scratch/diagnostics.log"
printf '%s\n' "$PIPELINE_TRACES_ASSET_SSH_KEY" > "$scratch/key"
unset PIPELINE_TRACES_ASSET_SSH_KEY
base=https://gitbucket.schickling.dev
jq -cn --arg username "$PIPELINE_TRACES_ASSET_USERNAME" '{username:$username}' > "$scratch/challenge-request.json"
curl --fail --silent --show-error --connect-timeout 3 --max-time 8 \
  --request POST "$base/api/auth/ssh-challenge" \
  --header 'Content-Type: application/json' \
  --data-binary "@$scratch/challenge-request.json" > "$scratch/challenge-response.json"
jq -ej '.challenge | select(type == "string" and length > 0)' \
  "$scratch/challenge-response.json" > "$scratch/challenge"
# Sign exact challenge bytes without adding a newline, as the CLI does.
ssh-keygen -Y sign -n gitbucket -f "$scratch/key" - \
  < "$scratch/challenge" > "$scratch/signature"
base64 -w0 < "$scratch/signature" > "$scratch/signature-base64"
jq -cn --arg username "$PIPELINE_TRACES_ASSET_USERNAME" \
  --rawfile challenge "$scratch/challenge" --rawfile signature "$scratch/signature-base64" \
  '{username:$username,challenge:$challenge,signature:$signature}' > "$scratch/verify-request.json"
curl --fail --silent --show-error --connect-timeout 3 --max-time 8 \
  --request POST "$base/api/auth/ssh-verify" \
  --header 'Content-Type: application/json' \
  --data-binary "@$scratch/verify-request.json" > "$scratch/verify-response.json"
jq -er '.access_token | select(type == "string" and length > 0 and (test("[\\r\\n]") | not)) | "Authorization: Bearer " + .' \
  "$scratch/verify-response.json" > "$scratch/authorization-header"
curl --fail --silent --show-error --connect-timeout 3 --max-time 8 \
  --request POST "$base/api/upload" \
  --header "@$scratch/authorization-header" \
  --form "file=@$png;type=image/png" --form 'public_ok=1' \
  --form 'tags=pipeline-traces' > "$scratch/upload-response.json"
# The supported API returns a relative path. Never accept a different origin,
# server diagnostic, or arbitrary response as an image URL.
jq -er --arg base "$base" \
  '.url | select(type == "string" and test("^/api/get/[a-f0-9]{64}$")) | $base + .' \
  "$scratch/upload-response.json"
