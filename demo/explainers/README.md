# Demo Explainers — Source of Truth (Ledger)

Audience-facing explainers for the Notion-tooling demo. This README is the
**ledger**: what's canonical, where the design source lives. Update the table
when you add or supersede an explainer.

## Canonical workflow (concise)

1. **Canonical explainer = a React component** in
   `demo/dashboard/explainers/src/<id>.tsx` (with self-scoped content CSS
   `<id>.css`). The five explainers render **INLINE** in the unified control
   dashboard (`demo/dashboard/app/`) — there are no standalone HTML files, no
   iframes, no generated `control.html`, and no SSG/singlefile build.
2. **Run / view** the explainers via the single serve: `demo/dashboard/app/dev.sh`
   → `https://mbp2025.tail8108.ts.net:8445/` (see `demo/RUNBOOK.md`). Open a demo
   tab and switch to its explanation view.
3. **Design source** (X-thread copy + mermaid diagrams) lives under
   `demo/explainers/_design/` — this is the authoring reference, NOT rendered by
   the app:
   - `_design/<tool>.thread.md` — the X-thread copy per explainer.
   - `_design/mmd/<tool>.mmd` — the mermaid diagram sources.
4. **Backups/evidence** (`<demo>-evidence/`) are **generated** — run
   `demo/<demo>/e2e.spec.ts` in `devenv shell`; it auto-publishes the report
   (surfaced in the dashboard's backup layer).

## Layout

| Path | What | Edit? |
|------|------|-------|
| `demo/dashboard/explainers/src/<id>.tsx` | **Canonical** explainer React component | yes |
| `demo/dashboard/explainers/src/<id>.css` | Per-explainer self-scoped content CSS | yes |
| `_design/<tool>.thread.md` | Canonical X-thread copy (authoring source) | yes |
| `_design/mmd/<tool>.mmd` | Mermaid diagram sources | yes |
| `<demo>-evidence/` | **Generated** harness evidence (gitignored) | no |

## Ledger — current status

`id` is the dashboard demo id; the component + CSS live at
`demo/dashboard/explainers/src/<component>`.

| Tool | Demo id | Component / CSS | Thread copy | Notion page (superseded) |
|------|---------|-----------------|-------------|--------------------------|
| notion md | `md` | `md.tsx` / `md.css` | `_design/notion-md.thread.md` | [page](https://www.notion.so/396e3d41f4a3814284b2ed2891557e8d) |
| notion sqlite | `sqlite` | `sqlite.tsx` / `sqlite.css` | `_design/notion-sqlite.thread.md` | [page](https://www.notion.so/396e3d41f4a381e1b2a4d5f91dd6f72e) |
| notion schema · 3.1 codegen | `schema` | `codegen.tsx` / `codegen.css` | `_design/notion-schema.thread.md` | — |
| notion schema · 3.2 IaC *(PLANNED / roadmap preview)* | `schema-iac` | `iac.tsx` / `iac.css` | `_design/notion-schema.thread.md` | — |
| notion-react | `react` | `react.tsx` / `react.css` | `_design/notion-react.thread.md` | [page](https://www.notion.so/396e3d41f4a38133b91cf0cecafb2936) |

The **Notion explainer pages** linked above are **superseded/archived** —
reference only; the React components are the source of truth. `_design/` also
keeps the intro `overview.thread.md` + `overview.mmd` (the intro deck now renders
the overview in-app).

**`notion schema` split (M6).** The schema story is split into two focused
explainers:

- **`codegen.tsx` (3.1, real/today)** — the shipped introspect → codegen →
  drift-detection story. Direction **DB → code**: the live Notion DB is the source
  of truth, `notion schema generate` / `generate-config` emit typed Effect
  schemas, `notion schema diff --exit-code` gates drift in CI.
- **`iac.tsx` (3.2, PLANNED / roadmap preview)** — the honest **inverse**,
  direction **code → DB**: a declarative `.notiondb.ts` file is the source of truth
  and a planned `notion schema plan` / `apply` provisions and reconciles Notion to
  match (additive-only; destructive fails closed; needs a proposed lock/state
  file). **This capability does not exist yet** — the component renders a
  loudly-labelled preview grounded in `demo/schema-iac/` (README + SCREENPLAY), not
  a demo of shipped behaviour. Not harnessed; no thread copy / Notion page.

## Working on explainers (for a fresh session)

**Format** — a problem-first VISUAL THREAD (also posts as an X thread):
- 3 core beats — ① Problem → ② See-it-work → ③ Insight — + an optional deep-dive
  coda (④). Each beat = a short headline (one **indigo** highlight word) + ONE
  self-contained visual + a one-line caption.
- **Native media**: each surface looks like the real tool — raw markdown / SQL /
  JSX / terminal on one side, *rendered* Notion blocks / DB grid on the other.
  The Notion side is NEVER raw markdown or JSON.
- One idea per beat; cut anything non-core. §1 must make a stranger feel the pain
  in ~3s without reading. Reserve red for danger/pain callouts only.
- **Accuracy**: cross-check the package `README`/`docs`. Confirmed-correct and
  must stay: `notion md` / `notion db` / `notion schema` (umbrella, with a space);
  sqlite guard tags `GuardBlocked` / `ComputedPropertyWrite` / `DeleteVsEdit`;
  two-way md needs `source: shared` + ~30s poll; two-way db needs `--mode shared`;
  schema is introspect→codegen→drift-*detection*, not provisioning; react block
  ops are live, `pages.move` is CONTRACT-only.

**Workflow**:
1. Edit the component `demo/dashboard/explainers/src/<id>.tsx` (+ its `<id>.css`).
   Register new explainers in `src/registry.tsx` (id → Component). The animation
   causal order is asserted by the vitest suite in `demo/dashboard/app/`.
2. View with `demo/dashboard/app/dev.sh` (native HMR): open the demo tab, switch
   to its explanation view — edits show live.
3. Screenshot each beat (light + dark) with `playwright-cli` (`open` → `goto` →
   `screenshot --filename`) into a scratch dir for the thread images.
4. GIFs: capture *stepped* element screenshots of the animated section, assemble
   with `ffmpeg` (loop; add an end-hold/fade so the loop seam never reads as a
   wipe). `playwright-cli` video is too blurry for text — use stepped stills.
5. **Run an adversarial critic** (a sub-agent) over the set, apply the fixes,
   re-screenshot. This is required before "done".
6. Update this ledger row + the `_design/` thread copy, commit + push.
