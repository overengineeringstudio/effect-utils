# Demo E2E harness

Drives a Notion-tooling demo end-to-end so we can **prove and dial-in** each demo
before it's driven manually on camera — and produce a storyboard we can align
assertions against.

Per run it: runs the real CLI in a **PTY**, performs the presenter's edits,
asserts outcomes via the **Notion API** (authoritative), captures **evidence
screenshots** + a **seconds-level timeline**, and writes a self-contained
`report.html`.

The harness core lives here and is reusable across demos. Each demo is a typed
spec (`demo/<name>/e2e.spec.ts`) — wiring a new demo = writing its spec.

## Run it

Run **inside `devenv shell`** — that puts the real umbrella `notion` binary
(notion-cli, on the devenv profile), plus `ntn`, `pty`, `playwright-cli` and
`NOTION_API_TOKEN`, on PATH. The pty inherits that PATH, so it drives exactly the
`notion md …` the presenter types on camera.

```sh
export DEMO_PARENT_PAGE=396e3d41f4a380a98491e1c96f6b5c43   # shared Recording page

# CORE demo — two-way propagation (3 beats, the ~3-min storyboard):
devenv shell -- bun demo/md/e2e.spec.ts              # reset (fresh pages) + full run
devenv shell -- bun demo/md/e2e.spec.ts --no-reset   # reuse the current live pages

# APPENDIX — guarded-merge proof (conflict/never-clobbers; explainer deep-dive,
# NOT part of the core storyboard). Separate evidence + report (id md-merge-proof):
devenv shell -- bun demo/md/e2e.merge-proof.spec.ts
```

Output lands in `demo/md/evidence/<timestamp>/` (gitignored):

- `report.html` — themed, self-contained (screenshots inlined) — **review this**
- `timeline.json` — per-beat id, narration, action, assertions, actual-vs-budget
- `terminal-<beat>.png` — the real watch-daemon terminal output
- `notion-<beat>-<role>.png` — the live Notion page (only after login; see below)

Each run also **auto-publishes** the report under the explainers devnet root
(`demo/explainers/<demo>-evidence/`, gitignored), so it's reachable over the
tailnet at e.g. `https://mbp2025.tail8108.ts.net:8443/md-evidence/report.html`.

## One-time browser login (for Notion screenshots)

Notion assertions use the API and need no browser. **Screenshots** of the live
pages need a logged-in browser session. The agent can't log in (SSO), so a human
does it once:

```sh
bun demo/harness/login.ts
```

This opens a **headful** browser at Notion login. Log in, wait for your workspace
to load, then press Enter — the session is saved to
`demo/harness/.auth/storageState.json` (**gitignored — it's a credential**).
Every subsequent run reuses it. Re-run if the session expires. Without it, runs
still execute the full PTY + API path and produce the report; the Notion panes
show a "run login first" placeholder.

## Layout

```
demo/harness/
  spec.ts          # typed Demo / Beat / Action / expectation types (the contract)
  runner.ts        # the reusable orchestrator (reset → PTY → beats → evidence)
  pty-driver.ts    # drives a real PTY shell via the `pty` CLI
  notion-api.ts    # `ntn api` helpers + assertion builders (todoChecked, …)
  screenshot.ts    # `playwright-cli` evidence: terminal render + Notion capture
  report.ts        # timeline.json + self-contained report.html
  login.ts         # one-time headful login → storageState
  .auth/           # storageState (gitignored)
demo/md/e2e.spec.ts  # the md demo storyboard (imports the harness)
```

## How it works / design

- **Source of truth = the typed spec.** Beats are structured objects
  (`{ id, narration, action, expectTerminal?, expectNotion?, expectFile?,
  screenshot?, budgetSec }`). `action` is `pty` | `pty-signal` | `edit` (local
  file) | `notion` (remote edit via API) | `wait`.
- **Assertions are hybrid but API-authoritative.** `expectNotion` runs against
  the live Notion API (via `ntn api`). `expectTerminal` (watch-log substring)
  and `expectFile` (local file) are secondary evidence. Playwright is **never**
  used for assertions — only screenshots.
- **CLI orchestration, no native addons.** The harness shells out to `pty`,
  `ntn`, `playwright-cli`, and `bash reset.sh` — so it runs under plain `bun`
  with nothing to compile. (node-pty needs a devenv-shell native symlink + a
  declared dep; the `pty` CLI works as-is.)
- **PTY driving.** The watch daemon runs in a real PTY; its stdout is tee'd to a
  `watch.log` so outcome tokens (`shared-merged`, `pulled`, `shared-conflict`)
  are parsed unwrapped and scroll-safe, while the PTY screen feeds the terminal
  screenshot.
- **Isolated working copy.** Each run copies the freshly-bound stage into
  `evidence/<ts>/work/` and drives the watcher there — both point at the same
  fresh pages, but only this copy is edited locally, so any *other* watcher on
  the shared `demo/md/stage` can only passively pull and never clobber our
  pushes. Runs are deterministic regardless of what else touches the stage.
- **Soft budgets.** Each beat polls its expectations until they pass (or a hard
  ceiling); `budgetSec` is soft — over-budget warns, never fails. Actual
  durations are recorded, which is what lets us break the demo into a
  seconds-level sequence.
- **Reset.** By default the run calls `demo/md/reset.sh` first for a clean slate
  (trashes prior pages, creates two fresh ones under `$DEMO_PARENT_PAGE`, binds
  sources, verifies `in-sync`). Use `--no-reset` to reuse the current pages.

## "Edited in Notion" beats

Beats 2 and 3b represent the presenter editing the page **in the browser**. The
harness reproduces the same mutation through the Notion API (`ntn api PATCH …`)
so runs are deterministic. On camera these are a human typing in Notion.

## Stray watcher on the machine

If another `notion md … --watch` is already running on this host (a leftover from
manual demo prep), it can't corrupt a run: each run drives an **isolated working
copy** of the stage bound to the same fresh pages, and only that copy is edited
locally — so any other watcher on `demo/md/stage` can only passively pull.

## Public-repo safety

No tokens, no `storageState`, no evidence are committed (all gitignored). Seed
content is synthetic.
