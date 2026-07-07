# notion schema — X thread draft

A problem-first visual thread. One tweet per section. The section images are
**caption-less** (visual + headline only) — the tweet copy below carries the
words, so nothing is duplicated. Voice: plainspoken, concrete, one idea per beat.

Media files live alongside this doc in the review dir.

---

**Tweet 1 — The problem** · media: `notion-schema-thread-1-untyped.png`

My Notion database is right there — a Status select, a due date, a relation. But
the API hands my code untyped JSON, so I end up guessing at property names and
option strings.

Someone renames a Status option in the UI and my `=== "In Progress"` check just…
silently stops matching. `tsc` says 0 errors. It breaks in prod.

---

**Tweet 2 — See it work** · media: `notion-schema-thread-2-typed-schema.png`

One command fixes that:

`notion schema generate <id> -o tasks.gen.ts --typed-options --include-api`

It introspects the live database and writes a typed Effect schema. Every
select/status becomes a literal union (`"Todo" | "In Progress" | "Done"`) and my
editor autocompletes every option. `--include-api` emits a companion
`tasks.gen.api.ts` with a typed `queryAll / get / create / update` wrapper.

---

**Tweet 3 — The shift** · media: `notion-schema-thread-3-versioned-code.png`

The real unlock: your Notion databases become versioned, typed code.

Commit the `.gen.ts`, review it in PRs, type-check it end to end. A wrong property
name or a renamed option now fails at compile time — not in production.

…and CI catches drift before it ships.

---

**Tweet 4 — …and here's the drift gate** (the depth, for anyone still reading) · media: `notion-schema-thread-4-drift-gate.png`

"But Notion and my code will drift." Right — so gate it.

Change a property in the Notion UI, then in CI:

`notion schema diff <id> --file tasks.gen.ts --exit-code`

It mirrors the live DB against your committed types and **exits 1** the moment
they disagree. Red build before red prod.

Honest scope: this is introspect → codegen → drift *detection*, not declarative
provisioning. You still create and change the database in Notion — the CLI keeps
your types honest about it.

---

## Notes for posting

- Tweets 1–3 are the core thread — a clean, scroll-stopping arc. Tweet 4 is an
  optional "going deeper" coda; drop it for the tighter 3-beat version.
- **Tweet 2 is the hero** — the `generate` command + the typed literal-union
  autocomplete is the "aha". Lead the thread's visual weight here.
- Optional motion: Tweet 4's drift gate reads great as a short GIF
  (`notion-schema-drift-gate.gif`) — a Notion property change flips the CI
  terminal red with `exit 1`. The still (`notion-schema-thread-4-drift-gate.png`)
  already carries it if a venue can't take a GIF.
- Section images are 2:1 landscape (X-safe, uncropped in-timeline) and rendered
  at 2× for crispness. Dark-mode variants exist too
  (`notion-schema-dark-section-N-*.png`).
- Every visual is native-surface: the Notion side is a **rendered database grid**
  (property types, Status pills, a relation), the code side is a
  **syntax-highlighted editor / terminal** — two recognizably different surfaces.
- The live HTML embed (`notion-schema.html`) animates nothing but reads top to
  bottom as the full thread — link it as the final reply where embeds are
  supported (e.g. the Notion page itself).
