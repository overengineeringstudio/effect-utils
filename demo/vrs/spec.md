# Spec — Notion Tooling Demo

How the requirements are met. Kept current with the implementation.

## Structure & pacing

- **Five demos** (the schema demo split into **codegen** + **IaC**), in order:
  **notion md (1) → notion sqlite (2) → notion schema · codegen (3.1) → notion
  schema · IaC (3.2) → notion-react (4)**. (~3-min each, punchy; the harness holds
  each to a ~3-min soft budget.)
- **Per-tool rhythm:** brief framing (~30s, the gap) → live demo (the wow) →
  deeper dive (the explainer visual: how it works / what first-class would look
  like). Show first, explain after.
- **Video open:** brief thesis (the platform gaps) → straight into the md demo.
- **Conflicts/merging are out of the demos** (they'd slow the ~3-min arc) — the
  demos show the happy path; the safety/merge story lives in the explainer
  deep-dive (and is proven separately by a harness merge-proof run).

## Driving model

- On camera the presenter drives the **real CLIs** inside `devenv shell` (which
  provides `notion` + `NOTION_API_TOKEN` from 1Password via secretspec).
- The **live control dashboard** is the primary driver, shown beside the terminal +
  Notion browser. Rebuilt as a self-contained **Vite + React + Tailwind** app
  (`demo/dashboard/app/`) that parses the SCREENPLAY.md files into a typed model at
  build time and emits a single zero-external-request, atomically-swapped
  `demo/explainers/control.next.html` (via `vite-plugin-singlefile`). Tabs per demo —
  **sub-numbered 3.1/3.2** for the schema split; layers = **instructions** (SAY +
  **one-command-per-copy** boxes + what-to-see) · **explanation** (in-page explainer,
  **single-scroll**, no nested scroll) · **evidence** (backup screenshots, lightbox) ·
  **status** (per-beat pass/fail; **mock/illustrative** for the planned 3.2). Compact
  one-band demo header. UI state is URL-encoded (`#demo=…&view=…`), reload-safe.
- **Intro tab (first, default-active on load).** Ahead of the per-demo tabs sits
  a static presenter-facing **why/how deck** for screen-sharing — not a demo, so
  it has none of the per-demo layers (no beats / explanation / evidence /
  status). Two slides:
  - **Why — *Notion, for users, developers, and agents.*** Notion is the shared
    source of truth that distinct actors act on: knowledge-work actors (users,
    productivity agents) and engineering actors (developers, coding agents), with
    **automations & integrations** bridging Notion to external systems. (Distinct
    from the video's opening platform-gap thesis — this frames the ecosystem, not
    the arc.)
  - **How — the four core building blocks as composable pieces:** notion md,
    notion sqlite, notion schema (codegen today, IaC planned — one block here),
    notion-react. Schema is a single block; the per-demo tabs split it 3.1/3.2
    for pacing.
- **Cutover pending:** the legacy string-template generator (`demo/dashboard/build.ts`
  → `control.html`) is frozen as a fallback until `control.next.html` is promoted to
  the canonical `control.html` and `serve.sh` is wired to the React build.

## Demo environment (R1)

- A `demo-env` CLI (`demo/env/`) provisions a **fresh, self-contained** Notion
  env on demand under a "🧪 Demo Envs" container page.
- One command preps a take: `eval "$(demo-env new --export)"` — creates the env
  (md pages, sqlite DB, 2 schema DBs, react page), **sets `DEMO_*` env vars** in
  the shell, and **prints the browser links**. `demo-env list|rm|gc`; the harness
  auto-`rm`s its envs, live envs are kept until removed.
- Intended to replace the per-demo `reset.sh`; the rewiring of the screenplays /
  dashboard / harness onto `$DEMO_*` (killing the hardcoded `demo/<tool>/stage`
  paths) is **pending**. Isolation → safe parallel harness runs.

## E2E harness (R5)

- `demo/harness/` — drives the real CLI in a PTY, asserts outcomes via the
  **Notion API** (source of truth), and captures **Playwright screenshots** as
  evidence (never asserts on the DOM). Browser auth = a one-time saved
  `storageState` (gitignored).
- Source of truth per demo = a typed `demo/<tool>/e2e.spec.ts` (beats: action /
  `expectTerminal` / `expectNotion` / `notionReady` DOM-settle signal for
  screenshots / soft budget). Runs auto-publish `report.html` + `timeline.json`
  to `demo/explainers/<demo>-evidence/` (served on the tailnet).
- Screenshots are captured **only after the Notion UI reflects the change**
  (never a stale frame), popups dismissed, cropped to page content.

## The demos

- **notion md** — `.nmd` two-way Markdown ⇄ Notion sync; `notion md sync
  --watch` → edit either side → it propagates. Takeaway: live two-way
  propagation. Guarded 3-way merge (never clobbers) is the explainer deep-dive,
  proven by `e2e.merge-proof.spec.ts`.
- **notion sqlite** — `notion db`: track a Notion DB into a local `.sqlite`, edit
  with plain SQL, `notion db sync` → the Notion cell updates; unsupported edits
  (formula/rollup, hard delete) fail closed with a typed error. (Two-way push
  needs `--mode shared`.)
- **notion schema · codegen (3.1)** — the Notion DB is the source of truth:
  `notion schema generate -o schema.gen.ts` → typed Effect schemas (literal-union
  options, autocomplete); `generate-config` for many DBs; `diff --exit-code` = a CI
  drift gate. Honest boundary: introspect → codegen → drift-*detection*.
- **notion schema · IaC (3.2)** — the honest inverse, **planned / not yet built**: a
  declarative schema file (`tasks.notiondb.ts`) is the source of truth →
  `notion schema apply` would create/reconcile the Notion DB to match it
  (Terraform-style `plan`/`apply` + a lock file). Recordable today only as a
  **narrated roadmap preview with mock backups** — loudly marked planned; commands
  shown, not run. Grounded in the real non-destructive alter plumbing
  (`AddProperty`/`RenameProperty`/`AddSelectOptions`) + the unused
  `NotionDatabases.create`; the declarative config → plan → apply front-end is the
  part that doesn't exist yet. (Content: `demo/schema-iac/`.)
- **notion-react** — write a page as JSX; `bun run page.tsx` → change one line,
  rerun → only the diff applies (`updates: 1`) via `blockKey` reconciliation.
  (Block-level ops are live; `pages.move` is a documented contract, not yet
  emitted.)

## Explainers (R6)

- Problem-first visual **threads**: 3 core beats (Problem → See-it → Insight) +
  optional deep-dive coda; each = headline + a **native-chrome** visual + a one-line
  caption that doubles as tweet copy. Each medium is wrapped in its real chrome via a
  shared, reusable frame kit: a **macOS window** base with per-medium variants — a
  **mini-IDE** (file tree + line numbers) for code/markdown, a **DB-browser** for the
  SQLite file, a **Notion surface** (sidebar + select-pill DB / rendered page), and a
  **Terminal**. The **See-it-work** beat is a **stepped, auto-advancing animation**
  (play/pause + step dots; `prefers-reduced-motion` → all steps static) showing the
  change propagate over time. The md explainer is organized by **source-of-truth
  mode** (**local / notion / shared**; `notion` is `remote` in code). Today the mode
  only **sub-tabs** the See-it-work beat; **intended (pending):** lift it to a
  **page-level** selector scoping the whole explainer — the problem beat stays
  mode-agnostic (the umbrella), the tab drives the concrete scene below (see *Explainer
  problem framing*). **Invariant:** Notion is always on the **right**, the local/other
  medium on the **left**; direction is shown by arrows, never by swapping sides.
- **Local HTML is the SoT** (`demo/explainers/notion-<tool>.html`); the Notion
  explainer pages are superseded. Caption-less thread images + a hero GIF per
  tool for X. Ledger: `demo/explainers/README.md`.

## Explainer problem framing (per building block)

The problem-first beat (R6) opens on the **durable why** the tool exists — not a
naive-approach failure mode. Captured here as it's aligned per building block; the
HTML/React component is the copy source of truth (this section is the intent behind
it). Populated so far for **notion md**.

### notion md

- **Root problem (umbrella, mode-agnostic):** a **medium mismatch**. Notion's API/UI
  is the right medium for humans reading/editing in a rich UI — but for other jobs a
  **file is the better medium** (agents, build pipelines, Git, `grep`). The bridge =
  use the right medium per job and keep both in sync. Deliberately **not** framed as
  "trapped behind an API" (imprisonment) or "you chose to duplicate a doc."
- **Three concrete lives = the source-of-truth modes.** The umbrella is stated once
  for everyone; the page-level SoT tab then picks the reader's world and drives the
  concrete scene below:
  - **local** (files → Notion mirror): an agent authors files / you publish repo docs
    into Notion. Your source lives in Git; Notion is a published mirror.
  - **notion** (Notion → files, derived): a blog build imports Notion; backup /
    `git log` your pages. Notion content that can't otherwise feed a pipeline or be
    versioned.
  - **shared** (two-way, guarded): human in Notion + agent in files, live.
- **Lead scene — agents (highest novelty):** *files are the ideal read/write API.* An
  agent's toolchain already speaks files (`Edit` / `grep` / `git diff`) and a local
  file is always current — versus reverse-engineering the block API and refetching to
  guess remote state. The file **is** the API, and the best one.
- **Clobber/drift is demoted** out of the problem beat to a **solution property**: two
  live mediums ⇒ conflicts are possible ⇒ the guarded 3-way merge is why you can trust
  it. It lives in the deep-dive coda (Beat 04) and earns its keep in **shared** mode —
  it is *not* the reason to care in the first place.
- **What native would look like:** Notion natively exposes any page/DB as a
  **file-shaped, versionable, agent-editable surface** — *mount your workspace as
  files*, first-class, not an export.

## Source-of-truth map

| Thing | SoT |
|-------|-----|
| VRS | `demo/vrs/` (this) — the Notion VRS page is a superseded pointer |
| Explainers | `demo/explainers/notion-<tool>.html` (local HTML) |
| Screenplays | `demo/<tool>/SCREENPLAY.md` → the control dashboard |
| Evidence/backups | `demo/<tool>/evidence/` (generated) |
| Harness storyboard | `demo/<tool>/e2e.spec.ts` |
| Demo env provisioning | `demo/env/` (`demo-env`) |

## Durable fixes → prod (R7)

- PR **#894** — `notion schema generate -o` option collision.
- PR **#898** — `notion db sync/track/export` under packaged Node (.tsx defect +
  flake `track` routing).
