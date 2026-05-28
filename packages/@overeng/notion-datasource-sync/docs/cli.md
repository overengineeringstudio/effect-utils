# CLI Reference

The binary is `notion-datasource-sync`.

```sh
notion-datasource-sync sync --from-notion <data-source-id-or-database-url> <workspace-root> [--dry-run] [--limit <rows>] [--no-materialize-bodies]
notion-datasource-sync sync <workspace-root> [--dry-run]
notion-datasource-sync status <workspace-root>
notion-datasource-sync doctor <workspace-root>/<database-id>.sqlite
sqlite3 <workspace-root>/<database-id>.sqlite

notion-datasource-sync conflicts list <workspace-root>/<database-id>.sqlite
notion-datasource-sync conflicts resolve <workspace-root>/<database-id>.sqlite --conflict-id <id> --strategy <keep-remote|keep-local|manual> [--value-json <json>] [--dry-run]
notion-datasource-sync forget <workspace-root>/<database-id>.sqlite --page-id <id> [--dry-run]
notion-datasource-sync restore <workspace-root>/<database-id>.sqlite --page-id <id> [--dry-run]
notion-datasource-sync watch <workspace-root> [--max-cycles <n>]
```

`migrate store`, `migrate schema`, and `repair` are parsed but currently
unsupported. They fail before doing work.

## Environment

| Variable           | Required | Meaning                                     |
| ------------------ | -------- | ------------------------------------------- |
| `NOTION_API_TOKEN` | live CLI | Notion integration token                    |
| `NOTION_TOKEN`     | fallback | Legacy token fallback                       |
| `OTEL_*` variables | optional | OpenTelemetry resource/correlation settings |

Live E2E and demo variables are documented in [Testing And Demo](./testing.md).

## Shared Flags

| Flag                       | Meaning                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `--from-notion`            | Existing Notion data-source ID, or a database URL that resolves to one child data source           |
| `--limit`, `--max-rows`    | Dry-run-only establishment preview row cap; writes nothing and reports capped query state          |
| `--schema-properties-json` | Advanced/debug override for schema-property observations; normal sync discovers schema from Notion |
| `--required-capabilities`  | Comma-separated capability preflight list                                                          |
| `--max-executor-steps`     | Bound outbox execution in `sync` and `watch`                                                       |
| `--no-materialize-bodies`  | Observe properties/schema without local body materialization                                       |

## Commands

| Command              | Effect                                                               |
| -------------------- | -------------------------------------------------------------------- |
| `sync --from-notion` | Establishes a workspace from an existing Notion database/data source |
| `sync <workspace>`   | Reconciles all established database files in a workspace             |
| `status <workspace>` | Reads public status and pending work for established database files  |
| `doctor <sqlite>`    | Verifies one database file, including private `_nds_*` integrity     |
| `watch <workspace>`  | Repeats sync cycles and processes local SQLite CDC with daemon state |
| `conflicts list`     | Prints conflicts, guards, tombstones, and pending outbox actions     |
| `conflicts resolve`  | Resolves a conflict by explicit user action                          |
| `forget`             | Removes local tracking for a page after explicit user intent         |
| `restore`            | Plans restore of a tracked trashed page                              |

## Output

Successful commands print a pretty JSON envelope to stdout:

```json
{
  "_tag": "CliResultEnvelope",
  "version": "v1",
  "command": "status",
  "ok": true,
  "rootId": "database:00000000-0000-4000-8000-000000000001",
  "status": { "state": "clean" },
  "surface": { "conflicts": [], "guards": [], "tombstones": [], "outbox": [] },
  "result": { "state": "clean" }
}
```

Errors print a JSON envelope to stderr:

```json
{
  "_tag": "CliErrorEnvelope",
  "version": "v1",
  "ok": false,
  "error": {
    "_tag": "CliArgumentError",
    "message": "Missing datasource-sync database file"
  }
}
```

Treat command output as operational data. It can include page IDs, database
IDs, data-source IDs, and local paths.

## Workspace Files

`sync --from-notion <data-source-id-or-database-url> <workspace-root>` creates
one SQLite file per Notion database:

```text
<workspace-root>/<database-id>.sqlite
```

The database ID comes from Notion and is stable across display-name changes.
The file is self-contained: public tables, debug views, private event/outbox
state, migrations, checkpoints, and integrity digests all live inside the same
SQLite database. A `.notion-datasource-sync/store.sqlite` or config sidecar is
not required state.

