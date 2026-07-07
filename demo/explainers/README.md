# Demo Explainers — Source of Truth (Ledger)

Audience-facing explainers + the live control dashboard for the Notion-tooling
demo. This README is the **ledger**: what's canonical, what's archived, what's
generated. Update the table when you supersede or regenerate something.

## Canonical workflow (concise)

1. **Canonical explainer = `notion-<tool>.html`** (root, served via tailnet, iframed
   by the dashboard). **The local HTML is the source of truth. The Notion explainer
   pages are superseded** — no longer maintained or embedded to.
2. **To redesign:** move the current file to `_archive/notion-<tool>.v<N>.html`,
   write the new `notion-<tool>.html`, update the ledger row. (No Notion re-embed —
   the served local HTML is canonical.)
3. **Dashboard** (`control.html`) is **generated** — edit `demo/dashboard/build.ts`
   then `bun demo/dashboard/build.ts`. Never hand-edit `control.html`.
4. **Backups/evidence** (`<demo>-evidence/`) are **generated** — run
   `demo/<demo>/e2e.spec.ts` in `devenv shell`; it auto-publishes the report.

## Layout

| Path | What | Edit? |
|------|------|-------|
| `notion-<tool>.html`, `overview.html` | **Canonical** explainers (served + embedded) | yes |
| `notion-<tool>.thread.md` | Canonical X-thread copy | yes |
| `mmd/<tool>.mmd` | Mermaid diagram sources | yes |
| `_archive/*.v<N>.html` | **Superseded** explainers — reference only, used nowhere | no |
| `control.html` | **Generated** live dashboard (from `demo/dashboard/build.ts`) | no — edit generator |
| `<demo>-evidence/` | **Generated** harness evidence (gitignored) | no |
| `vista-review.html` | **Generated** session review | no |
| `embed.sh` | **Deprecated** — Notion pages superseded; kept for reference | no |

## Ledger — current status

| Tool | Canonical | Format | Notion page | Thread copy |
|------|-----------|--------|-------------|-------------|
| notion md | `notion-md.html` | visual thread (native-media refine) | [page](https://www.notion.so/396e3d41f4a3814284b2ed2891557e8d) | `notion-md.thread.md` |
| notion sqlite | `notion-sqlite.html` | visual thread (native-media refine) | [page](https://www.notion.so/396e3d41f4a381e1b2a4d5f91dd6f72e) | `notion-sqlite.thread.md` |
| notion schema | `notion-schema.html` | visual thread (native-media refine) | [page](https://www.notion.so/396e3d41f4a38108b681c228ad74de33) | `notion-schema.thread.md` |
| notion-react | `notion-react.html` | visual thread (native-media refine) | [page](https://www.notion.so/396e3d41f4a38133b91cf0cecafb2936) | `notion-react.thread.md` |
| overview | `overview.html` | visual thread (native-media refine) | [page](https://www.notion.so/396e3d41f4a3818c8493f82e0b689daa) | `overview.thread.md` |

Superseded originals for all five live in `_archive/` (`*.v1.html`). The **Notion
explainer pages** linked above are **superseded/archived** — reference only; the
served local HTML is the source of truth.

**Live URLs** (tailnet-only): `https://mbp2025.tail8108.ts.net:8443/<file>.html`
— explainers, `control.html` (dashboard), `vista-review.html`.

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

**Deliverables per tool**: `notion-<tool>.html` (canonical, self-contained,
theme-aware) · `notion-<tool>.thread.md` (X copy — Tweet 1 opens on felt pain,
de-duplicated from the images) · caption-less thread images (2:1) · a hero GIF
where motion carries the point.

**Workflow**:
1. Bump the current file to `_archive/notion-<tool>.v<N>.html`, then edit
   `notion-<tool>.html`. `notion-md.html` is the template (structure/CSS/voice);
   Geoffrey Litt's X threads are the voice reference.
2. Serve: `demo/serve.sh`, open `http://127.0.0.1:52606/notion-<tool>.html`.
3. Screenshot each section (light + dark) with `playwright-cli` (`open` → `goto`
   → `screenshot --filename`) into a scratch dir.
4. GIFs: capture *stepped* element screenshots of the animated section, assemble
   with `ffmpeg` (loop; add an end-hold/fade so the loop seam never reads as a
   wipe). `playwright-cli` video is too blurry for text — use stepped stills.
5. **Run an adversarial critic** (a sub-agent) over the set, apply the fixes,
   re-screenshot. This is required before "done".
6. Update this ledger row, commit + push.

The dashboard iframes `notion-<tool>.html` directly, so edits show on refresh
(`demo/serve.sh` watches + regenerates the dashboard). No re-embed step.
