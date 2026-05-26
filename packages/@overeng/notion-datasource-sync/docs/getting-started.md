# Getting Started

`notion-datasource-sync` syncs a Notion data source with a local workspace. It
observes the data source schema, rows, selected row properties, row lifecycle
state, and row page bodies. It stores local truth in SQLite and materializes
workspace artifacts through the local workspace and NotionMD body ports.

## Credentials

Set the Notion token before running live commands:

```sh
export NOTION_API_TOKEN="secret_..."
```

The integration must have access to the data source and every related fixture
that should be observed. If a relation, rollup, person, or page property points
outside the integration's permissions, sync treats that surface as incomplete or
ambiguous.

## Bind A Data Source

Choose a stable local root id for the binding. It is a local partition key, not a
Notion id.

```sh
notion-datasource-sync init \
  --store .notion-datasource-sync/store.sqlite \
  --root-id workspace-main \
  --data-source-id 00000000000040008000000000000001 \
  --workspace-root "$PWD/notion-workspace"
```

`init` records the local binding. It does not make schema or row writes.

## Observe Remote State

```sh
notion-datasource-sync pull \
  --store .notion-datasource-sync/store.sqlite \
  --root-id workspace-main \
  --data-source-id 00000000000040008000000000000001 \
  --workspace-root "$PWD/notion-workspace"
```

Pull observes the data source and rows through the configured query contract,
records complete observations as events, updates projections, and materializes
local artifacts when enabled.

Use `status` or `doctor` to inspect the store without planning remote writes:

```sh
notion-datasource-sync status --store .notion-datasource-sync/store.sqlite --root-id workspace-main --data-source-id 00000000000040008000000000000001 --workspace-root "$PWD/notion-workspace"
notion-datasource-sync doctor --store .notion-datasource-sync/store.sqlite --root-id workspace-main --data-source-id 00000000000040008000000000000001 --workspace-root "$PWD/notion-workspace"
```

## Reconcile Local Changes

```sh
notion-datasource-sync sync \
  --store .notion-datasource-sync/store.sqlite \
  --root-id workspace-main \
  --data-source-id 00000000000040008000000000000001 \
  --workspace-root "$PWD/notion-workspace"
```

`sync` observes remote state, scans local artifacts, accepts safe local intents,
enqueues remote commands, executes bounded outbox steps, and verifies settlement.
Use `--dry-run` with `push`, `sync`, conflict resolution, `forget`, and
`restore` when you want to inspect planned local effects first.

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

The library exposes a real NotionMD-backed `PageBodySyncPort` for callers that
wire the body adapter explicitly. The standalone CLI defaults to an unsupported
body adapter and fails closed on body writes unless a runtime layer injects a
body port. Property and schema-only paths can still run without body writes.
