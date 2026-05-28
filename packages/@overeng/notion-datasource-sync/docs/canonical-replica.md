# Canonical SQLite Replica

`notion.sqlite` is a 1:1 local replica artifact for one primary Notion data
source by default. The default user experience is:

```sh
notion-datasource-sync sync --from-notion <data-source-id-or-database-url> ./workspace
sqlite3 ./workspace/notion.sqlite
```

The resulting `./workspace/notion.sqlite` is the file users query and edit. The
internal `.notion-datasource-sync/store.sqlite` remains the correctness,
debugging, outbox, CDC, conflict, and rebuild layer; it is not the local data
API.

## Public Surfaces

The canonical writable surface is `rows`.

| Surface             | Access        | Purpose                                                                 |
| ------------------- | ------------- | ----------------------------------------------------------------------- |
| `rows`              | guarded write | One row per Notion page in the primary data source                      |
| `schema`            | read view     | Data-source metadata, schema hash, and top-level replica binding facts  |
| `schema_properties` | read view     | Property id, display name, Notion type, write class, and row column map |

Normalized tables, typed CDC tables, local-change projections, conflict rows,
outbox state, and generated debug views remain available as implementation and
debug surfaces. They are the layer that makes `rows` safe: direct mutations on
`rows` are translated to typed intents, validated, planned, verified, and then
settled through normal sync.

## Row Shape

`rows` is shaped like the primary Notion data source:

1. Notion properties appear first as ordinary columns.
2. System columns appear last and are prefixed with `_`.
3. Property identity is still Notion's property id, not the display name.
4. `schema_json` is not present in `rows`; inspect schema through `schema` and
   `schema_properties`.

Example:

```text
rows(
  "Name",
  "Status",
  "Priority",
  "Due",
  _page_id,
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

Inspect top-level replica identity and schema hashes:

```sql
select data_source_id, title_plain_text, schema_hash, metadata_hash
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

Use the normalized/debug layer when you need lossless canonical Notion JSON,
base hashes, CDC status, or conflict diagnostics.

## Updates

Supported scalar/current property edits are direct `UPDATE`s on `rows`:

```sql
update rows
set "Status" = 'Done',
    "Priority" = 3
where _page_id = '11111111-1111-4111-8111-111111111111';
```

The replica validates that each target column maps to a writable Notion
property, converts the SQL value into canonical Notion property JSON, updates
the local desired state, and records typed CDC for guarded sync. The SQL write
does not call Notion. Run:

```sh
notion-datasource-sync sync ./workspace --dry-run
notion-datasource-sync sync ./workspace
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
id.

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

## Fail-Closed Cases

The replica rejects or marks unsupported any mutation it cannot prove safe:

- writes to computed/audit properties such as formula, rollup, created/edited
  fields, unique ID, or verification,
- writes to `_` system columns other than `_in_trash`,
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

Unsupported cases remain visible in the CDC/debug layer and through `status`,
`doctor`, and conflict commands; they are not silently coerced into empty values
or best-effort Notion patches.
