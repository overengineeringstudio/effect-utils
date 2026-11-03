#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = flake ]; then
  # A real child process, gated by the test rather than network or sleeps.
  trap 'printf "done %s\n" "$BASHPID" >&3' EXIT
  trap 'exit 143' TERM
  printf 'start %s\n' "$BASHPID" >&3
  read -r permit <&4
  [ "$permit" != fail ]
  exit
fi

source "${BASH_SOURCE[0]%/*}/prefetch-locked-inputs.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
ln -s "$(realpath "$0")" "$work/bin/nix"
export PATH="$work/bin:$PATH"
# Five shell sources, a duplicate identity, follows through the excluded branch,
# and unsupported/mutable/local inputs that must not be fetched.
jq -n '
  def github($n): {locked:{type:"github",owner:"example",repo:$n,
    rev:("a" * 40),narHash:"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}};
  {root:"root",nodes:{root:{inputs:{devenv:"devenv",one:"one",alias:"alias",
    follows:["devenv","shared"],two:"two",three:"three",four:"four",
    local:"local",mutable:"mutable",unsupported:"unsupported"}},
    devenv:((github("excluded")) + {inputs:{shared:"shared",private:"private"}}),
    private:github("private"),shared:github("shared"),one:github("one"),
    alias:github("one"),two:github("two"),three:github("three"),four:github("four"),
    local:{locked:{type:"path",path:"."}},mutable:{locked:{type:"github",owner:"x",repo:"x"}},
    unsupported:{locked:{type:"git",url:"https://example.invalid"}}}}
' > "$work/lock"
locked_shell_inputs "$work/lock" > "$work/refs"
[ "$(wc -l < "$work/refs")" -eq 5 ]
while IFS= read -r ref; do
  [[ "$ref" = github:example/*/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?narHash=sha256-* ]]
  [[ "$ref" != *excluded* && "$ref" != *private* ]]
done < "$work/refs"
printf '{invalid' > "$work/bad-lock"
if locked_shell_inputs "$work/bad-lock" >/dev/null 2>&1; then exit 1; fi

mkfifo "$work/events" "$work/permits"
exec 3<> "$work/events" 4<> "$work/permits"
prefetch_locked_inputs "$work/lock" "$work/success" 2> "$work/warnings" &
helper=$!
read -r event first <&3; [ "$event" = start ]
read -r event second <&3; [ "$event" = start ]
# Both workers are now blocked. Release one failure and four successes.
printf 'fail\nok\nok\nok\nok\n' >&4
active=2
starts=2
for ((i=0; i<8; i++)); do
  read -r event pid <&3
  if [ "$event" = start ]; then
    active=$((active + 1)); starts=$((starts + 1))
  else
    active=$((active - 1))
  fi
  [ "$active" -ge 0 ] && [ "$active" -le 2 ]
done
wait "$helper"
[ "$starts" -eq 5 ] && [ "$active" -eq 0 ]
[ -s "$work/warnings" ]
! kill -0 "$first" 2>/dev/null
! kill -0 "$second" 2>/dev/null

# Cancellation must join workers and their blocked fetch children before exit.
prefetch_locked_inputs "$work/lock" "$work/cancel" &
helper=$!
read -r event first <&3; [ "$event" = start ]
read -r event second <&3; [ "$event" = start ]
kill "$helper"
if wait "$helper"; then exit 1; fi
! kill -0 "$first" 2>/dev/null
! kill -0 "$second" 2>/dev/null
printf 'locked-input prefetch tests passed\n'
