# notion-react — X thread draft

A problem-first visual thread. One tweet per section. The section images are
**caption-less** (visual + headline only) — the tweet copy below carries the
words, so nothing is duplicated. Voice: plainspoken, concrete, one idea per beat.

Media files live in the review dir under `explainer-redesign/react/`.

---

**Tweet 1 — The problem** · media: `thread-1.png`

You want to change one heading on a Notion page from code. The only API you get
is `append` / `update` / `delete` against raw block ids.

So you either wipe and re-append every block each run — churn, flicker, O(blocks)
cost — or hand-roll a keyed diff, a cache, and a kill-switch yourself. To change
one line.

---

**Tweet 2 — See it work** · media: `section-2-jsx-diff.gif` (animated; still fallback: `thread-2.png`)

Write the page as JSX instead: `<Page><Heading1/>…`.

Change one line, rerun `bun run page.tsx`, and the reconciler diffs your tree
against the last sync — `{ updates: 1 }`. One block updates in place; every other
block keeps its Notion id. Not a rebuild. The exact minimum.

---

**Tweet 3 — The shift** · media: `thread-3.png`

The real unlock: you describe the page, it computes the minimal block ops.

Hand it a tree; it reconciles against the last sync and returns a `SyncResult` —
the exact `appends` / `updates` / `removes` it applied. Identical JSX is a 0-op
no-op. Stop diffing block ids by hand.

…and identity survives restarts — the diff is keyed, not positional.

---

**Tweet 4 — …and here's how identity survives** (the depth, for anyone still reading) · media: `thread-4.png`

"How does it know which block is which across runs?"

Every block carries a `blockKey`. Each render matches a previously-synced Notion
block through a persisted `FsCache` (`.notion-cache.json`) — so a match reuses
the real block id, and identity holds across process restarts. add→create,
remove→archive, change→update.

(Block ops ship today; page-level `pages.move` is the designed contract, next up.)

---

## Notes for posting

- Tweets 1–3 are the core thread — a clean, scroll-stopping arc. Tweet 4 is an
  optional "going deeper" coda; drop it for the tighter 3-beat version.
- **Tweet 2 is the hero** — lead with the GIF (`section-2-jsx-diff.gif`): edit
  `<Heading1>Draft</Heading1>` → `Final`, rerun, and only that one rendered block
  updates in the Notion page while the toggle and to-do stay put; the run bar
  prints `updates: 1`. If a venue can't take a GIF, use the still `thread-2.png`.
- Section images are 2:1 landscape (X-safe), rendered at 2× (2000px wide). Dark
  variants exist too (`dark-section-N.png`).
- The two recognizable surfaces are the point: a JSX code editor (tab, line
  numbers, run bar) on the left, a rendered Notion page (🚀 title, bold heading,
  ▸ toggle, ☐ to-do) on the right.
- **Accuracy note (flagged for the critic):** the thread anchors on block-level
  ops — `updates` / `appends` / `removes` — which ship today. Page-level ops
  (`pages.create` / `pages.update` / `pages.move`) are the designed contract but
  not yet emitted in production, so the coda marks `pages.move` as CONTRACT rather
  than claiming it as live behavior. There is also no dedicated CLI: you run an
  Effect program with `bun run page.tsx` that calls `sync(<Page/>, { pageId, cache })`
  and prints the returned `SyncResult` — so `updates: 1` is a field of that result,
  shown here as the run-bar output.
- The "identity survives restarts — keyed, not positional" promise is baked into
  §3 of the live embed as a badge, and carried in Tweets 3–4 here.