When `--from-notion` receives a Notion database/container URL, the CLI retrieves
the database and uses its single child data source. Databases with zero or
multiple child data sources fail closed; pass the exact data-source ID instead.

Use a bounded no-write preview before adopting large existing databases:

```sh
notion-datasource-sync sync --from-notion <database-url> <workspace-root> --dry-run --limit 25
```

`--limit` and `--max-rows` are aliases and are intentionally dry-run-only. They
cap the remote row preview and mark the query as capped; they do not perform a
partial adoption.

Product sync does not accept query-contract JSON. Every
`<workspace-root>/<database-id>.sqlite` file is established from the full Notion
database membership query. Internal tests may exercise filtered gateway queries,
but those paths are not CLI establishment modes and must not create
database-ID-named replica files.

## Public SQLite API

Read and write the local replica through `<workspace-root>/<database-id>.sqlite`.
For product integrations, `rows` is the primary writable API. Write ordinary
row data with guarded `INSERT` / `UPDATE` statements against `rows`; use
`changes`, `conflicts`, and `sync_status` to observe what the planner accepted,
blocked, settled, or left for user action. `_nds_*` tables are private state,
not extension points.

Stable public surfaces:

| Surface             | Access        | Purpose                                                                                        |
| ------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `rows`              | guarded write | Canonical row surface; Notion property columns first, `_` system columns last                  |
| `schema`            | read view     | Binding, database/data-source metadata, schema hashes, and sync identity                       |
| `schema_properties` | read view     | Property ID/name/type/write-class to `rows` column mapping                                     |
| `changes`           | guarded write | Local edit intents, planner status, settlement status, and unsupported reasons                 |
| `conflicts`         | read view     | User-visible conflict records and resolution state                                             |
| `sync_status`       | read view     | Last sync, pending work, checkpoints, private integrity state, and fail-closed guard summaries |

Debug views are named `debug_*` and are read-only. They expose normalized rows,
cells, canonical JSON, outbox state, pagination evidence, and projection
diagnostics. Private implementation tables are named `_nds_*`; they are not a
public API and must not be edited.

Example reads:

```sh
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" \
  'select _page_id, _in_trash, "Name", "Status" from rows limit 10;'

sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" \
  'select column_name, property_id, property_name, property_type from schema_properties order by ordinal;'
```

Example local edit through `rows`:

```sh
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" <<'SQL'
update rows
set "Name" = 'Done',
    "Status" = 'Complete'
where _page_id = '11111111-1111-4111-8111-111111111111';
SQL
```

That update is accepted only when each mapped property's `write_class` is
`writable` and the SQL value can be converted to canonical Notion property JSON.
On success it queues a durable public change. Repeated direct edits to the same
cell before sync coalesce to one effective pending change with the latest
desired value. Invalid values and computed/system cells fail before visible
replica state changes.

Supported direct `rows` mutations are scalar/property `UPDATE`, `INSERT` for a
new row, and archive/restore through `_in_trash`:

```sh
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" <<'SQL'
insert into rows ("Name", "Status")
values ('New launch task', 'Not started');

update rows
set _in_trash = 1
where _page_id = '11111111-1111-4111-8111-111111111111';
SQL
```

`DELETE FROM rows` is rejected. Destructive edits are never inferred from SQL
delete or from missing local files.

Review and apply:

```sh
notion-datasource-sync sync "$PWD/notion-workspace" --dry-run
notion-datasource-sync sync "$PWD/notion-workspace"
```

`changes` is the public audit and intent surface. It reports pending,
unsupported, queued, planned, applied, rejected, and conflict states for direct
row edits and explicit change requests. Sync reads public changes, validates
them against `_nds_*` base hashes, enqueues private outbox commands, executes
remote writes, then settles only after read-after-write verification.

`watch <workspace-root>` must process the same local SQLite CDC as
`sync <workspace-root>`. A daemon cycle observes pending public changes,
coalesces current-state row edits where appropriate, plans guarded remote
commands, and settles only after verification. Watch mode must not ignore local
`rows` edits while polling Notion.

## Backup And Copy

Use SQLite checkpoint/backup semantics when copying a live database:

```sh
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" "pragma wal_checkpoint(full);"
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" ".backup '$PWD/backup/<database-id>.sqlite'"
```

For an offline copy, stop sync/watch first and copy the SQLite file plus any
SQLite-managed `-wal`/`-shm` files that still exist.
