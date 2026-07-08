#!/usr/bin/env bash
# dev.sh — THE command to run the demo control dashboard.
#
# Serves the unified control dashboard (Vite + React 19 + Tailwind v4) as a live
# DEV server with native HMR, at a CLEAN tailnet URL (no filename). This is the
# SOLE control surface: all five explainers render INLINE as React components
# (dashboard/explainers/src) — there is no static HTML / SSG / singlefile path.
#
#   demo/dashboard/app/dev.sh          # start vite dev on :5174 + tailscale :8445
#   bun run dev                        # plain vite dev (no tailnet), same port
#
# The clean URL the user opens is the Vite dev ROOT:
#   :5174 → tailnet :8445 → https://mbp2025.tail8108.ts.net:8445/
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_PORT="${DEMO_DASHBOARD_DEV_PORT:-5174}"
TAILNET_HOST="${DEMO_DASHBOARD_TAILNET_HOST:-mbp2025.tail8108.ts.net}"
TAILNET_PORT="${DEMO_DASHBOARD_TAILNET_PORT:-8445}"

# Idempotent: free the dev port if a previous run is still holding it.
lsof -tiTCP:"$DEV_PORT" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true

# Standing tailscale serve: TLS on :TAILNET_PORT → plaintext 127.0.0.1:DEV_PORT.
# Idempotent (re-running just re-asserts the same mapping). AGENT_POLICY_BYPASS=1
# per the tailscale-serve wrapper convention if the wrapper requires it.
echo "→ tailscale serve --https=$TAILNET_PORT → http://127.0.0.1:$DEV_PORT"
AGENT_POLICY_BYPASS=1 tailscale serve --bg --https="$TAILNET_PORT" "http://127.0.0.1:$DEV_PORT" \
  || echo "warn: tailscale serve failed (is the tailnet up?)"

echo "→ vite dev on http://127.0.0.1:$DEV_PORT"
echo "  clean tailnet URL (no .html): https://$TAILNET_HOST:$TAILNET_PORT/"

cd "$HERE"
exec node_modules/.bin/vite --port "$DEV_PORT" --strictPort
