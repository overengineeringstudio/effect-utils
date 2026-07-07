#!/usr/bin/env bash
# Serve the live control dashboard. Watch is the default — it regenerates
# control.html when a source changes and is otherwise identical to a plain serve
# (idle = no changes = no reload), so it's safe for recording too.
#
#   demo/serve.sh          # serve on :52606 + regenerate on source change (default)
#   demo/serve.sh hmr      # + live-reload the browser on change (injects a client; for iterating)
#   demo/serve.sh stop     # stop the server
#
# Fixed port 52606 so the standing `tailscale serve --https=8443 -> 127.0.0.1:52606`
# always lines up. Idempotent: frees the port first. Leave the terminal open (or
# background the whole script) to keep serving.
set -euo pipefail

PORT=52606
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ROOT="$HERE/explainers"
LOG=/tmp/demo-serve.log

regen() { ( cd "$REPO" && bun demo/dashboard/build.ts ) || echo "warn: dashboard build failed (control.html not refreshed)"; }
free_port() { lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true; }

case "${1:-watch}" in
  stop) free_port; echo "stopped server on :$PORT"; exit 0 ;;
  watch|hmr) : ;;
  *) echo "usage: demo/serve.sh [watch|hmr|stop]"; exit 1 ;;
esac

regen
free_port

echo "→ serving $ROOT on http://127.0.0.1:$PORT"
echo "  control:  http://127.0.0.1:$PORT/control.html"
echo "  tailnet:  https://mbp2025.tail8108.ts.net:8443/control.html"
echo "  (tailnet down? re-establish the standing serve once:"
echo "     AGENT_POLICY_BYPASS=1 tailscale serve --bg --https=8443 http://127.0.0.1:$PORT )"

if [ "${1:-watch}" = "hmr" ]; then
  # Live-reload static server: auto-refreshes the browser on change (injects a
  # client — great for iterating, not for a clean recording page).
  exec bunx --bun live-server "$ROOT" --port=$PORT --no-browser
fi

# Default: plain static server + regenerate on change (browser refresh picks it up).
python3 -m http.server $PORT --directory "$ROOT" >"$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
echo "  serving (pid $SRV, log $LOG) + watching sources — Ctrl-C to stop"
while true; do
  if find "$REPO"/demo/dashboard/build.ts "$REPO"/demo/*/SCREENPLAY.md -type f -newer "$ROOT/control.html" 2>/dev/null | grep -q .; then
    echo "  change → regenerating control.html"; regen
  fi
  sleep 2
done
