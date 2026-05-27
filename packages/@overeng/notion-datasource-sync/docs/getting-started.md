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

## Establish A Workspace

Start from an existing Notion data source:

```sh
notion-datasource-sync sync --from-notion \
  00000000000040008000000000000001 \
  "$PWD/notion-workspace"
```

This creates `.notion-datasource-sync/config.json` and
`.notion-datasource-sync/store.sqlite` under the workspace root, validates the
Notion data source, records the local binding, pulls remote schema/metadata/rows,
and materializes row body artifacts when body materialization is enabled.

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

Use `--no-materialize-bodies` when you want schema/metadata/row adoption without
local body files:

```sh
notion-datasource-sync sync --from-notion 00000000000040008000000000000001 "$PWD/notion-workspace" --no-materialize-bodies
```

## Reconcile Local Changes

```sh
notion-datasource-sync sync "$PWD/notion-workspace"
```

Established `sync` reads the workspace config, observes remote state, scans local
artifacts, accepts safe local intents, enqueues remote commands, executes bounded
outbox steps, and verifies settlement. Use `sync "$PWD/notion-workspace"
--dry-run` to observe and plan without appending events, executing the outbox, or
materializing bodies.

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
