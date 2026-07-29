#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

task_eval="$(
  nix eval --impure --json --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (import $ROOT/nix/devenv-modules/otel.nix {}) {
        inherit pkgs;
        lib = pkgs.lib;
        config.devenv.root = \"/tmp/effect-utils-otel-consumer\";
      };
      taskExec = module.tasks.\"otel:test:devenv-e2e\".exec;
    in {
      exec = taskExec;
      context = builtins.getContext taskExec;
    }
  "
)"
task_exec="$(printf '%s\n' "$task_eval" | jq -r '.exec')"
task_drv="$(printf '%s\n' "$task_eval" | jq -r '.context | keys[0]')"

nix-store --realise "$task_drv" >/dev/null

case "$task_exec" in
  /nix/store/*) ;;
  *)
    echo "FAIL: imported OTEL E2E task is not package-owned: $task_exec" >&2
    exit 1
    ;;
esac

if printf '%s\n' "$task_exec" | grep -q 'nix/devenv-modules'; then
  echo "FAIL: imported OTEL E2E task retained a consumer-relative repository path" >&2
  exit 1
fi

test -x "$task_exec"
bash -n "$task_exec"

foreign_cwd="$(mktemp -d)"
trap 'rm -rf "$foreign_cwd"' EXIT
mkdir -p "$foreign_cwd/empty-path" "$foreign_cwd/home"

env -i \
  HOME="$foreign_cwd/home" \
  PATH="$foreign_cwd/empty-path" \
  "$task_exec" > "$foreign_cwd/run.log"

grep -q '^ts otelite e2e test passed$' "$foreign_cwd/run.log" \
  || {
    echo "FAIL: package-owned task did not complete the real otelite E2E from a foreign cwd" >&2
    cat "$foreign_cwd/run.log" >&2
    exit 1
  }

echo "otel task consumer path test passed"
