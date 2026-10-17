#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == --sandbox-outputs=* ]]
manifest="${1#--sandbox-outputs=}"
shift
[[ -s "${RUST_SANDBOX_METADATA:?Buck declared-input metadata is required}" ]]
IFS= read -r outputs < "$manifest" || [[ -n "$outputs" ]]
for output in result.txt diag.txt sidecar; do
  [[ "$outputs" == *"$output"* ]] || { printf 'Missing declared output in adapter manifest: %s\n' "$output" >&2; exit 1; }
done
exec "$@"
