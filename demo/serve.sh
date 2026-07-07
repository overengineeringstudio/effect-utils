#!/usr/bin/env bash
# (Re)start the live control server — stable static serve, or watch/HMR for iterating.
#
#   demo/serve.sh          # regenerate dashboard + serve on :52606 (stable — use for recording)
#   demo/serve.sh watch    # + regenerate control.html whenever a source changes
#   demo/serve.sh hmr      # + live-reload the browser on change (bunx live-server) — for iterating
#   demo/serve.sh stop     # stop the server
#
# Fixed port 52606 so the standing `tailscale serve --https=8443 -> 127.0.0.1:52606`
# always lines up (no ephemeral-port mismatch). Idempotent: frees the port first.
set -euo pipefail

PORT=52606
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ROOT="$HERE/explainers"
LOG=/tmp/demo-serve.log

regen() { ( cd "$REPO" && bun demo/dashboard/build.ts ) || echo "warn: dashboard build failed (control.html not refreshed)"; }
free_port() { lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true; }

case "${1:-serve}" in
  stop) free_port; echo "stopped server on :$PORT"; exit 0 ;;
  serve|watch|hmr) : ;;
  *) echo "usage: demo/serve.sh [serve|watch|hmr|stop]"; exit 1 ;;
esac

regen
free_port

echo "→ serving $ROOT on http://127.0.0.1:$PORT"
echo "  control:  http://127.0.0.1:$PORT/control.html"
echo "  tailnet:  https://mbp2025.tail8108.ts.net:8443/control.html"
echo "  (tailnet down? re-establish the standing serve once:"
echo "     AGENT_POLICY_BYPASS=1 tailscale serve --bg --https=8443 http://127.0.0.1:$PORT )"

if [ "${1:-serve}" = "hmr" ]; then
  # Live-reload static server (auto-refreshes the browser on file change). NOT for recording.
  exec bunx --bun live-server "$ROOT" --port=$PORT --no-browser
fi

python3 -m http.server $PORT --directory "$ROOT" >"$LOG" 2>&1 &
SRV=$!
echo "  serving (pid $SRV, log $LOG)"

if [ "${1:-serve}" = "watch" ]; then
  echo "→ watch: regenerating control.html on source change (Ctrl-C to stop)"
  trap 'kill $SRV 2>/dev/null || true' EXIT
  # Regenerate when any dashboard source changes; browser refresh picks it up.
  while true; do
    find "$REPO"/demo/dashboard/build.ts "$REPO"/demo/*/SCREENPLAY.md -type f -newer "$ROOT/control.html" 2>/dev/null | grep -q . && { echo "  change → regen"; regen; }
    sleep 2
  done
fi
