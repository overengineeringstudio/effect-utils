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

| Table                         | Access        | Purpose                                                                                                     |
| ----------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `notion_data_sources`         | read          | Data-source metadata, schema/metadata hashes, binding summary                                               |
| `notion_databases`            | read          | Owning database/container metadata projected separately from data-source schema authority                   |
| `notion_views`                | read          | Notion UI view inventory for the owning database/data source; not local generated SQL views                 |
| `notion_properties`           | read          | Property ID, display name, type, config, write capability                                                   |
| `notion_rows`                 | guarded write | Row/page identity, lifecycle, parent, row hashes; `in_trash` queues lifecycle intents                       |
| `notion_cells`                | guarded write | Lossless property values plus scalar query helper columns; writable `value_json` queues cell intents        |
| `notion_relation_targets`     | read          | Relation target IDs observed through complete page-property pagination for guarded relation additions        |
| `notion_bodies`               | read          | Body path, body hashes, materialization/adapter state                                                       |
| `notion_cell_changes`         | write         | Typed CDC log for local cell edits queued for guarded sync                                                  |
| `notion_row_changes`          | write         | Typed CDC log for local row lifecycle/create edits queued for guarded sync                                  |
| `notion_row_creates`          | write         | Explicit row-create CDC with local idempotency keys and returned Notion `remote_page_id` settlement         |
| `notion_rows_effective`       | read          | Confirmed rows plus pending local creates for local desired-state inspection                                |
| `notion_cells_effective`      | read          | Confirmed cells plus initial values for pending local creates                                               |
| `notion_body_changes`         | write         | Typed CDC log for body pushes using body path/base hash semantics                                           |
| `notion_metadata_changes`     | write         | Typed CDC log for data-source and database title/description metadata edits with post-write hash settlement |
| `notion_schema_changes`       | write         | Typed CDC log for schema edit requests; execution currently fail-closed pending post-write reconciliation   |
| `notion_file_assets`          | write         | Explicit file staging records; external URLs are supported, local uploads remain fail-closed                |
| `notion_file_changes`         | write         | Typed CDC log for attaching staged external URL files to empty `files` properties                           |
| `notion_conflict_resolutions` | write         | Typed CDC requests for user conflict-resolution actions                                                     |
| `notion_local_changes`        | compatibility | Unified local-change projection for inspection and older explicit inserts                                   |
| `notion_conflicts`            | read          | User-visible conflict records and resolution state                                                          |
| `notion_sync_status`          | read          | Last sync, pending work, checkpoints, guards                                                                |

Generated `notion_view_<data-source-slug>` views are read-only convenience views
for querying adopted data sources with escaped property-name columns. They are
local SQLite projections and are distinct from Notion UI views in
`notion_views`; Notion view query results are never used as row membership or
deletion authority. Generated SQL views are derived from the generic tables and
can be rebuilt when Notion schema names change.

Example reads:

```sh
sqlite3 "$PWD/notion-workspace/notion.sqlite" \
  "select page_id, in_trash, properties_hash from notion_rows limit 10;"

sqlite3 "$PWD/notion-workspace/notion.sqlite" \
  'select "Name", "Status" from notion_view_data_source_1 limit 10;'
```

Example local edit through the current-state table:

```sh
sqlite3 "$PWD/notion-workspace/notion.sqlite" <<'SQL'
update notion_cells
set value_json = '{"_tag":"title","plainText":"Done"}'
where page_id = '11111111-1111-4111-8111-111111111111'
  and property_id = 'title-property-id';
SQL
```

That update is accepted only when the cell's `write_class` is `writable`. On
success it keeps scalar helper columns and generated read views coherent with
the local desired value, and queues a guarded `cell_patch` row in
`notion_cell_changes`. The compatibility `notion_local_changes` surface mirrors
that typed row. Repeated direct edits to the same cell before sync coalesce to
one effective pending typed row with the latest desired value. Invalid canonical
value JSON and computed/system cells fail before visible replica state changes.

Equivalent explicit local edit intent:

```sh
sqlite3 "$PWD/notion-workspace/notion.sqlite" <<'SQL'
insert into notion_cell_changes
  (change_id, data_source_id, page_id, property_id, value_json, base_hash)
values
  (
    'cell:11111111-1111-4111-8111-111111111111:status-property-id:manual',
    '00000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'status-property-id',
    '{"_tag":"status","option":{"id":"done","name":"Done","color":"green"}}',
    'sha256-current-cell-base'
  );
SQL

notion-datasource-sync sync "$PWD/notion-workspace" --dry-run
notion-datasource-sync sync "$PWD/notion-workspace"
```

Supported typed public mutation tables today are `notion_cell_changes`,
`notion_row_changes`, `notion_body_changes`, `notion_metadata_changes`,
`notion_file_changes`, and `notion_conflict_resolutions`. Row creation uses
`notion_row_creates`, not `INSERT INTO notion_rows`; the create path requires a
stable `client_request_key`, `local_row_id`, initial canonical property values,
and `base_schema_hash`, then settles the returned Notion `remote_page_id` after
the guarded create-page command succeeds. `notion_row_changes.kind` supports
`row_archive`, `row_restore`, and compatibility `row_create` rows, but new row
creation should use `notion_row_creates`. Destructive edits are never inferred from
`delete from notion_rows` or from missing local files.

Body changes use `notion_body_changes` with `page_id`, `body_path`,
`local_body_hash`, optional `local_body_content`, and `base_hash`; unsafe body
states such as unknown/truncated/synced content remain blocked by the body
adapter safety guards, and inline `local_body_content` must hash to
`local_body_hash` before any remote body write can be planned. Data-source and
database title/description metadata rows execute with post-write hash
settlement. Public schema CDC rows are present but fail closed until
post-schema hash reconciliation is modeled. Conflict-resolution rows execute
only through the store-backed conflict command path for safe choices.

External URL file attachments use two explicit tables. Insert one
`notion_file_assets(source_type='external_url', name, external_url)` row, then
insert a `notion_file_changes(action='attach_external_url', page_id,
property_id, base_hash)` row targeting an empty writable `files` property. The
sync converts that into a guarded page-property patch and settles the CDC row
after read-after-write. Local uploads, signed Notion-hosted URLs, replacement,
deletion, preserving existing files, and direct `notion_cells.value_json` edits
for `files` properties are fail-closed until file-upload identity and attachment
lifecycle are modeled. Direct `people` cell edits are also fail-closed until
deterministic accessible user identities and full paginated base values are
modeled. Notion views are a separate future read/write surface.

Relation cell edits are replacement-shaped Notion writes. They are accepted only
when the base relation value was fully paginated, the desired relation has at
most 100 page IDs, and every added page ID appears in `notion_relation_targets`
for the same data source and property. This lets local SQL add back or add
already-observed accessible targets without silently dropping unknown or
unshared pages.

Direct `notion_rows.in_trash` edits also use final-state CDC semantics. For
example, toggling `0 -> 1 -> 0` before sync cancels the pending direct archive
instead of replaying an intermediate trash command against Notion.
