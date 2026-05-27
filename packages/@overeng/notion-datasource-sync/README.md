# @overeng/notion-datasource-sync

Local-first SQLite replica for Notion data sources.

It binds one Notion data source to a local workspace, creates a user-facing
`notion.sqlite` replica, observes schema, rows, row properties, lifecycle state,
and row page bodies, then applies local SQLite write intents through guarded CLI
sync. Page bodies are delegated to the public `@overeng/notion-md` adapter
boundary.

## Docs

- [Getting Started](./docs/getting-started.md)
- [CLI Reference](./docs/cli.md)
- [Sync Safety](./docs/sync-safety.md)
- [Supported Capabilities](./docs/capabilities.md)
- [Testing And Demo](./docs/testing.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [VRS](./docs/vrs/spec.md)

## Status

The package is still pre-release. The core sync model, planner, internal SQLite
control store, fake gateway, live gateway, filesystem workspace, NotionMD body
boundary, CLI surface, daemon loop, and E2E harness exist. The public
`notion.sqlite` replica/API is the intended user surface and is being layered on
top of the control store. Unsupported or unproven Notion surfaces fail closed
instead of being silently dropped.

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

`notion.sqlite` exposes stable public tables such as `notion_data_sources`,
`notion_databases`,
`notion_properties`, `notion_rows`, `notion_cells`, `notion_bodies`,
`notion_cell_changes`, `notion_row_changes`, `notion_row_creates`,
`notion_rows_effective`, `notion_cells_effective`, `notion_body_changes`,
`notion_metadata_changes`, `notion_schema_changes`,
`notion_conflict_resolutions`, `notion_local_changes`, `notion_conflicts`, and
`notion_sync_status`, plus generated read views for
adopted data sources. Local data edits are inserted as guarded typed CDC rows;
direct current-state edits use final-state semantics, so repeated edits to the
same cell or row lifecycle target supersede earlier pending direct changes.
`notion_local_changes` mirrors typed rows as a compatibility projection. `sync`
validates those typed changes, performs a dry-run/reviewable plan when
requested, and applies supported writes to Notion only after base-hash guards
pass. After non-dry-run sync, typed CDC rows are settled from actual planner and
outbox state instead of from conversion alone. Row creation uses explicit
`notion_row_creates` rows with local client request keys and returned
`remote_page_id` settlement; direct inserts into `notion_rows` are blocked
because that table is confirmed remote-observed state. Data-source and database
metadata CDC can patch title/description with post-write metadata hash
verification. Public schema CDC, file bytes, Notion views, and
destructive schema migrations remain explicit fail-closed surfaces until their
verified post-write reconciliation is modeled.

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
It refreshes a dedicated Notion page with multiple realistic data sources,
including a 500-row activity source for high-cardinality observation.
