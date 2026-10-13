#!/usr/bin/env bash
set -euo pipefail

# An invalid provider makes accidental resolution fail; no real secrets or live
# API calls are needed. Exercise every task in isolation from its publishers.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
cd "$ROOT"
tasks=(
  test:notion-integration:notion-effect-client
  test:notion-integration:notion-cli
  test:notion-integration:notion-datasource-sync
  test:notion-integration:notion-md
  test:notion-integration:notion-react
)

for marker in CI=true GITHUB_ACTIONS=true; do
  for token_state in unset empty; do
    args=(-u CI -u GITHUB_ACTIONS -u NOTION_API_TOKEN -u NOTION_TOKEN)
    if [ "$token_state" = empty ]; then
      args+=(NOTION_API_TOKEN=)
    fi
    output="$(env "${args[@]}" "$marker" SECRETSPEC_PROVIDER=invalid-ci-test-provider \
      devenv tasks run --mode single --show-output "${tasks[@]}" 2>&1)" || {
      printf '%s\n' "$output" >&2
      exit 1
    }
    count="$(printf '%s\n' "$output" | grep -c 'not set in CI, skipping Notion integration tests (no provider access)')"
    if [ "$count" -ne "${#tasks[@]}" ]; then
      printf 'Expected all five CI tasks to skip with %s and token %s:\n%s\n' \
        "$marker" "$token_state" "$output" >&2
      exit 1
    fi
    printf 'PASS: %s, token %s: all five tasks skip without provider access\n' "$marker" "$token_state"
  done
done
