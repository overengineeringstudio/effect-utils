# Lock sync validation between megarepo.lock and Nix lock files
#
# Ensures devenv.lock / flake.lock input revisions match the commits
# pinned in megarepo.lock. Catches drift in ~5ms via a single jq pass.
#
# Usage in devenv.nix:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.lock-sync {}) ];
#
# Provides: mr:lock-sync-check
#
# The check compares each megarepo.lock member's commit against the
# corresponding input rev in devenv.lock and/or flake.lock. If any
# mismatch is found, the task fails and suggests `dt mr:sync` to fix.
{
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  jq = "${pkgs.jq}/bin/jq";

  # Single-pass jq script that reads megarepo.lock + a Nix lock file and
  # outputs mismatches. Exits 0 if all in sync, 1 if any mismatch.
  # Takes two args: $1 = megarepo.lock path, $2 = lock file path
  checkScript = ''
    set -euo pipefail

    ml="$1"
    lf="$2"

    mismatches=$(${jq} -n \
      --slurpfile ml "$ml" \
      --slurpfile lf "$lf" '
      # Build list of { key: "owner/repo", rev, name } from Nix lock inputs
      # (multiple inputs can map to the same repo, e.g. effect-utils + playwright)
      [$lf[0].nodes | to_entries[] |
        select(.value.locked?.type == "github") |
        { key: "\(.value.locked.owner)/\(.value.locked.repo)", rev: .value.locked.rev, name: .key }
      ] as $lock_inputs |
      # Check each megarepo member against all matching lock inputs
      [$ml[0].members | to_entries[] |
        (.value.url | split("/") | .[-2:] | join("/")) as $mkey |
        .value.commit as $expected |
        .key as $member |
        $lock_inputs[] |
        select(.key == $mkey) |
        select(.rev != $expected) |
        { member: $member, input: .name, expected: $expected, actual: .rev }
      ] | unique_by(.input)
    ')

    count=$(echo "$mismatches" | ${jq} -r 'length')
    if [ "$count" -gt 0 ]; then
      echo "$mismatches" | ${jq} -r '.[] | "  \(.member) (\(.input)): expected \(.expected[0:12])… got \(.actual[0:12])…"'
      return 1
    fi
    return 0
  '';

  statusScript = trace.status "mr:lock-sync-check" "binary" ''
    if [ ! -f ./megarepo.lock ]; then
      exit 0
    fi

    check_lock() {
      ${checkScript}
    }

    if [ -f ./devenv.lock ]; then
      check_lock ./megarepo.lock ./devenv.lock || exit 1
    fi

    if [ -f ./flake.lock ]; then
      check_lock ./megarepo.lock ./flake.lock || exit 1
    fi

    exit 0
  '';

  execScript = trace.exec "mr:lock-sync-check" ''
    set -euo pipefail

    if [ ! -f ./megarepo.lock ]; then
      exit 0
    fi

    check_lock() {
      ${checkScript}
    }

    failed=0

    if [ -f ./devenv.lock ]; then
      echo "Checking devenv.lock against megarepo.lock..."
      if ! check_lock ./megarepo.lock ./devenv.lock; then
        failed=1
      else
        echo "  ✓ devenv.lock in sync"
      fi
    fi

    if [ -f ./flake.lock ]; then
      echo "Checking flake.lock against megarepo.lock..."
      if ! check_lock ./megarepo.lock ./flake.lock; then
        failed=1
      else
        echo "  ✓ flake.lock in sync"
      fi
    fi

    if [ "$failed" -eq 1 ]; then
      echo ""
      echo "Lock files out of sync with megarepo.lock."
      echo "Fix: dt mr:sync"
      exit 1
    fi
  '';
in
{
  tasks = {
    "mr:lock-sync-check" = {
      description = "Verify Nix lock files match megarepo.lock revisions";
      after = [ "mr:sync" ];
      status = statusScript;
      exec = execScript;
    };
  };
}
