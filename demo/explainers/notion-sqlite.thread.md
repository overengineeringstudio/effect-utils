# notion db (sqlite) — X thread draft

A problem-first visual thread. One tweet per section. The section images are
**caption-less** (visual + headline only) — the tweet copy below carries the
words, so nothing is duplicated. Voice: plainspoken, concrete, one idea per beat.

Media files live in the review dir under `explainer-redesign/sqlite/`.

---

**Tweet 1 — The problem** · media: `thread-1.png`

You've got 300 rows in a Notion database and need to flip Status on 40 of them.
In the web grid that's 40 clicks, one at a time.

You want to `SELECT`, run one bulk `UPDATE`, script it against a file. Notion
gives you a grid — or a REST API of untyped property JSON. No SQL. No file.

---

**Tweet 2 — See it work** · media: `section-2-sql-live.gif` (animated; still fallback: `thread-2.png`)

`notion db track` fixes that. It pulls the whole database into a local
`<db-id>.sqlite`.

Now edit the `rows` table with ordinary SQL —
`update rows set "Status"='Done' where _page_id='…'` — run `notion db sync`, and
the change lands on the real Notion row. Read-after-write verified before it
settles. (Two-way push needs `--mode shared` at track time.)

---

**Tweet 3 — The shift** · media: `thread-3.png`

The real unlock: your Notion database is now an ordinary SQLite file.

Every tool that speaks SQLite — the `sqlite3` CLI, your scripts, a GUI browser —
now edits your Notion data. `sync` keeps both sides in step, both ways. It
stopped being a walled grid.

…and it never corrupts your data — unsafe writes are refused, not dropped.

---

**Tweet 4 — …and here's how it fails closed** (the depth, for anyone still reading) · media: `thread-4.png`

"But what if I write something Notion can't take?"

Every write is checked before it touches Notion. A write to a formula/rollup
column, or a hard `DELETE`, is refused as a typed `GuardBlocked` event with a
named guard (`ComputedPropertyWrite`, `DeleteVsEdit`) — blocked until the
behavior is proven safe, never silently dropped. Writable cells sail through,
verified.

Your data is never lost. That's the whole point.

---

## Notes for posting

- Tweets 1–3 are the core thread — a clean, scroll-stopping arc. Tweet 4 is an
  optional "going deeper" coda; drop it for the tighter 3-beat version.
- **Tweet 2 is the hero** — lead with the GIF (`section-2-sql-live.gif`): a SQL
  `UPDATE` runs, `notion db sync` pulses, and the Notion Status pill flips from
  In Progress → Done live. If a venue can't take a GIF, use the still `thread-2.png`
  (the resolved Done state already reads as complete).
- Section images are 2:1 landscape (X-safe, uncropped in-timeline), rendered at
  2× (2000px wide) for crispness. Dark-mode variants exist too (`dark-section-N.png`).
- The two recognizable surfaces are the point: a real terminal/SQL surface on the
  left, a rendered Notion database grid (colored Status select pills) on the right.
- The "never corrupts your data — refused, not dropped" promise is baked into §3
  of the live embed as a badge, and carried in Tweets 3–4 here.
- The live HTML embed animates Tweet 2 in-page — link it as the final reply
  ("play with the live version: …") where embeds are supported (e.g. the Notion
  page itself).
