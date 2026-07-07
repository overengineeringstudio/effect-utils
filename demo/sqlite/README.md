# Demo: `notion db` — a Notion database as a local SQLite file

**Primitive:** `@overeng/notion-datasource-sync`, surfaced as `notion db …`.

**The gap:** Notion has no first-class way to treat a database as a local,
scriptable, offline-editable store. You get the API, the CLI, Workers — but no
"open my database as a file, edit it with the tools I already have, push it
back."

**What this is:** `notion db track` binds one Notion **data source** to a local
`data/v1/<data-source-id>.sqlite` file. You observe schema, rows, and
properties as ordinary SQLite; you edit rows with plain `sqlite3`; and
`notion db sync` pushes those edits back to Notion through a **guarded** sync —
durable intent ledger, read-after-write verification, and **fail-closed** on any
edit it can't prove safe.

**The WOW:** edit a row with `sqlite3`, run `notion db sync`, watch the change
land in the Notion UI — then watch the same file **refuse** an unsupported edit.

**The story:** this is the stopgap until Notion ships first-class local sync.
Everything that isn't provably safe **fails closed** instead of silently
corrupting your Notion data (see `docs/capabilities.md` and
`docs/vrs/capability-gaps.md`).

Budget: ~7 minutes.

---

## Runtime boundary (read once)

`notion db` replica commands need Node's `node:sqlite`, so they run in a
Node-backed runtime (not Bun). The packaged `notion` binary handles this
automatically: every `db` replica verb (`track`, `sync`, `export`, `status`, …)
is routed to the Node runtime, and the sync progress UI degrades cleanly to
plain textual progress when its optional TUI can't load. No env vars, no
preloads — the on-camera `notion db …` commands are the real binary, unchanged.

The guard beat (Beat 3) is enforced by SQLite triggers **inside the file**, so it
fires under plain `sqlite3` too.

---

## Backstage (before recording — NOT on camera)

```sh
devenv shell                        # puts `notion`, node, sqlite3, ntn on PATH
export DEMO_PARENT_PAGE=<page-id>   # a page shared with the Notion CLI integration
./demo/sqlite/reset.sh              # fresh synthetic DB + rows, tracked into stage/
```

Then open the printed **Notion URL** in the browser (this is the window the
audience watches update), and:

```sh
cd demo/sqlite/stage
```

Everything below is copy-pasteable; all ids/paths come from `.demo-state/`.

---

## Beat 1 — A Notion database, as a local file (~1.5 min)

> "This is a normal Notion database. And this — is the same database, as a
> local SQLite file on my laptop. No export, no CSV. A live, bound replica."

```sh
sqlite3 "$(cat ../.demo-state/sqlite-path)" ".tables"
```

Point out the public surface: `pages` (the rows), `schema`, `schema_properties`,
`changes`, `conflicts`, `sync_status` — plus read-only `debug_*` views and
private `_nds_*` sync state.

```sh
sqlite3 -header -column "$(cat ../.demo-state/sqlite-path)" \
  'select "Name", "Status", "Priority", "Team" from pages order by "Priority";'
```

> "Every Notion property is a real column. I can query this with anything that
> speaks SQLite — `sqlite3`, my ORM, a dashboard. Offline."

---

## Beat 2 — Edit with plain SQL → it lands in Notion (~2.5 min) — **THE WOW**

> "Watch. I'll close out a task with plain SQL — no API calls, no code."

```sh
sqlite3 "$(cat ../.demo-state/sqlite-path)" \
  "UPDATE pages SET \"Status\" = 'Done' WHERE \"Name\" = 'Fix flaky deploy pipeline';"
```

Show that the edit is a **durable, guarded intent** — not a blind API call:

```sh
sqlite3 -header -column "$(cat ../.demo-state/sqlite-path)" \
  "select kind, status, property_id from changes;"
```

> "It's recorded as a `pending` change in a durable ledger *before* anything
> touches Notion. Nothing has hit the API yet."

Now push it (`--no-materialize-bodies` keeps the sync to ~5s — we're editing row
properties, not page bodies):

```sh
notion db sync . --no-materialize-bodies
```

**Switch to the Notion browser tab and refresh if needed.** The row's Status
flips to **Done** live.

> "That landed through a guarded sync: it re-read the row, pushed the property,
> then verified the result before marking the change `applied`. The ledger now
> reads `applied` — read-after-write, not fire-and-forget."

```sh
sqlite3 -header -column "$(cat ../.demo-state/sqlite-path)" \
  "select kind, status from changes;"
```

---

## Beat 3 — Fail-closed guard (~2 min) — **the stopgap payoff**

> "Here's what makes this safe enough to actually use. It refuses anything it
> can't prove is safe. It fails closed."

**Destructive delete — refused in the file itself:**

```sh
sqlite3 "$(cat ../.demo-state/sqlite-path)" \
  "DELETE FROM pages WHERE \"Name\" = 'Fix flaky deploy pipeline';"
```

You get an immediate, typed refusal:

```
Error: stepping, DELETE FROM pages is intentionally unsupported;
update _in_trash for archive CDC
```

> "A local `DELETE` must never silently become a permanent Notion deletion. So
> it's blocked — archive/restore goes through an explicit, reversible
> `_in_trash` lifecycle instead."

**Computed property — refused, because Notion owns it:**

```sh
sqlite3 "$(cat ../.demo-state/sqlite-path)" \
  "UPDATE pages SET \"Effort (h)\" = 999 WHERE \"Name\" = 'Draft Q3 roadmap';"
```

```
Error: stepping, pages property column is not supported for direct writes
```

> "`Effort (h)` is a Notion formula. Computed values are read-only, forever, per
> Notion — so a write can't even be staged."

Tie it back to the gates:

> "This is the whole discipline. Schema migrations, people writes, file uploads,
> Notion views — all *blocked until the behavior is proven safe*
> (`docs/vrs/capability-gaps.md`). It degrades to a typed refusal, never to
> silent data loss. That's what makes a local-first stopgap trustworthy until
> Notion ships this natively."

---

## Reset between takes

```sh
./demo/sqlite/reset.sh   # fresh DB + rows, re-tracked; trashes the previous one
```

## Files

- `seed/schema.json` — synthetic typed schema (title, select, number, formula).
- `seed/rows.json` — 6 fully synthetic "Launch Tasks" rows.
- `setup.sh` — backstage: create the Notion DB + rows, capture ids.
- `reset.sh` — backstage: cleanup + `setup.sh` + `notion db track --mode local`.
- `stage/` — the on-camera working directory (the tracked workspace root).
- `.demo-state/` — captured ids/paths (gitignored).

Everything is synthetic and safe for a public repo — no secrets, no private IDs.
