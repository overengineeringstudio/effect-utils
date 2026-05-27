# Getting Started

`notion-datasource-sync` syncs a Notion data source with a local SQLite replica.
The user-facing local API is `workspace/notion.sqlite`. The internal control
store is `workspace/.notion-datasource-sync/store.sqlite`; do not read or edit
it as the local Notion database.

The sync engine observes the data source schema, metadata, rows, selected row
properties, row lifecycle state, and row page bodies. It projects current state
into `notion.sqlite`, accepts local data edits as guarded write intents, and
uses CLI sync to apply supported intents to Notion.

## Credentials

Set the Notion token before running live commands:

```sh
export NOTION_API_TOKEN="secret_..."
```

The integration must have access to the data source and every related fixture
that should be observed. If a relation, rollup, person, or page property points
outside the integration's permissions, sync treats that surface as incomplete or
ambiguous.

## Establish A Workspace

Start from an existing Notion data source:

```sh
notion-datasource-sync sync --from-notion \
  00000000000040008000000000000001 \
  "$PWD/notion-workspace"
```

You may also pass a Notion database URL. The CLI resolves it to the database's
single child data source. If the database has multiple data sources, pass the
desired data-source id explicitly.

This creates `notion.sqlite`, `.notion-datasource-sync/config.json`, and
`.notion-datasource-sync/store.sqlite` under the workspace root, validates the
Notion data source, records the local binding, pulls remote schema/metadata/rows,
projects them into the local replica, and materializes row body artifacts when
body materialization is enabled.

First establishment is remote-to-local only. It does not scan local files, plan
local writes, enqueue outbox commands, or mutate Notion.

Preview establishment without writing config, store events, sidecars, body
files, or Notion state:

```sh
notion-datasource-sync sync --from-notion \
  00000000000040008000000000000001 \
  "$PWD/notion-workspace" \
  --dry-run
```

For large existing databases, cap the no-write preview:

```sh
notion-datasource-sync sync --from-notion \
  <database-url-or-data-source-id> \
  "$PWD/notion-workspace" \
  --dry-run \
  --limit 25
```

The limit reports a capped query preview and does not perform a partial
adoption.

Use `--no-materialize-bodies` when you want schema/metadata/row adoption without
local body files:

```sh
notion-datasource-sync sync --from-notion 00000000000040008000000000000001 "$PWD/notion-workspace" --no-materialize-bodies
```

## Query The Local Replica

Use `notion.sqlite`, not `.notion-datasource-sync/store.sqlite`:

```sh
sqlite3 "$PWD/notion-workspace/notion.sqlite" ".tables"
sqlite3 "$PWD/notion-workspace/notion.sqlite" \
  "select data_source_id, schema_hash, metadata_hash from notion_data_sources;"
sqlite3 "$PWD/notion-workspace/notion.sqlite" \
  "select page_id, in_trash, properties_hash from notion_rows limit 10;"
```

The stable generic tables are:

| Table                                              | Purpose                                                        |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `notion_data_sources`                              | Adopted data-source identity, title, description, icon, hashes |
| `notion_properties`                                | Property IDs, names, types, configs, writable/read-only policy |
| `notion_rows`                                      | Page row identity, lifecycle, parent/source, row hashes        |
| `notion_cells`                                     | Lossless property values plus scalar helper columns            |
| `notion_relation_targets`                          | Observed accessible relation targets for guarded additions     |
| `notion_bodies`                                    | Body materialization paths, hashes, and adapter state          |
| `notion_cell_changes`                              | Typed local CDC rows for cell edits waiting for review/apply   |
| `notion_row_changes`                               | Typed local CDC rows for row lifecycle/create edits            |
| `notion_row_creates`                               | Explicit local row creation requests with returned page IDs    |
| `notion_rows_effective` / `notion_cells_effective` | Confirmed remote state plus pending local creates              |
| `notion_views`                                     | Read-only Notion UI view inventory                             |
| `notion_local_changes`                             | Compatibility projection over local write intents              |
| `notion_conflicts`                                 | Open/resolved conflicts projected for users                    |
| `notion_sync_status`                               | Last sync, checkpoints, pending work, guard state              |

Generated read views provide ergonomic SQL for each adopted data source. Their
names currently use the data-source id slug, such as
`notion_view_data_source_1`. They are read-only; write to `notion_cells` /
`notion_rows` current-state columns or to typed mutation tables instead.
These generated SQL views are local projections and are distinct from Notion UI
views in `notion_views`.

```sh
sqlite3 "$PWD/notion-workspace/notion.sqlite" \
  'select "Task name", "Status", "Priority" from notion_view_data_source_1 limit 10;'
```

