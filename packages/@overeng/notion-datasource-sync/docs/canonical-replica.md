# Canonical SQLite Replica

Each established Notion database is represented by one self-contained SQLite
file:

```text
<workspace>/<database-id>.sqlite
```

The filename is the Notion database ID, not the database display name. This
keeps renames safe and lets one workspace hold multiple databases without a
shared store or name collision.

A database-ID-named file is always the full Notion database replica. Filtered
query contracts and subset membership are not product replica modes.

```sh
notion db sync --from-notion <data-source-id-or-database-url> ./workspace
sqlite3 ./workspace/<database-id>.sqlite
```

There is no required `.notion-datasource-sync/store.sqlite` or config sidecar.
The database file contains both the public local API and private sync state.

## Public Surfaces

`rows` is the primary writable API. User tools should read and mutate ordinary
Notion row state through `rows`; direct writes to lower-level implementation
tables are outside the product contract. `changes`, `conflicts`, and
`sync_status` are public observability surfaces for intent lifecycle, conflict
state, and health.

Stable public surfaces:

| Surface             | Access        | Purpose                                                                 |
| ------------------- | ------------- | ----------------------------------------------------------------------- |
| `rows`              | guarded write | One row per Notion page in the database                                 |
| `schema`            | read view     | Database/data-source binding, metadata, schema hashes, sync identity    |
| `schema_properties` | read view     | Property id, display name, Notion type, write class, row column mapping |
| `changes`           | read view     | Durable local edit intents and settlement status                        |
| `conflicts`         | read view     | User-visible conflicts and resolution state                             |
| `sync_status`       | read view     | Last sync, pending work, checkpoints, guards, doctor state              |

Debug surfaces are read-only views named `debug_*`. They expose canonical JSON,
hashes, pagination evidence, outbox state, and projection diagnostics for
operators.

Private tables and indexes are prefixed `_nds_`. They hold sync-control state:
events, projections, outbox, checkpoints, leases, hashes, migrations, and
integrity digests. Users and automation must not edit `_nds_*`. If private
state is corrupt, missing, or tampered with, `doctor` fails closed and sync
does not infer remote writes from public rows alone.

`sync` and `sync --watch` consume the same public SQLite CDC contract. A supported
`rows` edit must remain visible through `changes` until it is planned,
executed, verified, and settled; watch mode is not remote-only polling.

## Row Shape

`rows` matches live Notion properties by default. Establishment and subsequent
observations read the Notion schema, populate `schema_properties`, and generate
the property columns. A user-maintained schema JSON file is not part of the
normal workflow.

`rows` is shaped like the Notion database:

1. Notion properties appear first as ordinary columns.
2. System columns appear last and are prefixed with `_`.
3. Property identity is Notion's property ID, not the display name.
4. `schema_json` is not present in `rows`; inspect `schema` and
   `schema_properties`.

Example:

```text
rows(
  "Name",
  "Status",
  "Priority",
  "Due",
  _page_id,
  _database_id,
  _data_source_id,
  _in_trash,
  _properties_hash,
  _last_observed_at,
  _sync_status
)
```

Column names use the Notion property display name where possible. When names
collide or cannot be represented safely, the replica emits a stable escaped
column name and records the mapping in `schema_properties`.

Inspect the mapping before writing automation:

```sql
select column_name, property_id, property_name, property_type, write_class
from schema_properties
order by ordinal;
```

Inspect top-level identity and schema hashes:

```sql
select database_id, data_source_id, title_plain_text, schema_hash, metadata_hash
from schema;
```

## Reads

Read from `rows` for normal data work:

```sql
select _page_id, "Name", "Status", "Priority"
from rows
where coalesce(_in_trash, 0) = 0
order by "Priority", "Name"
limit 25;
```

Use `debug_*` views when you need lossless canonical Notion JSON, base hashes,
CDC status, outbox state, or pagination diagnostics.

## Direct Local Mutations

Supported scalar/current property edits are direct `UPDATE`s on `rows`; this is
the preferred write path for ordinary row data:

```sql
update rows
set "Status" = 'Done',
    "Priority" = 3
where _page_id = '11111111-1111-4111-8111-111111111111';
```

The replica validates that each target column maps to a writable Notion
property, converts the SQL value into canonical Notion property JSON, updates
local desired state, and records a durable row in `changes`. The SQL write does
not call Notion. Run:

```sh
notion db sync ./workspace --dry-run
notion db sync ./workspace
```

Supported scalar/property classes include title, rich text, number, checkbox,
date, select, multi-select, status, URL, email, and phone when the observed
schema supplies enough information to convert and verify the value. Relation
edits remain guarded by complete pagination and observed accessible targets.

## Inserts

Insert a new Notion row through `rows`:

```sql
insert into rows ("Name", "Status", "Priority")
values ('Draft migration checklist', 'Not started', 2);
```

The replica records a local row-create intent with an idempotency key, initial
property values, and the current base schema hash. The row appears locally as
pending until sync creates the Notion page and settles the returned remote page
ID.

## Archive And Restore

Archive and restore use `_in_trash`:

```sql
update rows
set _in_trash = 1
where _page_id = '11111111-1111-4111-8111-111111111111';

update rows
set _in_trash = 0
where _page_id = '11111111-1111-4111-8111-111111111111';
```

Repeated lifecycle toggles before sync use final-state semantics. For example,
`0 -> 1 -> 0` cancels or supersedes the pending archive intent instead of
replaying an intermediate trash command.

`DELETE FROM rows` is rejected. Destructive remote effects are explicit
lifecycle intents, not inferred from local SQL deletion or missing files.

## Backup And Copy

Use SQLite-safe copy semantics, not a plain copy of a live WAL-mode database.
Preferred options:

```sh
sqlite3 ./workspace/<database-id>.sqlite "pragma wal_checkpoint(full);"
sqlite3 ./workspace/<database-id>.sqlite ".backup './backup/<database-id>.sqlite'"
```

For offline copies, close `sync --watch` processes first, then copy the SQLite file
and any `-wal`/`-shm` files that still exist. The portable unit is the database
ID-named SQLite database and its SQLite-managed WAL state.

## Fail-Closed Cases

The replica rejects or marks unsupported any mutation it cannot prove safe:

- writes to computed/audit properties such as formula, rollup, created/edited
  fields, unique ID, or verification,
- writes to `_` system columns other than `_in_trash`,
- writes to `debug_*` views or `_nds_*` private tables,
- writes that cannot be converted to canonical Notion property values,
- stale base schema or row/property hashes,
- direct people edits without deterministic accessible user identity proof,
- direct file edits, replacement, deletion, signed Notion URL identity, or local
  upload execution outside explicit staged file support,
- relation additions when the base value is not fully paginated or the added
  target has not been observed as accessible,
- schema migrations from `rows`,
- Notion UI view writes from `rows`,
- ambiguous permission, pagination, API-version, or body-adapter states.

Unsupported cases remain visible through `changes`, `conflicts`, `sync_status`,
`debug_*` views, `status`, `doctor`, and conflict commands; they are not
silently coerced into empty values or best-effort Notion patches.
