# Getting Started

`notion db` syncs a Notion database with a local SQLite replica.
By default, one `<workspace>/<database-id>.sqlite` file maps to one Notion
database. The filename uses the Notion database ID, not the display name.

The SQLite file is self-contained. It contains the public local API, debug
views, and private `_nds_*` sync state. There is no required
`.notion-datasource-sync/store.sqlite` or config sidecar.

## Credentials

Set the Notion token before running live commands:

```sh
export NOTION_API_TOKEN="secret_..."
```

The integration must have access to the database, its data source, and every
related fixture that should be observed. If a relation, rollup, person, or page
property points outside the integration's permissions, sync treats that surface
as incomplete or ambiguous.

## Establish A Workspace

Start from an existing Notion data source or database URL:

```sh
notion db sync --from-notion \
  00000000000040008000000000000001 \
  "$PWD/notion-workspace"
```

This creates:

```text
notion-workspace/
  <database-id>.sqlite
```

The command validates the remote database/data source, records the binding
inside the SQLite file, pulls remote schema/metadata/rows, derives `rows`
property columns from live Notion schema, projects values into the public
tables, records sync-control state in `_nds_*`, and materializes row body
artifacts when body materialization is enabled. No user-maintained schema JSON
file is required for normal establishment or sync.

First establishment is remote-to-local only. It does not scan local write
intents, enqueue outbox commands, or mutate Notion.

Preview establishment without writing SQLite files, body files, or Notion
state:

```sh
notion db sync --from-notion \
  <database-url-or-data-source-id> \
  "$PWD/notion-workspace" \
  --dry-run
```

For large existing databases, cap the no-write preview:

```sh
notion db sync --from-notion \
  <database-url-or-data-source-id> \
  "$PWD/notion-workspace" \
  --dry-run \
  --limit 25
```

The limit reports a capped query preview and does not perform a partial
adoption.

There is no filtered or query-contract establishment mode. Once a SQLite file
is written as `<database-id>.sqlite`, it represents the full Notion database
replica.

## Query The Local Replica

Open the database-ID-named SQLite file:

```sh
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" ".tables"
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" \
  "select database_id, data_source_id, schema_hash, metadata_hash from schema;"
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" \
  "select column_name, property_id, property_type, write_class from schema_properties order by ordinal;"
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" \
  'select _page_id, "Task name", "Status" from rows limit 10;'
```

The stable public surfaces are:

| Surface             | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `rows`              | Canonical writable row surface for the Notion database      |
| `schema`            | Read view for binding, metadata, and schema hashes          |
| `schema_properties` | Read view for property-to-`rows` column mapping             |
| `changes`           | Local edit intents, planner status, and settlement evidence |
| `conflicts`         | Open/resolved conflicts projected for users                 |
| `sync_status`       | Last sync, checkpoints, pending work, guard state           |

Debug views are named `debug_*` and are read-only. Private sync tables are
named `_nds_*`; do not edit them.

## Edit Local Data

Local SQL edits create explicit intents. They do not call Notion immediately.
For ordinary scalar edits, update `rows`:

```sql
update rows
set "Status" = 'Done',
    "Priority" = 3
where _page_id = '11111111-1111-4111-8111-111111111111';
```

This validates the property mapping and value shape, updates local desired
state, and queues a durable entry in `changes` for guarded sync. If the same
cell is edited repeatedly before sync, final-state semantics keep the latest
desired value instead of replaying intermediate edits.

Create a row with `INSERT`:

```sql
insert into rows ("Name", "Status")
values ('New launch task', 'Not started');
```

Archive or restore by toggling `_in_trash`:

```sql
update rows
set _in_trash = 1
where _page_id = '11111111-1111-4111-8111-111111111111';
```

`DELETE FROM rows` is rejected. Archive or restore through `_in_trash` so the
remote lifecycle effect is explicit and reversible. To drop local tracking
without remote effect, use the `forget` CLI.

Review and apply with the CLI:

```sh
notion db sync "$PWD/notion-workspace" --dry-run
notion db sync "$PWD/notion-workspace"
```

Supported public edits currently include writable scalar/page-property cells,
row creation, row archive/restore through `_in_trash`, body pushes that pass
body safety and content-hash verification, metadata edits with post-write hash
reconciliation, and external URL files through typed staging for
currently-empty file properties. Schema changes are not a public CLI workflow:
`schema` and `schema_properties` are read-only, `ALTER TABLE rows` is rejected,
and `changes` is a read-only lifecycle ledger. Conflict resolution is CLI-only
through `notion db conflicts resolve`; direct writes to `conflicts` are rejected. People
writes, local file uploads, Notion view writes, computed/generated property
writes, SQL row deletes, `place` cells, and internal `_nds_*` edits fail
closed.

## Reconcile Local Changes

```sh
notion db sync "$PWD/notion-workspace"
```

Established `sync` discovers database files in the workspace, observes remote
state, updates public tables, scans local write intents, enqueues remote
commands for supported guarded intents, executes bounded outbox steps, verifies
settlement, and projects final state back into the same SQLite file.

Use dry-run to observe and plan without appending events, settling intents,
executing the outbox, mutating Notion, or materializing bodies:

```sh
notion db sync "$PWD/notion-workspace" --dry-run
```

Inspect state:

```sh
notion db status "$PWD/notion-workspace"
notion db doctor --sqlite "$PWD/notion-workspace/<database-id>.sqlite"
```

`doctor` verifies public/private schema integrity, `_nds_*` digests, SQLite
checkpoint state, query completeness, pending changes, conflicts, and
portability hazards. If private state is corrupt or tampered with, it fails
closed.

## Full Replica Completeness

Product sync observes the full Notion database with page size `100` and no
filter or sort. A `<database-id>.sqlite` file is only written after the product
path has used full database membership. Capped previews, interrupted scans, or
internal debug query shapes do not establish a replica and do not classify row
absence.

## Body Sync

The live CLI wires the NotionMD-backed `PageBodySyncPort` when a Notion token is
available. Library callers can also inject the body adapter explicitly. Without
a token or injected body port, body sync fails closed rather than inventing a
second body implementation.

## Conflict Workflow

Conflicts are visible in the database file and through the CLI:

```sh
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" \
  "select conflict_id, page_id, property_id, state from conflicts;"

notion db conflicts list --sqlite "$PWD/notion-workspace/<database-id>.sqlite"
```

Resolve conflicts with explicit CLI commands. Do not update `_nds_*` tables or
`conflicts` rows directly.

## Backup And Copy

Use SQLite backup semantics for live databases:

```sh
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" "pragma wal_checkpoint(full);"
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" ".backup '$PWD/backup/<database-id>.sqlite'"
```

For offline copies, stop `sync --watch` first, then copy the SQLite database and any
remaining SQLite-managed `-wal`/`-shm` files.
