# Demo Explainers — Source of Truth (Ledger)

Audience-facing explainers + the live control dashboard for the Notion-tooling
demo. This README is the **ledger**: what's canonical, what's archived, what's
generated. Update the table when you supersede or regenerate something.

## Canonical workflow (concise)

1. **Canonical explainer = `notion-<tool>.html`** (root). This is the only live
   version — the dashboard iframes it and the Notion page embeds it.
2. **To redesign:** move the current file to `_archive/notion-<tool>.v<N>.html`,
   write the new `notion-<tool>.html`, update the ledger row, and if it's
   embedded in Notion re-run `embed.sh notion-<tool>.html <page-id>`.
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
| `embed.sh` | Helper: upload a `<tool>.html` → Notion HTML block | — |

## Ledger — current status

| Tool | Canonical | Format | Notion page | Thread copy |
|------|-----------|--------|-------------|-------------|
| notion md | `notion-md.html` | visual thread (native-media refine) | [page](https://www.notion.so/396e3d41f4a3814284b2ed2891557e8d) | `notion-md.thread.md` |
| notion sqlite | `notion-sqlite.html` | visual thread (native-media refine) | [page](https://www.notion.so/396e3d41f4a381e1b2a4d5f91dd6f72e) | `notion-sqlite.thread.md` |
| notion schema | `notion-schema.html` | visual thread (native-media refine) | [page](https://www.notion.so/396e3d41f4a38108b681c228ad74de33) | `notion-schema.thread.md` |
| notion-react | `notion-react.html` | visual thread (native-media refine) | [page](https://www.notion.so/396e3d41f4a38133b91cf0cecafb2936) | `notion-react.thread.md` |
| overview | `overview.html` | visual thread (native-media refine) | [page](https://www.notion.so/396e3d41f4a3818c8493f82e0b689daa) | `overview.thread.md` |

Superseded originals for all five live in `_archive/` (`*.v1.html`).

**Live URLs** (tailnet-only): `https://mbp2025.tail8108.ts.net:8443/<file>.html`
— explainers, `control.html` (dashboard), `vista-review.html`.
