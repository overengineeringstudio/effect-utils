# notion md — X thread draft

A problem-first visual thread. One tweet per section. The section images are
**caption-less** (visual + headline only) — the tweet copy below carries the
words, so nothing is duplicated. Voice: plainspoken, concrete, one idea per beat.

Media files live alongside this doc in the review dir.

---

**Tweet 1 — The problem** · media: `thread-1-problem.png`

I keep the same doc in my repo and in Notion. Keeping them in sync is a manual
copy-paste slog — and whoever pastes last silently wipes the other side's edits.

There's no first-class way to bind local Markdown to a Notion page. So they drift.

---

**Tweet 2 — See it work** · media: `section-2-live-sync.gif` (animated; still fallback: `thread-2-see-it-live.png`)

`notion md sync --watch` fixes that. Edit either side — it shows up on the other.

Type in your editor, it pushes to Notion instantly. Edit in Notion, it syncs
back to your file. Both directions, no button to press. (Notion→local rides a
short poll, ~30s; two-way needs `source: shared`.)

---

**Tweet 3 — The shift** · media: `thread-3-source-of-truth.png`

The real unlock: your repo becomes the source of truth.

Your `.nmd` files live in git — versioned, reviewable, yours. Notion turns into a
live, editable *view* of them. The copy-paste dance is just gone.

…and it never clobbers — your work is never lost.

---

**Tweet 4 — …and here's how it never clobbers** (the depth, for anyone still reading) · media: `thread-4-coda-never-clobbers.png`

"But what if I edit both sides at once?"

Every sync is a guarded 3-way merge against a content-addressed base in
`.notion-md/`. One side changed? It just applies. Both touched the same line? You
get a `*.conflict.roughdraft.md` holding both versions — never an overwrite.

Your work is never lost. That's the whole point.

---

## Notes for posting

- Tweets 1–3 are the core thread — a clean, scroll-stopping arc. Tweet 4 is an
  optional "going deeper" coda; drop it for the tighter 3-beat version.
- **Tweet 2 is the hero** — lead with the GIF (`section-2-live-sync.gif`, a
  looping two-way-propagation animation). If a venue can't take a GIF, use the
  still `thread-2-see-it-live.png` (both directions already read as complete).
- Section images are 2:1 landscape (X-safe, uncropped in-timeline) and rendered
  at 2× for crispness. Dark-mode variants exist too (`dark-section-N.png`).
- The "it never clobbers — your work is never lost" promise is baked into §3 of
  the live embed as a badge, and carried in Tweets 3–4 here.
- The live HTML embed animates Tweet 2 in-page — link it as the final reply
  ("play with the live version: …") where embeds are supported (e.g. the Notion
  page itself).