## Edit Local Data

Local SQL edits create explicit intents. They do not call Notion immediately.
For cell edits, updating `notion_cells.value_json` is the direct local-edit
surface:

```sql
update notion_cells
set value_json = '{"_tag":"title","plainText":"Done"}'
where page_id = '11111111-1111-4111-8111-111111111111'
  and property_id = 'title-property-id';
```

This first validates the canonical value shape, then updates scalar helper
columns and generated read views to the local desired state and queues a typed
`cell_patch` CDC row. If the same cell is edited repeatedly before sync, the
pending typed row is updated to the latest desired value instead of replaying
intermediate edits. The equivalent explicit intent form is:

```sql
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
```

Then review and apply with the CLI:

```sh
notion-datasource-sync sync "$PWD/notion-workspace" --dry-run
notion-datasource-sync sync "$PWD/notion-workspace"
```

The public replica layer now ships typed CDC tables for cell edits, row
lifecycle/create requests, body edits through the NotionMD boundary, metadata
edits, schema edits, and conflict-resolution requests. The executable subset is
intentionally narrower: writable scalar/page-property cells, row archive/restore,
body pushes that pass body safety and content-hash verification, and
store-backed conflict-resolution choices. Data-source and database
title/description metadata CDC rows execute with verified post-write metadata
hash reconciliation; schema CDC rows are visible for review but fail closed from
SQLite until verified post-write reconciliation is modeled. External URL files
can be attached to empty writable `files` properties through
`notion_file_assets` plus `notion_file_changes`; local uploads and replacing or
deleting existing file arrays remain guarded. Row creation is supported through `notion_row_creates`; direct
`INSERT INTO notion_rows` is blocked because `notion_rows` is observed remote
state. Notion view writes, destructive schema changes, and unsupported conflict-resolution actions remain fail-closed
until their dedicated proof is in place. Computed or unsupported properties
remain visible but read-only.

## Reconcile Local Changes

```sh
notion-datasource-sync sync "$PWD/notion-workspace"
```

Established `sync` reads the workspace config, observes remote state, rebuilds
or updates `notion.sqlite`, scans local write intents and body artifacts,
enqueues remote commands for supported guarded intents, executes bounded outbox
steps, verifies settlement, and projects final state back into the replica. Use
`sync "$PWD/notion-workspace" --dry-run` to observe and plan without appending
events, executing the outbox, mutating `notion.sqlite`, or materializing bodies.

Use `status` or `doctor` to inspect state:

```sh
notion-datasource-sync status "$PWD/notion-workspace"
notion-datasource-sync doctor --store "$PWD/notion-workspace/.notion-datasource-sync/store.sqlite" --root-id data-source:00000000000040008000000000000001 --data-source-id 00000000000040008000000000000001 --workspace-root "$PWD/notion-workspace"
```

`pull`, `push`, and `init` remain available as advanced/CI/debug commands when a
workflow needs explicit phase control.

## Query Contracts

The default query contract observes all rows with page size `100` and no filter
or sort. Pass an explicit contract when the workspace intentionally tracks a
filtered subset:

```sh
notion-datasource-sync pull \
  --store .notion-datasource-sync/store.sqlite \
  --root-id workspace-main \
  --data-source-id 00000000000040008000000000000001 \
  --workspace-root "$PWD/notion-workspace" \
  --query-contract-json '{"_tag":"QueryContract","apiVersion":"2026-03-11","filter":null,"sorts":[],"pageSize":50,"highWatermark":null,"membershipScope":"all-data-source-rows"}'
```

Changed filters, sorts, page sizes, high-watermarks, or membership scope produce
a different observation contract. The sync engine does not classify absence from
an incomplete or incompatible query.

## Body Sync

The live CLI wires the NotionMD-backed `PageBodySyncPort` when a Notion token is
available. Library callers can also inject the body adapter explicitly. Without
a token or injected body port, body sync fails closed rather than inventing a
second body implementation.

## Conflict Workflow

Conflicts are visible in `notion.sqlite` and through the CLI:

```sh
sqlite3 "$PWD/notion-workspace/notion.sqlite" \
  "select conflict_id, page_id, property_id, state from notion_conflicts;"

notion-datasource-sync conflicts list \
  --store "$PWD/notion-workspace/.notion-datasource-sync/store.sqlite" \
  --root-id data-source:00000000000040008000000000000001 \
  --data-source-id 00000000000040008000000000000001 \
  --workspace-root "$PWD/notion-workspace"
```

Resolve conflicts with explicit CLI commands. Do not update internal conflict
projection tables directly.
