#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

# Exercise the actual task-generated namespace launcher, not a duplicate sandbox.
# The probe runs in place of Playwright, inside the same boundary as its server.
launcher="$(nix build --impure --no-link --print-out-paths --expr "
  let
    flake = builtins.getFlake \"$NIX_FLAKE_REF\";
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    lib = pkgs.lib;
    probe = pkgs.writeShellScript \"playwright-network-probe\" ''
      set -euo pipefail
      if [ \"''\${PLAYWRIGHT_NETWORK_ISOLATED:-}\" != 1 ]; then
        if [ \"''\${EXPECT_NETWORK_ISOLATION:-0}\" = 1 ]; then
          echo 'FAIL: task did not enable available network isolation' >&2
          exit 1
        fi
        echo 'SKIP: network isolation unavailable on this platform'
        exit 0
      fi
      \${pkgs.python3}/bin/python3 - <<'PY'
import http.server
import socket
import threading
import urllib.request

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), http.server.SimpleHTTPRequestHandler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/', timeout=5) as response:
        assert response.status == 200
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.connect(('192.0.2.1', 80))
        except OSError as error:
            import errno
            assert error.errno == errno.ENETUNREACH, error
        else:
            raise AssertionError('isolated suite has a route to a non-loopback address')
finally:
    server.shutdown()
    server.server_close()
print('PASS: isolated suite reaches localhost and has no external route')
PY
    '';
    evaluated = lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        ({ ... }: {
          options.tasks = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = {}; };
          options.packages = lib.mkOption { type = lib.types.listOf lib.types.anything; default = []; };
          options.devenv.root = lib.mkOption { type = lib.types.str; default = \"$ROOT\"; };
        })
        (import $ROOT/nix/devenv-modules/tasks/shared/test-playwright.nix {
          packages = [{ name = \"probe\"; path = \".\"; isolateNetwork = true; }];
          playwrightBin = probe;
        })
      ];
    };
  in pkgs.writeShellScript \"playwright-network-task-test\" ''
    export EXPECT_NETWORK_ISOLATION=0
    \${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
      if \${pkgs.util-linux}/bin/unshare -Urn true 2>/dev/null; then
        export EXPECT_NETWORK_ISOLATION=1
      fi
    ''}
    \${evaluated.config.tasks.\"test:pw:probe\".exec}
  ''
")"
"$launcher"
