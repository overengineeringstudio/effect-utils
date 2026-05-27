# CLI Reference

The binary is `notion-datasource-sync`.

```sh
notion-datasource-sync sync --from-notion <data-source-id-or-database-url> <workspace-root> [--dry-run] [--limit <rows>] [--no-materialize-bodies]
notion-datasource-sync sync <workspace-root> [--dry-run]
notion-datasource-sync status <workspace-root>
sqlite3 <workspace-root>/notion.sqlite

notion-datasource-sync init --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--dry-run]
notion-datasource-sync pull --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir>
notion-datasource-sync push --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--dry-run]
notion-datasource-sync sync --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--dry-run]
notion-datasource-sync status --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir>
notion-datasource-sync watch --state <json> --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--max-cycles <n>]
notion-datasource-sync conflicts list --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir>
notion-datasource-sync conflicts resolve --conflict-id <id> --strategy <keep-remote|keep-local|manual> [--value-json <json>] --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--dry-run]
notion-datasource-sync forget --page-id <id> --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--dry-run]
notion-datasource-sync restore --page-id <id> --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--dry-run]
notion-datasource-sync doctor --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir>
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

| Flag                       | Meaning                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `--from-notion`            | Existing Notion data-source id, or a database URL that resolves to one child data source  |
| `--limit`, `--max-rows`    | Dry-run-only establishment preview row cap; writes nothing and reports capped query state |
| `--store`                  | SQLite store path                                                                         |
| `--root-id`                | Local sync root partition                                                                 |
| `--data-source-id`         | Notion data source id                                                                     |
| `--workspace-root`         | Local workspace root                                                                      |
| `--query-contract-json`    | Explicit query contract JSON                                                              |
| `--schema-properties-json` | Schema-property observations for write planning                                           |
| `--required-capabilities`  | Comma-separated capability preflight list                                                 |
| `--max-executor-steps`     | Bound outbox execution in `push`, `sync`, and `watch`                                     |
| `--no-materialize-bodies`  | Observe properties/schema without local body materialization                              |

## Commands

| Command              | Effect                                                                            |
| -------------------- | --------------------------------------------------------------------------------- |
| `sync --from-notion` | Establishes a workspace from an existing Notion data source; remote-to-local only |
| `sync <workspace>`   | Reconciles an established workspace using local config discovery                  |
| `status <workspace>` | Reads projections for an established workspace                                    |
| `init`               | Advanced: records only the local root/data-source/workspace binding               |
| `pull`               | Advanced: observes Notion and materializes local state where configured           |
| `push`               | Advanced: scans local artifacts, plans writes, and executes the outbox            |
| `sync --store ...`   | Advanced: runs pull, local scan/planning, outbox execution, and verification      |
| `watch`              | Repeats sync cycles with daemon state and optional max-cycle bound                |
| `conflicts list`     | Prints conflicts, guards, tombstones, and pending outbox actions                  |
| `conflicts resolve`  | Resolves a conflict by event, optionally planning follow-up commands              |
| `forget`             | Removes local tracking for a page after explicit user intent                      |
| `restore`            | Plans restore of a tracked trashed page                                           |
| `doctor`             | Aggregates status, compaction readiness, and user-action surfaces                 |

## Output

Successful commands print a pretty JSON envelope to stdout:

```json
{
  "_tag": "CliResultEnvelope",
  "version": "v1",
  "command": "status",
  "ok": true,
  "rootId": "workspace-main",
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
    "message": "Missing required --store"
  }
}
```

Treat command output as operational data. It can include page ids, data-source
ids, and local paths.

## Workspace Config

`sync --from-notion <data-source-id-or-database-url> <workspace-root>` creates:

```text
<workspace-root>/notion.sqlite
<workspace-root>/.notion-datasource-sync/config.json
<workspace-root>/.notion-datasource-sync/store.sqlite
```

`notion.sqlite` is the public local replica/API. The config records the local
root id, data-source id, internal store path, replica path, workspace root,
Notion API version, config version, and body materialization policy. `sync
<workspace-root>` and `status <workspace-root>` read this config. Missing config,
a store binding for a different data source, a replica generated from the wrong
binding, or a workspace path mismatch fails closed with a setup/repair hint.

`.notion-datasource-sync/store.sqlite` is internal sync-control state. Its event
log, projections, outbox, conflicts, checkpoints, and migrations are not the
user-facing data API.

When `--from-notion` receives a Notion database/container URL, the CLI retrieves
the database and uses its single child data source. Databases with zero or
multiple child data sources fail closed; pass the exact data-source id instead.

Use a bounded no-write preview before adopting large existing databases:

```sh
notion-datasource-sync sync --from-notion <database-url> <workspace-root> --dry-run --limit 25
```

`--limit` and `--max-rows` are aliases and are intentionally dry-run-only. They
cap the remote row preview and mark the query as capped; they do not perform a
partial adoption.

## Public SQLite API

Read and write the local replica through `<workspace-root>/notion.sqlite`.

Stable generic tables:

| Table                  | Access | Purpose                                                        |
| ---------------------- | ------ | -------------------------------------------------------------- |
| `notion_data_sources`  | read   | Data-source metadata, schema/metadata hashes, binding summary  |
| `notion_properties`    | read   | Property ID, display name, type, config, write capability      |
| `notion_rows`          | read   | Row/page identity, lifecycle, parent, row hashes               |
| `notion_cells`         | read   | Lossless property values plus scalar query helper columns      |
| `notion_bodies`        | read   | Body path, body hashes, materialization/adapter state          |
| `notion_local_changes` | write  | Local data edit intents queued for guarded sync                |
| `notion_conflicts`     | read   | User-visible conflict records and resolution state             |
| `notion_sync_status`   | read   | Last sync, pending work, checkpoints, guards                   |

Generated `*_current` views are read-only convenience views for querying adopted
data sources with property-name columns. They are derived from the generic
tables and can be rebuilt when Notion schema names change.

Example reads:

```sh
sqlite3 "$PWD/notion-workspace/notion.sqlite" \
  "select row_id, title, in_trash from notion_rows limit 10;"

sqlite3 "$PWD/notion-workspace/notion.sqlite" \
  'select "Name", "Status" from tasks_current limit 10;'
```

Example local edit intent:

```sh
sqlite3 "$PWD/notion-workspace/notion.sqlite" <<'SQL'
insert into notion_local_changes
  (kind, data_source_id, row_id, property_id, value_json, base_row_hash)
values
  (
    'patch_cell',
    '00000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'status-property-id',
    '{"type":"status","status":{"name":"Done"}}',
    'sha256-current-row-base'
  );
SQL

notion-datasource-sync sync "$PWD/notion-workspace" --dry-run
notion-datasource-sync sync "$PWD/notion-workspace"
```

Destructive edits are never inferred from `delete from notion_rows` or from
missing local files. Archive, restore, row creation, body edits, metadata edits,
and schema-affecting edits must be explicit intent kinds so dry-run can show
exact planned Notion mutations before they execute.
