# Demo Runbook — running the live control (restart-safe handoff)

Everything a fresh session/agent needs to run the demo. No hidden state.

## TL;DR — restart in a new session

```bash
cd <repo-root>
demo/dashboard/app/dev.sh           # run THE control dashboard: Vite dev on :5174 + tailscale :8445
# open the control dashboard (clean URL, no filename):
#   local:   http://127.0.0.1:5174/
#   tailnet: https://mbp2025.tail8108.ts.net:8445/   (your devices only)

devenv shell                        # gives `notion` + NOTION_API_TOKEN (from 1Password)
eval "$(demo/env/demo-env new --export)"   # fresh isolated demo env: DEMO_* vars + browser links
```

Harness screenshots need a one-time browser login (below). To drive a demo, open
the dashboard tab, follow its instructions (copy-paste commands), with the env's
Notion pages open in the browser.

## Serving (why there's no real "deploy")

- The control dashboard is a **unified Vite + React 19 + Tailwind v4 app** at
  `demo/dashboard/app/`. It is the SOLE control surface: all five explainers
  render **inline** as React components (`demo/dashboard/explainers/src/`), the
  demo status/evidence come from the SCREENPLAY→model codegen
  (`scripts/gen-model.ts`), and nothing is iframed. There is no static-HTML / SSG
  / singlefile path anymore.
- Run it: `demo/dashboard/app/dev.sh` — starts `vite` dev on **fixed port 5174**
  (127.0.0.1, idempotent: frees the port first) with native React/Tailwind HMR.
  Native HMR is edit-safe while recording (idle = no reload).
- Cross-machine: the script asserts a standing
  `tailscale serve --https=8445 → 127.0.0.1:5174` (tailnet-only, persists across
  sessions). Only re-run if reset:
  `AGENT_POLICY_BYPASS=1 tailscale serve --bg --https=8445 http://127.0.0.1:5174`.
- The causal-order guarantee for the inline explainers is unit-tested via
  `cd demo/dashboard/app && bun run test` (vitest). Note: `demo/` is outside the
  pnpm workspace, so this is NOT yet wired into the main repo ship gate.

## Fresh demo env (the `reset.sh` replacement)

`eval "$(demo/env/demo-env new --export)"` — provisions a self-contained Notion
env under **🧪 Demo Envs** (md pages, sqlite DB, 2 schema DBs, react page), sets
`DEMO_*` vars, prints links. `demo/env/demo-env list | rm <id> | gc --older-than 2h`.
Each env is isolated → parallel-safe. (Screenplays/dashboard still reference the
old `demo/<tool>/stage` paths; rewiring them onto `$DEMO_*` is a pending step.)

## Harness (evidence / backups)

- One-time login (Playwright `storageState`, a **credential**, gitignored at
  `demo/harness/.auth/`): `bun demo/harness/login.ts` (log into Notion, Enter).
  Re-run if the session expires.
- Run a demo's proof: `devenv shell -- bun demo/<tool>/e2e.spec.ts` — asserts via
  the Notion API, screenshots via Playwright, auto-publishes
  `demo/explainers/<tool>-evidence/report.html` (shown in the dashboard's backup
  layer).

## Source-of-truth map (no ambiguity)

| Thing | Where |
|-------|-------|
| VRS | `demo/vrs/{vision,requirements,spec}.md` |
| Explainers (canonical) | React components `demo/dashboard/explainers/src/<id>.tsx` (+ `<id>.css`); ledger: `demo/explainers/README.md` |
| Dashboard | unified Vite app `demo/dashboard/app/` (run via `demo/dashboard/app/dev.sh`) — explainers render inline |
| Explainer design source | `demo/explainers/_design/` (X-thread copy `*.thread.md` + mermaid `mmd/*.mmd`) |
| Screenplays | `demo/<tool>/SCREENPLAY.md` |
| Harness storyboards | `demo/<tool>/e2e.spec.ts`; evidence `demo/<tool>/evidence/` |
| Demo env provisioner | `demo/env/` (`demo-env`) |
| Notion | hub "🎬 Notion Tooling Demo": 🧪 Demo Envs (live) + 🗄️ Archive (superseded) |

## Known issues / gotchas

- **`notion db sync/track`**: a deployed-binary runtime bug blocks the sqlite
  sync beat — under fix (issue #899, PR #898). sqlite demo is not fully runnable
  until resolved.
- **Notion 429** rate limits under heavy automation — space out calls.
- **Rotate the Notion integration token** (it surfaced in an agent transcript).
- `devenv` enterShell tasks (`pnpm:install`/`genie`) sometimes abort-trap in this
  env — non-fatal; `notion` still works.
- Durable fixes live in prod PRs (#894, #898) + issues (#895–899), not on this
  throwaway demo branch (backed up on the `assistant` fork).

## Don't-conflict rules

- One server on :5174 only (`demo/dashboard/app/dev.sh` frees it first).
- Explainers are React components in `demo/dashboard/explainers/src/` rendered
  inline by the app — edit those, not any generated HTML (there is none).
- Never commit `storageState`, evidence, or `.demo-envs/` (all gitignored).
