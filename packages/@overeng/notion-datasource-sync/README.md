# @overeng/notion-datasource-sync

Local-first SQLite replica for Notion data sources.

It binds one Notion data source to a local workspace, creates a user-facing
`<database-id>.sqlite` replica, observes schema, rows, row properties, lifecycle
state, and row page bodies, then applies local SQLite write intents through
guarded CLI sync. Page bodies are delegated to the public `@overeng/notion-md`
adapter boundary.

## Docs

- [Getting Started](./docs/getting-started.md)
- [Canonical SQLite Replica](./docs/canonical-replica.md)
- [CLI Reference](./docs/cli.md)
- [Sync Safety](./docs/sync-safety.md)
- [Supported Capabilities](./docs/capabilities.md)
- [Testing And Demo](./docs/testing.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [VRS](./docs/vrs/spec.md)

## Status

The package is still pre-release. The core sync model, planner, internal SQLite
control tables, fake gateway, live gateway, filesystem workspace, NotionMD body
boundary, CLI surface, daemon loop, and E2E harness exist. The default public
UX is one self-contained SQLite file per Notion database:
`<workspace>/<database-id>.sqlite`. The filename uses the Notion database ID,
not the display name. Its canonical writable surface is `rows`; `changes`,
`conflicts`, and `sync_status` expose user-action state; `debug_*` views expose
read-only diagnostics; `_nds_*` tables are private sync state. Unsupported or
unproven Notion surfaces fail closed instead of being silently dropped.

## Local Files

```text
<workspace-root>/
  <database-id>.sqlite
  <another-database-id>.sqlite
```

Use each `<database-id>.sqlite` file for local reads, data edits, and sync
state for that Notion database. The file is self-contained: no
`.notion-datasource-sync/store.sqlite` or config sidecar is required state.
Tables prefixed `_nds_` are private internal sync state for event log,
projections, outbox, checkpoints, hashes, and migrations. Users must not edit
them; `doctor` fails closed when private state is corrupt or tampered with.

Each database file exposes `rows` as the ordinary data table. Notion properties
are first-class columns, `_` system columns come last, and `schema_json` is not
part of `rows`. Those columns are generated from live Notion schema observation
by default; user schema JSON is not part of normal establishment or sync.
Inspect `schema` for the replica binding and `schema_properties` for the
property-id to row-column mapping.

The stable public surfaces are `rows`, `schema`, `schema_properties`,
`changes`, `conflicts`, and `sync_status`. Supported local `UPDATE`, `INSERT`,
and archive/restore edits on `rows` record durable entries in `changes`; they do
not call Notion until CLI sync plans, applies, and verifies them. Unsupported
or stale public edits fail closed before remote mutation. Internal edits to
`_nds_*` and writes to `debug_*` views are unsupported; if detected, `doctor`
reports the database as unsafe instead of inferring remote writes.

## CLI Shape

```sh
notion db sync --from-notion <data-source-id-or-database-url> "$PWD/notion-workspace"
notion db sync --from-notion <database-url> "$PWD/notion-workspace" --dry-run --limit 25
notion db sync "$PWD/notion-workspace"
notion db sync --watch "$PWD/notion-workspace"
notion db status "$PWD/notion-workspace"

sqlite3 "$PWD/notion-workspace/<database-id>.sqlite"
notion db doctor --sqlite "$PWD/notion-workspace/<database-id>.sqlite"
```

The sync-first form writes `<workspace>/<database-id>.sqlite`. First
establishment is remote-to-local only: it validates the existing Notion
database/data source, records the binding inside the same SQLite file, pulls
remote state, projects it into public tables, and does not scan local write
intents or push remote writes. Database URLs resolve to the database's data
source when unambiguous; ambiguous multi-source databases require an explicit
data-source id. `--limit` gives large databases a bounded no-write dry-run
preview, not a partial adoption.

Normal product sync always creates full replicas. Query-contract or filtered
membership sync is not a CLI mode, and `<database-id>.sqlite` files must not be
created for subsets of a Notion database.

The live CLI reads `NOTION_API_TOKEN` and accepts `NOTION_TOKEN` as a legacy
fallback. When a live token is configured, the CLI wires the NotionMD-backed
body adapter; without a token or injected body port, body sync fails closed.

## Safety Model

- Remote state is observed before unsafe writes.
- User edits are written to the database file's public `changes` table before
  remote effects.
- Accepted local intent is committed to private `_nds_*` event/outbox state
  before remote effects.
- Remote effects execute from the outbox and settle only after verification.
- `<database-id>.sqlite` is the portable unit of local state for one Notion
  database.
- Query cursors, high-watermarks, and page-property pagination are part of the
  observation contract.
- Body, schema, data-source metadata, properties, lifecycle, path claims, and
  conflict state are separate surfaces.
- Unsupported schema changes, computed properties, incomplete paginated values,
  file bytes, views, and unproven metadata writes block instead of degrading
  data.

## Demo

The automated live showcase is documented in [demo/README.md](./demo/README.md).
The package records the durable online demo mapping in `src/demo/live-demo.ts`
and verifies it with a credentialed read-only E2E lane. The verifier treats each
live data source as its own `<database-id>.sqlite` replica artifact and keeps the
500-row activity source as an explicit full-replica opt-in.
