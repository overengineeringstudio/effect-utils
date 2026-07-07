# notion sqlite — Screenplay

Gap: Notion has no first-class way to open a database as a local, scriptable, offline-editable file. Wow: edit a row with plain `sqlite3`, run `notion db sync`, watch it land in the Notion UI. Stopgap story: unsupported edits **fail closed** (typed refusal, never silent data loss) — the discipline that makes a local-first stopgap trustworthy until Notion ships this natively. ~7 min.

## Backstage (before recording — not on camera)
- `devenv shell`
- `eval "$(demo/env/demo-env new --export)"`   # fresh isolated env: creates synthetic DB + rows, tracks it (mode=local), sets DEMO_* + prints links
- open the printed **sqlite · Launch Tasks DB** link in the browser (the window the audience watches)

## On camera (copy-paste in order)

### Beat 1 — A Notion database, as a local file   say: "This is my Notion database — and this is the same database as a local SQLite file. Not an export. A live, bound replica."
```
cd "$DEMO_SQLITE_DIR"
```

```
sqlite3 "$DEMO_SQLITE_PATH" ".tables"
```

```
sqlite3 -header -column "$DEMO_SQLITE_PATH" 'select "Name", "Status", "Priority", "Team" from pages order by "Priority";'
```

### Beat 2 — Edit as SQLite   say: "I'll close a task out with plain SQL — no API, no code. It's recorded as a durable pending intent first, then a guarded sync pushes and verifies it."
```
sqlite3 "$DEMO_SQLITE_PATH" "UPDATE pages SET \"Status\" = 'Done' WHERE \"Name\" = 'Fix flaky deploy pipeline';"
```

```
sqlite3 -header -column "$DEMO_SQLITE_PATH" "select kind, status, property_id from changes;"
```

```
notion db sync . --no-materialize-bodies
```
Then: switch to the Notion browser tab, refresh if needed — the row flips to **Done** live. (Optional) show it settled:
```
sqlite3 -header -column "$DEMO_SQLITE_PATH" "select kind, status from changes;"
```

### Beat 3 — Fail-closed guard   say: "Here's what makes it safe to actually use — it refuses anything it can't prove is safe. A local DELETE must never silently become a permanent Notion deletion; a computed property is read-only forever per Notion."
```
sqlite3 "$DEMO_SQLITE_PATH" "DELETE FROM pages WHERE \"Name\" = 'Fix flaky deploy pipeline';"
```

```
sqlite3 "$DEMO_SQLITE_PATH" "UPDATE pages SET \"Effort (h)\" = 999 WHERE \"Name\" = 'Draft Q3 roadmap';"
```
Both return an immediate typed refusal from triggers inside the file:
```output
Error: stepping, DELETE FROM pages is intentionally unsupported; update _in_trash for archive CDC
Error: stepping, pages property column is not supported for direct writes
```
say: "It degrades to a typed refusal, never to silent data loss — schema migrations, people writes, file uploads, views are all blocked until Notion behavior is proven (docs/vrs/capability-gaps.md). That's the stopgap discipline until Notion ships this natively."

## Reset between takes (backstage)
- `eval "$(demo/env/demo-env new --export)"`   # fresh isolated env (new DB + rows, re-tracked); the old env stays until `demo/env/demo-env rm <id>`
