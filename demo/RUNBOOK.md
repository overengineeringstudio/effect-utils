# Demo Runbook — running the live control (restart-safe handoff)

Everything a fresh session/agent needs to run the demo. No hidden state.

## TL;DR — restart in a new session

```bash
cd <repo-root>
demo/serve.sh                       # regenerate dashboard + serve on :52606 (stable)
# open the control dashboard:
#   local:   http://127.0.0.1:52606/control.html
#   tailnet: https://mbp2025.tail8108.ts.net:8443/control.html   (your devices only)

devenv shell                        # gives `notion` + NOTION_API_TOKEN (from 1Password)
eval "$(demo/env/demo-env new --export)"   # fresh isolated demo env: DEMO_* vars + browser links
```

Harness screenshots need a one-time browser login (below). To drive a demo, open
the dashboard tab, follow its instructions (copy-paste commands), with the env's
Notion pages open in the browser.

## Serving (why there's no real "deploy")

- The dashboard `demo/explainers/control.html` is **generated** by
  `demo/dashboard/build.ts` (from the four `SCREENPLAY.md` + md `timeline.json`).
  It iframes the explainers (`notion-*.html`) and references evidence
  (`<demo>-evidence/`). "Deploy" = just **regenerate + serve static files** — no
  build pipeline, no upload.
- Served statically from `demo/explainers/` on **fixed port 52606**.
  `demo/serve.sh` (re)starts it idempotently (frees the port first).
- Cross-machine: `tailscale serve --https=8443 → 127.0.0.1:52606` — a **standing
  config that persists across sessions** (tailnet-only). Only re-run if reset:
  `AGENT_POLICY_BYPASS=1 tailscale serve --bg --https=8443 http://127.0.0.1:52606`.
- **Iterate with HMR:** `demo/serve.sh watch` (regen on source change) or
  `demo/serve.sh hmr` (live-reload the browser). Use plain `demo/serve.sh` for
  recording (no surprise reloads).

> Note: this session currently serves 52606 via a **devnet** caddy (equivalent —
> the port happens to match). `demo/serve.sh` replaces that with a plain
> fixed-port server; don't run both on 52606 at once.

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
| Explainers (canonical) | `demo/explainers/notion-<tool>.html` (ledger: `demo/explainers/README.md`) |
| Dashboard | GENERATED `demo/explainers/control.html` ← `demo/dashboard/build.ts` (never hand-edit) |
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

- One server on :52606 only (`serve.sh` frees it first).
- `control.html` is generated — edit `build.ts`, not the file.
- Never commit `storageState`, evidence, or `.demo-envs/` (all gitignored).
