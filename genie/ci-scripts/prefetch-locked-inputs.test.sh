#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = --version ]; then exit 0; fi

if [ "${1:-}" = flake ]; then
  # A real child process, gated by the test rather than network or sleeps.
  trap 'printf "done %s\n" "$BASHPID" >&3' EXIT
  trap 'exit 143' TERM
  printf 'start %s\n' "$BASHPID" >&3
  read -r -n 1 permit <&4
  [ "$permit" != f ]
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
printf 'foooo' >&4
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
if kill -0 "$first" 2>/dev/null || kill -0 "$second" 2>/dev/null; then exit 1; fi

# Cancellation must join workers and their blocked fetch children before exit.
prefetch_locked_inputs "$work/lock" "$work/cancel" &
helper=$!
read -r event first <&3; [ "$event" = start ]
read -r event second <&3; [ "$event" = start ]
kill "$helper"
if wait "$helper"; then exit 1; fi
if pgrep -f "$work/bin/nix"; then exit 1; fi
read -r event pid <&3; [ "$event" = done ]
read -r event pid <&3; [ "$event" = done ]

# Exercise the real resolver's early-failure EXIT trap, not just direct signals.
mkfifo "$work/ready" "$work/abort"
exec 5<> "$work/ready" 6<> "$work/abort"
(
  source "${BASH_SOURCE[0]%/*}/resolve-devenv.sh"
  resolve_devenv() {
    read -r event first <&3; [ "$event" = start ]
    read -r event second <&3; [ "$event" = start ]
    printf 'ready\n' >&5
    read -r abort <&6
    return 1
  }
  RUNNER_TEMP="$work" GITHUB_ENV="$work/env" main "$work/lock"
) > "$work/resolver.stdout" 2> "$work/resolver.stderr" &
resolver=$!
read -r ready <&5; [ "$ready" = ready ]
printf 'abort\n' >&6
if wait "$resolver"; then exit 1; fi
if pgrep -f "$work/bin/nix"; then exit 1; fi
printf 'locked-input prefetch tests passed\n'
