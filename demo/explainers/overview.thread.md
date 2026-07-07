# Notion dev platform — X thread intro / index

The opener for the series: problem-first, but at the platform level. It maps the
four tools as the four gaps they fill, then hands off to the per-tool threads.
Section images are **caption-less** (visual + headline only); the tweet copy
below carries the words.

Media files live alongside this doc in the review dir.

---

**Tweet 1 — The problem** · media: `overview-thread-1-walls.png`

Notion's developer platform is genuinely good — a REST API over pages/blocks/data
sources, the `ntn` CLI, in-workspace Workers.

But try to build something advanced on it and you slam into the same four walls:
no local Markdown sync, no tabular/SQL editing, no typed access, no declarative
page API.

---

**Tweet 2 — The map** · media: `overview-thread-2-map.png`

Four gaps, four small sharp tools — each fills one wall:

• `notion md` — local Markdown ⇄ Notion page, 3-way merge, never clobbers
• `notion db` — a Notion database as a local SQLite you edit with plain SQL
• `notion schema` — a Notion database → typed, versioned, drift-checked code
• `notion-react` — write pages as JSX, reconciled down to minimal block ops

Each one bridges a code surface and a rendered-Notion surface.

---

**Tweet 3 — The through-line** · media: `overview-thread-3-through-line.png`

The through-line: every one is a pragmatic stopgap for a first-class capability
Notion doesn't ship yet.

Together they make Notion feel like a real, versionable developer substrate —
until the day these go native and the stopgaps quietly retire.

Deep-dive threads on each one below ↓

---

## Notes for posting

- This is the **index tweet** of the series — keep it tight. Tweets 1–3 are the
  whole thing; there's no coda.
- **Tweet 2 is the hero** — the clean 2×2 map is the artifact people screenshot
  and save. Each tool card hints at its two real surfaces (code chip ⇄ rendered
  Notion chip) so the pairing is recognizable at a glance.
- Reply to Tweet 3 with links to the four per-tool threads (`notion md`,
  `notion db`, `notion schema`, `notion-react`).
- Section images are 2:1 landscape (X-safe) at 2×. Dark-mode variants exist
  (`overview-dark-section-N-*.png`).
- The "HTML block" demo is **not** part of this — don't reference it.
- Live embed: `overview.html` reads top-to-bottom as the full intro; link it
  where embeds are supported.
