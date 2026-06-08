# Restate integration tests
#
# Runs the restate-effect integration tests against a real native `restate-server`.
# The server binary is resolved via RESTATE_SERVER_BIN (set in devenv.nix from
# nix/restate.nix) with a $PATH fallback; the tests skip gracefully when no
# usable server is available (see packages/@overeng/restate-effect/test/test-utils.ts).
#
# Unlike the Notion lane there is no separate integration vitest config: the
# package's vitest.config.ts already includes `src/**/*.test.ts` (which matches
# the `*.integration.test.ts` files), and each integration suite self-skips when
# `serverAvailable` is false.
#
# Provides:
#   - test:restate-integration - Run the restate-effect integration tests
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ../shared/pnpm-task-helpers.sh
  );
  exec = ''
    set -euo pipefail
    if ! "''${RESTATE_SERVER_BIN:-restate-server}" --version >/dev/null 2>&1; then
      echo "restate-server not available (RESTATE_SERVER_BIN=''${RESTATE_SERVER_BIN:-unset}), skipping restate integration tests"
      exit 0
    fi
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
    run_package_bin vitest vitest run
  '';
in
{
  tasks."test:restate-integration" = {
    description = "Run restate-effect integration tests against a native restate-server";
    exec = trace.exec "test:restate-integration" exec;
    cwd = "packages/@overeng/restate-effect";
    after = [ "pnpm:install" ];
  };
}
