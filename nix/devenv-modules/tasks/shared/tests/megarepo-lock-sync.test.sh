#!/usr/bin/env bash
set -euo pipefail

policy="$(cd "$(dirname "$0")/.." && pwd)/megarepo-lock-sync.jq"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

write_members() {
  local current="$1"
  local legacy="$2"
  jq -n --arg current "$current" --arg legacy "$legacy" '{
    members: {
      "effect-utils": {url: "https://github.com/example/effect-utils", commit: $current},
      "effect-utils-legacy": {url: "https://github.com/example/effect-utils", commit: $legacy}
    }
  }' > "$tmpdir/megarepo.lock"
}

write_inputs() {
  jq -n --arg current "$1" --arg legacy "$2" --arg auxiliary "$3" '{
    nodes: {
      "effect-utils": {locked: {type: "github", owner: "example", repo: "effect-utils", rev: $current}},
      "effect-utils-legacy": {locked: {type: "github", owner: "example", repo: "effect-utils", rev: $legacy}},
      playwright: {locked: {type: "github", owner: "example", repo: "effect-utils", rev: $auxiliary}}
    }
  }' > "$tmpdir/devenv.lock"
}

check_count() {
  jq -n \
    --slurpfile ml "$tmpdir/megarepo.lock" \
    --slurpfile lf "$tmpdir/devenv.lock" \
    -f "$policy" \
    | jq -e --argjson expected "$1" 'length == $expected' >/dev/null
}

current="1111111111111111111111111111111111111111"
legacy="2222222222222222222222222222222222222222"
unknown="3333333333333333333333333333333333333333"

echo "Test 1: named current and legacy inputs select their exact same-repo members"
write_members "$current" "$legacy"
write_inputs "$current" "$legacy" "$current"
check_count 0

echo "Test 2: a named input cannot silently resolve to the other same-repo member"
write_inputs "$legacy" "$legacy" "$current"
check_count 1

echo "Test 3: an auxiliary input may match exactly one declared same-repo member"
write_inputs "$current" "$legacy" "$legacy"
check_count 0

echo "Test 4: an auxiliary input with no declared revision fails closed"
write_inputs "$current" "$legacy" "$unknown"
check_count 1

echo "Test 5: an auxiliary input matching multiple declared members fails closed"
write_members "$current" "$current"
write_inputs "$current" "$current" "$current"
check_count 1

echo "All megarepo lock sync tests passed."