- Issues **#895** (generate-config config resolution), **#896** (schema diff
  coverage), **#897** (notion md watch/shared pull), **#899** (`notion db
  sync/track` fail on the *deployed* packaged binary). Notion/`ntn`-side issues
  on the Notion "bug reports" page.

## Running it

- **`demo/RUNBOOK.md`** is the operational handoff: `demo/serve.sh` (watch-default
  static serve on :52606 + the standing `tailscale serve --https=8443`),
  `eval "$(demo-env new --export)"`, the harness login, the SoT map, gotchas.
- The live control is **generated — never hand-edit the HTML**. Current build:
  `cd demo/dashboard/app && bun run build` → `control.next.html` (the React app).
  The legacy `demo/dashboard/build.ts` → `control.html` remains a frozen fallback
  until cutover; both are served side by side on the tailnet.

## Status & known issues

- **Live-control rebuild + schema split — done (cutover pending).** The dashboard is
  rebuilt as a Vite/React/Tailwind singlefile app (`demo/dashboard/app/` →
  `control.next.html`); the schema demo is split into **3.1 codegen** (real) + **3.2
  IaC** (planned roadmap, mock backups). Per-command copy, compact header, and
  single-scroll explainers are in. All five explainers are wrapped in native chrome
  with stepped See-it-work animations, Notion-always-right. Remaining: **cutover**
  (promote `control.next.html` → `control.html`, retire `build.ts`, wire `serve.sh`),
  optionally extend native chrome to the Problem/Insight beats, and (flagged) sqlite
  explainer Beat 1's Notion-left-of-wishlist layout.
- **Demo proof coverage: all four proven** (3.2 IaC is the mock/not-harnessed 5th) — notion md ✅ (3/3 core + merge-proof),
  **sqlite ✅ (3/3, real "Done" cell)**, schema ✅ (5/5), react ✅ (4/4). The sqlite
  `notion db sync` failure (#899) was a **stale devenv profile** (predating PR
  #898's fix) — resolved by rebuilding the profile; the binary now routes `track`
  and catches the `.tsx` import defect. Follow-up #900 (track appends to an
  existing manifest).
- **demo-env rewiring pending** — screenplays/dashboard/harness still use the old
  `demo/<tool>/stage` paths, not `$DEMO_*`. Decided shape: **explicit `$DEMO_*`
  env vars** — backstage `eval "$(demo-env new --export)"`, on camera
  `cd "$DEMO_<TOOL>_DIR"` + `$DEMO_*` ids. Requires the provisioner to expose a
  `DEMO_<TOOL>_DIR` per demo (copy committed stage + state) for a uniform `cd`.

## Live-run risks

- **Notion 429 rate limits** — space out API-heavy commands; pause between takes.
- md pull beat has autosave/read-after-write lag (~poll interval) — pace it.
- The guarded-merge story (explainer) requires same-line edits both sides.

## Setup checklist (pre-record)

- [ ] `eval "$(demo-env new --export)"` → fresh env + links + env vars.
- [ ] Playwright `storageState` present (one-time `demo/harness/login.ts`) — done.
- [ ] `devenv shell` `notion` is the fixed build (has the `-o` fix).
- [ ] Dashboard open as the driver; terminal + Notion browser side by side.
- [ ] Rotate the Notion integration token (surfaced in an agent transcript).
