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

## Visual design (control surface & kit)

The whole frame — the control chrome AND the mockup kit — reads as **one coherent
Notion, in Notion's app language**, so it never competes with the real Notion
browser filmed beside it. Direction: **app language + selective accents** (not the
marketing site's navy-AI hero treatment).

- **One shared token system.** A single warm palette + type scale is the source of
  truth for chrome, kit, and explainers (retires the former split between the cold
  `--color-*` chrome tokens and the `--bg/--panel/--accent` kit tokens). Light is
  the primary theme; dark reuses the kit's existing `#191919` family.
- **Palette (light):** page `#f7f6f3` (warm off-white), card `#ffffff`, ink
  `#37352f` (Notion's warm near-black), muted `#787774`, hairline `#e9e9e7`,
  accent **Notion blue `#2383e2`**, secondary tint `#e7f2fb`, pop/orange
  `#d9730d`, ok/green `#448361`. **Dark:** page `#191919`, card `#202020`, ink
  `#ebebeb`, border `#373737`, accent `#529cca`. The cold developer-dashboard grays
  (`#f6f7f9` / accent `#2f6bff`) are retired.
- **Type:** `Inter, -apple-system, system-ui` (Notion ships "NotionInter"; we
  approximate CSP-free with the system stack). Headlines are bold and tight
  (weight 700, line-height ~1.05); eyebrows are small, uppercase, letter-spaced,
  in the accent.
- **Flat by default (Notion-native).** The dashboard adds **no card boxes around
  content** — no nested `border`/`shadow`/`bg-panel` wrappers, no dashed group
  boxes. Structure is carried by whitespace, hairline rules, and bold headings.
  The **only** surfaces that keep real window chrome + a soft lift are the **faux
  app surfaces** (NotionPage, MacWindow, Terminal, MiniIDE, DbBrowser) — because
  those *are* the medium (R6). Everything else is flat on the warm canvas.
- **Chrome:** calm, recessive, app-native. Tab nav is **plain text** — no filled
  pills; the active tab reads via ink weight + a single accent underline, the
  keyboard index is a hair-thin gray glyph (not a boxed kbd), and the demo group
  hangs off a hairline. macOS traffic-dots on faux surfaces are desaturated so
  they recede.
- **Type & color discipline:** headlines big/bold/tight (700, tracking ~-.02em);
  eyebrows are **structural → muted gray**, never accent blue. Blue is reserved for
  links, buttons, and the active-tab underline only.
- **Selective signatures:** a small **set** (4–6) of bright Notion-style mascot
  chips — saturated circles carrying a **white line-icon of an object** (page,
  sync, `{}`, database), never a literal smiley — plus **one hand-drawn,
  monochrome line-art doodle** on the **intro/hero only**. Any mascot/line-art is
  an **original approximation**, never a copied Notion asset.
- **Kit fidelity (reinforces R6):** the shared surfaces (NotionPage, MacWindow,
  Terminal, MiniIDE, DbBrowser) target real-Notion-app fidelity on the shared
  tokens; verified in Storybook (`demo/dashboard/app/.storybook`).

## Driving model

- On camera the presenter drives the **real CLIs** inside `devenv shell` (which
  provides `notion` + `NOTION_API_TOKEN` from 1Password via secretspec).
- The **live control dashboard** is the primary driver, shown beside the terminal +
  Notion browser. A native **Vite + React + Tailwind** app (`demo/dashboard/app/`)
  that parses the SCREENPLAY.md files into a typed model and is served **live off the
  Vite dev server (HMR)** — no build step, no singlefile emit. The per-demo explainers
  render **inline as React components** (`demo/dashboard/explainers/src/*`, sharing the
  `demo/dashboard/kit/`), not iframes. Tabs per demo —
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
- **Single serve.** The legacy string-template generator, the singlefile/SSG build,
  the hand-authored explainer HTML, and the custom static `serve.sh` are all removed —
  the native Vite dev server (HMR) on the standing `tailscale serve --https=8445` is
  the one and only surface. Recording happens directly off it.

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

- Problem-first visual **threads**: core beats (Problem → How-it-works → What-it-enables) +
  optional deep-dive coda; each = headline + a **native-chrome** visual + a one-line
  caption that doubles as tweet copy. Each medium is wrapped in its real chrome via a
  shared, reusable frame kit: a **macOS window** base with per-medium variants — a
  **mini-IDE** (file tree + line numbers) for code/markdown, a **DB-browser** for the
  SQLite file, a **Notion surface** (sidebar + select-pill DB / rendered page), and a
  **Terminal**. The **how-it-works** beat is a **stepped, auto-advancing animation**
  (play/pause + step dots; `prefers-reduced-motion` → all steps static) showing the
  change propagate over time. In the md explainer, the how-it-works beat is **sub-tabbed
  by source-of-truth mode** (**local / notion / shared**; `notion` is `remote` in code);
  the problem beat is a **concrete** problem (not a mode-agnostic umbrella) and Beat 3
  (*What it enables*) is a **per-direction 3-card grid** (see *Explainer problem
  framing*). **Invariant:** Notion is always on the **right**, the local/other medium on
  the **left**; direction is shown by arrows, never by swapping sides.
- **Local HTML is the SoT** (`demo/explainers/notion-<tool>.html`); the Notion
  explainer pages are superseded. Caption-less thread images + a hero GIF per
  tool for X. Ledger: `demo/explainers/README.md`.

## Explainer problem framing (per building block)

The explainer opens **capability-first** — it leads with what the tool does, then
the beats carry a **problem → enablement** arc (R6). Voice is modeled on the Notion
dev product page (`notion.com/product/dev`): confident, concrete, peer-to-peer, and
**never dissing Notion** — the API/CLI are legitimate tools, a local file is simply
the easier medium for some jobs (vision.md forbids implying Notion is inadequate).
Captured here as it's aligned per building block; each explainer's React component +
its self-scoped CSS are the copy source of truth (this section is the intent behind
them).

**The shared four-beat pattern (all five demos):** *Lead (capability-first) →
Beat 01 **Problem** → Beat 02 **How it works** → Beat 03 **What it enables** →
Beat 04 **The toolkit** (coda)*. The **problem** beat pins a concrete gap with a
**contrast visual** — the shared `.ways` motif shows *the same task, two/three ways*,
the win row flagged: md/sqlite (file/SQL vs API/CLI), codegen (typed vs `any`), react
(declarative JSX vs imperative block API); iac is the planned analog (desired-state
file vs empty DB). **How it works** is the stepped, causally-gated sequence
(Notion-always-right). **What it enables** turns the capability into concrete scenarios.
**The toolkit** coda is a broad glyphed feature grid, not a round-trip deep-dive.
**Exception — notion schema · IaC (3.2)** is a **3-beat PLANNED arc** (gap → *see how it
would work* → *destructive fails closed* coda; no Beat 04) and stays loudly marked
not-yet-built. Documented per building block below.

### notion md

- **Lead (capability-first):** *2-way Markdown sync for Notion pages.* State what it
  is before any problem — the beats below then walk problem → enablement.
- **Beat 01 · The Problem** — headline (theme): *working with files is easier than the
  API/CLI in many cases*. Non-dissing: the API is right for building apps; the point is
  only that a file wins for ad-hoc, human/agent-scale work.
  - **Visual:** the **real Notion page** (reusing the production `NotionSurface` /
    `NotionPage` / `NotionBlock` kit, as the intro slides do) is the shared target on
    top. Below it, the **same one-line change** shown **three ways** against that page —
    via the **API** (scripting; verbose), via the **CLI** (ad-hoc; clunky), via a
    **local file** (`grep`/edit; trivial).
  - **The point:** you usually **start with only the Notion page** — the local file
    doesn't exist yet. Making that file trivial to read/edit **is** the motivation for
    the tool. Clobber/drift is **not** in this beat.
- **Beat 02 · How it works · pick the direction:** the how-it-works animation, sub-tabbed
  by **source-of-truth mode** (**local / notion / shared**; `notion` = `remote` in
  code). Invariant: Notion on the right, the file on the left; direction shown by arrows.
- **Beat 03 · What it enables** (was "The shift"): a **3-card grid**, one card per
  direction, each a real scenario:
  - **local** (file is SoT): keep agent skills & docs as Markdown in a repo and
    **mirror them into Notion**.
  - **notion** (Notion is SoT): **Notion as a CMS** — sync content down into a website
    build.
  - **shared** (two-way, guarded): live collaboration between a **local agent** (file as
    SoT) and a **user** (Notion UI as SoT), with a guarded merge.
- **Beat 04 · The toolkit** (coda): a **broad feature overview**, not a round-trip
  deep-dive — six glyphed cards (two-way sync, guarded merge, verified writes,
  git-friendly state, watch mode, self-describing files) with the block round-trip
  demoted to a **compact secondary fidelity strip** (Round-trips … / Edit in Notion …).
  Clobber/guarded-merge lives here as one card, not the focus. Content is grounded in a
  code-verified capability audit of `@overeng/notion-md` (R8: nothing overstated).
- **Component note:** reuses the **production Notion kit** components (shared with the
  intro slides); per-explainer styles live in the **self-scoped `md.css`**.

### notion sqlite

- **Lead (capability-first):** *`notion db` — edit your Notion database with plain SQL.*
  Pull the DB into a local `.sqlite`; `SELECT`, bulk `UPDATE`, script it — then sync
  back, guarded.
- **Beat 01 · The problem** — headline: *The same bulk edit: dozens of API calls — or
  one line of SQL.* `.ways` contrast, *mark 40 tasks done · three ways*: **API**
  (scripting; paginated query + one `update` per row), **CLI** (ad-hoc; per-row), **SQL**
  (a local file; ✓ one bulk `UPDATE` + one guarded `sync`). Non-dissing: a file is just
  the queryable/scriptable medium — plain SQL, the read/write API you already know.
- **Beat 02 · How it works** — headline: *Edit a row with SQL locally — the change lands
  live in Notion.* `notion db track` pulls the DB into `<db-id>.sqlite`; edit the `pages`
  table with ordinary SQL, `notion db sync` → the write lands on the real Notion row,
  read-after-write verified. Two-way push needs `--mode shared` at `track` time. Sequence:
  DbBrowser + terminal (left) → sync flow → Notion (right).
- **Beat 03 · What it enables** — headline: *Your Notion database is now an ordinary
  SQLite file.* Every tool that speaks SQLite — the `sqlite3` CLI, your scripts, a GUI —
  now edits your Notion data; `sync` keeps both sides in step, both ways. Promise line
  hands off to the coda: *…unsafe writes are refused, not dropped.*
- **Beat 04 · The toolkit** (coda) — broad glyphed feature grid (matching md); the
  guarded planner / fail-closed story (formula-write + hard-`DELETE` refused as a typed
  `GuardBlocked` — `ComputedPropertyWrite`, `DeleteVsEdit`) lives here as one card, not
  the focus.
- **Foot:** *first-class would be Notion exposing real transactional SQL over a typed DB;
  until then `notion db` is `sqlite3` + a sync that refuses to corrupt your data.*

### notion schema · codegen

- **Lead (capability-first):** *`notion schema` — your Notion databases, as typed code.*
  The DB is the source of truth: introspect → typed Effect schema → commit → CI goes red
  when Notion drifts. Direction header: **Notion DB → codegen → typed code**.
- **Beat 01 · The problem** — headline: *In your code, a Notion DB is `any` — until you
  generate its types.* `.ways` **two-way** contrast, *typed access · two ways*: **by hand**
  (untyped; `any`, a typo compiles then fails at runtime, no autocomplete, drifts) vs
  **generated** (typed; literal-union options, autocomplete, `tsc` catches typos, `diff
  --exit-code` CI gate).
- **Beat 02 · How it works** — headline: *One command reads the live database and writes
  a typed schema.* `notion schema generate` introspects the live DB → `schema.gen.ts`
  (every select → literal union); `notion schema diff --exit-code` fails the build on
  drift (exit 1). **The inversion:** this is a **READ** — Notion (right) is the pre-existing
  SoT and never changes; the generated code (left mini-IDE) is the gated effect; flow runs
  **right → left**.
- **Beat 03 · What it enables** — headline: *Your Notion databases become versioned, typed
  code.* Commit the schema → reviewed in PRs, type-checked end to end; `queryAll · get ·
  create · update` all typed; list DBs in `notion.config.ts`, `generate-config` regenerates
  them all. Promise line: *…honest about which way data flows — it reads Notion, never
  writes it.*
- **Beat 04 · The toolkit** (coda) — broad glyphed feature grid (matching md). The honest
  boundary (introspect → codegen → drift *detection*; the inverse **`notion schema apply`**
  provisioning is the separate, **planned** 3.2 capability) is carried as a card here.
- **Foot:** the **DB → code** direction; the honest **code → DB** inverse is planned
  (`notion schema apply`, 3.2 · roadmap).

### notion schema · IaC

- **Planned / not yet built (3.2).** The one explainer that ships as a **designed preview
  of an unbuilt front-end**. A **single sticky banner** ("Roadmap preview — Planned, not
  built yet; `plan`/`apply` do not exist; every command is narrated mock output") is the
  **sole** planned indicator — no per-beat pills, no ghosted grids; the provisioned Notion
  grid renders clean, the flow is a neutral accent (never green-verified — nothing here is
  a live write). Color convention: **amber = planned/preview, warn/red = destructive +
  blocked**. This is a **3-beat arc — no Beat 04**.
- **Lead (capability-first):** *`notion schema apply` — provision your Notion database from
  a file.* The honest inverse of codegen (3.1): declare the DB you *want* in a typed
  `.notiondb.ts`, reconcile Notion to match — additive and safe. Direction header:
  **.notiondb.ts file → plan → apply → Notion DB**.
- **Beat 01 · The gap** — headline: *A database's schema should be `code` — not clicks.*
  The planned analog of the `.ways` contrast: a **desired-state file** (`tasks.notiondb.ts`,
  `defineDatabase({…})`) → amber dashed *? no command · today you build the DB by hand* →
  an **empty parent page** (no Tasks DB). Codegen reads a DB into schemas; the inverse — a
  file that *defines* the DB and provisions it — doesn't exist yet, so every schema change
  is manual, unversioned UI clicking.
- **Beat 02 · See how it would work** — headline: *Declare it, plan it, apply it — a typed
  file provisions Notion, left → right.* Sequence: desired-state file + terminal (declare →
  `plan` prints the would-create diff, writing nothing → `apply` provisions, gated to the
  write packet → a destructive re-run **BLOCKED**) → provision flow → Notion empty →
  provisioned. A reconcile strip carries *re-run reconciles only the delta; unchanged file
  ⇒ no-op*. First `apply` writes a `tasks.notiondb.lock.json`. Promise line: *…it can never
  lose data — here's the boundary.*
- **Beat 03 · …and destructive fails closed** (coda) — headline: *It would only ever add.
  Anything that could lose data is refused.* Boundary split: **in scope · additive** (create
  DB if absent, add property [conservative type subset], rename with an explicit
  `renamedFrom` hint, append select options) vs **out of scope · fails closed** (remove
  property / change type → `DestructiveSchemaMigrationRequired`; remove select option →
  `OptionDeletionLosesValues`). **Credibility split:** the engine is **real today** — the
  sync layer already adds/renames properties, extends options, and refuses destructive
  changes (guard names are the actual ones in `notion-datasource-sync`); what's **planned**
  is the declarative `plan`/`apply` front-end, the diff planner, and the `lock.json` state
  model (a front-end doesn't get to weaken the guards).
- **Foot:** the shipped inverse is **3.1 codegen** (`generate` · DB → code); this page is
  the honest **code → DB** direction to be built on the same engine.

### notion react

- **Lead (capability-first):** *`notion-react` — write Notion pages as JSX.* Describe a
  page as a React tree; a reconciler diffs it against the last sync and emits only the block
  ops that changed — no rebuild, no hand-tracking block ids.
- **Beat 01 · The problem** — headline: *The same page: block-by-block API calls — or one
  JSX component.* `.ways` **two-way** contrast, *change one line · two ways to apply it*:
  **block API** (imperative; `blocks.delete`×N tear down + `blocks.append`×N rebuild, or
  hand-roll a keyed diff yourself) vs **a component** (declarative; ✓ `updates: 1`).
- **Beat 02 · How it works** — headline: *Write the page as a React component. Change one
  line, rerun — only that block updates.* `bun run page.tsx` reconciles against the last
  sync: first run `appends:5`, edit the `budget` const → `updates:1` (every other block
  keeps its Notion id), rerun unchanged → a genuine no-op (`0 0 0`); identity held by
  `blockKey`, not position. Sequence: mini-IDE + terminal → reconcile flow (green
  `✓ verified`, react-specific) → Notion rendered page.
- **Beat 03 · What it enables** — headline: *You describe the page. It computes the minimal
  block ops.* Hand it a tree; it reconciles vs the last sync and returns a `SyncResult` — the
  exact `appends` / `updates` / `removes`; identical JSX is a `0`-op no-op. Promise line:
  *…identity survives restarts — the diff is keyed, not positional.*
- **Beat 04 · The toolkit** (coda) — broad glyphed feature grid (matching md); the
  `blockKey → notion block id` map, the persisted `FsCache` (`.notion-cache.json`), the
  add→create / remove→archive / change→update diff outcomes, and the designed `pages.move`
  contract live here.
- **Foot:** *first-class would be Notion offering a declarative, diffable page API; until
  then `notion-react` is that reconciler — JSX in, minimum block ops out, keyed on
  `blockKey`.*

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

- **`demo/RUNBOOK.md`** is the operational handoff: `demo/dashboard/app/dev.sh`
  (starts Vite dev + the standing `tailscale serve --https=8445`),
  `eval "$(demo-env new --export)"`, the harness login, the SoT map, gotchas.
- The live control is the **native Vite/React app** at `demo/dashboard/app/` — edit
  the React source directly; HMR reflects it live. There is no build/generate step
  and no HTML to hand-edit.

## Status & known issues

- **Live-control rebuild + schema split — done.** The dashboard is a native
  Vite/React/Tailwind app (`demo/dashboard/app/`) served live off Vite dev; the legacy
  generator, singlefile/SSG build, hand-authored HTML, and custom `serve.sh` are all
  removed (single serve on `:8445`). The schema demo is split into **3.1 codegen**
  (real) + **3.2 IaC** (planned roadmap, mock backups). Per-command copy, compact
  header, and single-scroll explainers are in. All five explainers render **inline as
  React components** wrapped in native chrome with stepped how-it-works animations,
  Notion-always-right, official tech logos. The causal guarantee (effect never precedes
  cause) runs as a vitest (`cd demo/dashboard/app && bun run test`). Optional follow-up:
  extend native chrome to the Problem/Insight beats; (flagged) sqlite explainer Beat 1's
  Notion-left-of-wishlist layout.
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
