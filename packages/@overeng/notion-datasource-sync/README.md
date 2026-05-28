# @overeng/notion-datasource-sync

Local-first SQLite replica for Notion data sources.

It binds one Notion data source to a local workspace, creates a user-facing
`notion.sqlite` replica, observes schema, rows, row properties, lifecycle state,
and row page bodies, then applies local SQLite write intents through guarded CLI
sync. Page bodies are delegated to the public `@overeng/notion-md` adapter
boundary.

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
control store, fake gateway, live gateway, filesystem workspace, NotionMD body
boundary, CLI surface, daemon loop, and E2E harness exist. The default public
UX is one user-facing `notion.sqlite` file mapped to one primary Notion data
source. Its canonical writable surface is `rows`; normalized tables and typed
CDC/outbox projections remain the correctness and debugging layer. Unsupported
or unproven Notion surfaces fail closed instead of being silently dropped.

## Local Files

```text
<workspace-root>/
  notion.sqlite
  .notion-datasource-sync/
    config.json
    store.sqlite
```

Use `notion.sqlite` for local reads and data edits. Treat
`.notion-datasource-sync/store.sqlite` as internal sync-control state: event
log, projections, outbox, conflicts, checkpoints, hashes, and migrations.
Editing the internal store is unsupported.

`notion.sqlite` exposes `rows` as the ordinary data table. Notion properties are
first-class columns, `_` system columns come last, and `schema_json` is not part
of `rows`. Those columns are generated from live Notion schema observation by
default; user schema JSON is not part of normal establishment or sync. Inspect
`schema` for the replica binding and `schema_properties` for the property-id to
row-column mapping. Local `SELECT`, supported scalar
`UPDATE`, `INSERT`, and archive/restore via `_in_trash` are translated into
guarded typed CDC and planned through the same outbox verification path; `DELETE
FROM rows` is rejected rather than interpreted as remote deletion.

The normalized implementation layer remains available for diagnostics:
`notion_data_sources`, `notion_databases`, `notion_views`, `notion_properties`,
`notion_rows`, `notion_cells`, `notion_bodies`, typed CDC tables,
`notion_local_changes`, `notion_conflicts`, and `notion_sync_status`. These
tables carry canonical JSON, hashes, statuses, conflict state, and settlement
evidence. External URL file attachments, relation writes from complete bases,
metadata CDC, body CDC, and conflict resolution are represented there. Public
schema CDC, local file uploads/file bytes, people writes, Notion view writes,
and destructive schema migrations remain explicit fail-closed surfaces until
their verified post-write reconciliation is modeled.

## CLI Shape

```sh
notion-datasource-sync sync --from-notion <data-source-id-or-database-url> "$PWD/notion-workspace"
notion-datasource-sync sync --from-notion <database-url> "$PWD/notion-workspace" --dry-run --limit 25
notion-datasource-sync sync "$PWD/notion-workspace"
notion-datasource-sync status "$PWD/notion-workspace"

notion-datasource-sync pull --store ... --root-id ... --data-source-id ... --workspace-root ...
notion-datasource-sync push --store ... --root-id ... --data-source-id ... --workspace-root ...
notion-datasource-sync watch --state .notion-datasource-sync/watch.json --store ... --root-id ... --data-source-id ... --workspace-root ...
notion-datasource-sync doctor --store ... --root-id ... --data-source-id ... --workspace-root ...
```

The sync-first form writes `.notion-datasource-sync/config.json`, the internal
control store, and the user-facing `notion.sqlite` replica under the workspace
root. First establishment is remote-to-local only: it validates the existing
Notion data source, records the binding, pulls remote state into the internal
store, projects it into `notion.sqlite`, and does not scan local write intents
or push remote writes. Database URLs resolve to a single child data source;
ambiguous multi-source databases require an explicit data-source id. `--limit`
gives large databases a bounded no-write dry-run preview, not a partial
adoption. `pull` and `push` stay available for advanced CI/debug workflows.

The live CLI reads `NOTION_API_TOKEN` and accepts `NOTION_TOKEN` as a legacy
fallback. When a live token is configured, the CLI wires the NotionMD-backed
body adapter; without a token or injected body port, body sync fails closed.

## Safety Model

- Remote state is observed before unsafe writes.
- User edits are written to `notion.sqlite` intent tables before remote effects.
- Accepted local intent is committed to the internal event log before remote
  effects.
- Remote effects execute from the outbox and settle only after verification.
- `notion.sqlite` is rebuildable from the internal store and is never the only
  copy of accepted intent/conflict state.
- Query cursors, high-watermarks, and page-property pagination are part of the
  observation contract.
- Body, schema, data-source metadata, properties, lifecycle, path claims, and
  conflict state are separate surfaces.
- Unsupported schema changes, computed properties, incomplete paginated values,
  file bytes, views, and unproven metadata writes block instead of degrading
  data.

## Demo

The automated live showcase is documented in [demo/README.md](./demo/README.md).
It refreshes a dedicated Notion page with multiple realistic data sources and
treats each one as its own 1:1 `notion.sqlite` replica artifact, including a
500-row activity source for high-cardinality observation.
