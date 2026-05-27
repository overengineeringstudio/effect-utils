# @overeng/notion-datasource-sync

Local-first sync engine for Notion data sources.

It binds one Notion data source to a local workspace, observes schema, rows,
row properties, lifecycle state, and row page bodies, then plans guarded writes
through an event log and outbox. Page bodies are delegated to the public
`@overeng/notion-md` adapter boundary.

## Docs

- [Getting Started](./docs/getting-started.md)
- [CLI Reference](./docs/cli.md)
- [Sync Safety](./docs/sync-safety.md)
- [Supported Capabilities](./docs/capabilities.md)
- [Testing And Demo](./docs/testing.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [VRS](./docs/vrs/spec.md)

## Status

The package is still pre-release. The core sync model, planner, SQLite store,
fake gateway, live gateway, filesystem workspace, NotionMD body boundary, CLI
surface, daemon loop, and E2E harness exist. Unsupported or unproven Notion
surfaces fail closed instead of being silently dropped.

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

The sync-first form writes `.notion-datasource-sync/config.json` under the
workspace root, with the local SQLite store at
`.notion-datasource-sync/store.sqlite`. First establishment is remote-to-local
only: it validates the existing Notion data source, records the binding, pulls
remote state, and does not scan local artifacts or push remote writes. Database
URLs resolve to a single child data source; ambiguous multi-source databases
require an explicit data-source id. `--limit` gives large databases a bounded
no-write dry-run preview, not a partial adoption. `pull` and `push` stay
available for advanced CI/debug workflows.

The live CLI reads `NOTION_API_TOKEN` and accepts `NOTION_TOKEN` as a legacy
fallback. When a live token is configured, the CLI wires the NotionMD-backed
body adapter; without a token or injected body port, body sync fails closed.

## Safety Model

- Remote state is observed before unsafe writes.
- Local intent is committed to SQLite before remote effects.
- Remote effects execute from the outbox and settle only after verification.
- Query cursors, high-watermarks, and page-property pagination are part of the
  observation contract.
- Body, schema, data-source metadata, properties, lifecycle, path claims, and conflict state are
  separate surfaces.
- Unsupported schema changes, computed properties, incomplete paginated values,
  file bytes, views, and unproven metadata writes block instead of degrading
  data.

## Demo

The automated live showcase is documented in [demo/README.md](./demo/README.md).
It refreshes a dedicated Notion page with multiple realistic data sources,
including a 500-row activity source for high-cardinality observation.
