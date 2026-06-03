# Troubleshooting

## Missing Token

Symptom:

```json
{
  "_tag": "CliErrorEnvelope",
  "error": {
    "_tag": "NotionGatewayError",
    "message": "Missing Notion API token for the live CLI gateway"
  }
}
```

Fix:

```sh
export NOTION_API_TOKEN="secret_..."
```

Use a token whose integration has access to the target data source, parent page,
related data sources, and row pages you expect to sync.

## Page Or Data Source Not Found

Notion often returns similar failures for missing objects and objects outside the
integration's permissions. Share the data source and relevant parent pages with
the integration. For relation and rollup tests, also share the related source.

## Database File Missing

Symptom:

```json
{
  "_tag": "CliErrorEnvelope",
  "error": {
    "_tag": "CliArgumentError",
    "message": "Missing datasource-sync database file"
  }
}
```

Fix:

```sh
notion db sync --from-notion <data-source-id-or-database-url> "$PWD/notion-workspace"
```

`sync <workspace-root>` only works after establishment has written
`<workspace-root>/<database-id>.sqlite`.

## Which SQLite File Should I Open?

Open the database-ID-named replica:

```sh
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite"
```

There is no required `.notion-datasource-sync/store.sqlite` local database. Each
`<database-id>.sqlite` file contains public tables, read-only `debug_*` views,
and private `_nds_*` sync state. User tools must not patch `_nds_*`.

## Database URL Is Ambiguous

`sync --from-notion <database-url>` resolves the database to its child data
source only when Notion reports exactly one child data source. If the database
has multiple data sources, rerun with the explicit data-source id. For large
databases, start with `--dry-run --limit <rows>` to avoid an expensive full
preview.

## Workspace Binding Mismatch

If the SQLite filename, public `schema` binding, or private `_nds_*` binding
points at a different database/data source, `sync <workspace-root>` fails
closed. Do not edit private tables manually. Establish a fresh workspace or use
`doctor <workspace>/<database-id>.sqlite` to inspect the mismatch.

## Local Edit Does Not Reach Notion

Local scalar edits should update `rows`; the replica resolves the
`schema_properties` mapping and queues public entries in `changes`. `debug_*`
views remain read-only, `_nds_*` tables are private, and `DELETE FROM rows` is
not a writable API.

Check pending intents:

```sh
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" \
  "select change_id, page_id, property_id, status, unsupported_reason from changes;"
```

Then run:

```sh
notion db sync "$PWD/notion-workspace" --dry-run
notion db sync "$PWD/notion-workspace"
```

If the dry-run reports a stale base, read-only property, unsupported property
type, incomplete relation/rollup, or schema drift, the intent is guarded instead
of applied.

## Body Sync Fails In The CLI

The live CLI needs a Notion token so it can wire the NotionMD adapter layer.
Without a token or injected `PageBodySyncPort`, body sync fails closed.

Library callers can inject the NotionMD-backed `PageBodySyncPort`. For CLI-only
work, use property/schema/status flows or run tests that explicitly provide the
body adapter.

## Query Scan Does Not Mark Rows Missing

Rows are not considered absent unless the full database scan completes. Check:

- pagination reached the terminal page,
- the query did not hit a cap,
- the command was not a dry-run preview with `--limit`.

Filtered/query-contract scans are not a product replica mode. They do not prove
absence from a full database and must not create database-ID-named SQLite files.

## Property Value Is Incomplete

Some page properties are truncated in normal page retrieval and require
page-property pagination. If pagination fails, relation targets are unshared, or
rollup metadata cannot be preserved, the value stays guarded and is not hashed as
clean.

Fix the missing permission or rerun after the transient failure is gone. Do not
patch `_nds_*` manually.

## Schema Write Is Blocked

Safe schema writes require an expected base schema hash and one of the supported
operations:

- add property,
- rename property,
- add select options,
- add multi-select options.

Property deletion, type conversion, option removal/rename, status schema edits,
and automatic broad convergence are intentionally blocked.

Schema drift is still observed. Pending local row/cell intents that depend on a
changed property config are guarded or converted into conflicts. Rich schema
migration workflows are tracked as follow-up work rather than inferred from
ordinary local SQL edits.

## Conflict Appears In The Replica

Inspect conflicts in the database file:

```sh
sqlite3 "$PWD/notion-workspace/<database-id>.sqlite" \
  "select conflict_id, page_id, property_id, state from conflicts;"
```

Use `conflicts list` and `conflicts resolve` to act on them. Do not update
`conflicts` rows or private `_nds_*` conflict state directly; resolution must
append explicit events so replay and audit stay correct.

## Outbox Command Is Ambiguous

If a process stops after a remote attempt but before settlement, the next run
must observe the remote state before deciding whether the command succeeded,
should retry, or needs user action.

Run:

```sh
notion db doctor --sqlite "$PWD/notion-workspace/<database-id>.sqlite"
notion db conflicts list --sqlite "$PWD/notion-workspace/<database-id>.sqlite"
```

## Live E2E Leaves Fixtures Behind

The live harness records every created object in a local `tmp/` ledger and, when
configured, publishes a sanitized visible ledger page. Rerun the live suite with
the same scratch parent so cleanup can archive stale fixtures. If cleanup still
fails, inspect the ledger for object ids and verify the integration still has
access to the parent.
