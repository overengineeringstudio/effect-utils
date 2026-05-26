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

## Body Sync Fails In The CLI

The standalone CLI defaults to an unsupported body adapter. This is intentional:
body writes need the NotionMD adapter layer so datasource sync does not invent a
second body-sync implementation.

Library callers can inject the NotionMD-backed `PageBodySyncPort`. For CLI-only
work, use property/schema/status flows or run tests that explicitly provide the
body adapter.

## Query Scan Does Not Mark Rows Missing

Rows are not considered absent unless the scan is complete for the exact query
contract. Check:

- pagination reached the terminal page,
- the filter/sort/page size/high-watermark did not change,
- the query did not hit a cap,
- the membership scope matches the intended workspace.

Filtered queries track the filtered membership only. They do not prove absence
from the full data source.

## Property Value Is Incomplete

Some page properties are truncated in normal page retrieval and require
page-property pagination. If pagination fails, relation targets are unshared, or
rollup metadata cannot be preserved, the value stays guarded and is not hashed as
clean.

Fix the missing permission or rerun after the transient failure is gone. Do not
patch the store manually.

## Schema Write Is Blocked

Safe schema writes require an expected base schema hash and one of the supported
operations:

- add property,
- rename property,
- add select options,
- add multi-select options.

Property deletion, type conversion, option removal/rename, status schema edits,
and automatic broad convergence are intentionally blocked.

## Outbox Command Is Ambiguous

If a process stops after a remote attempt but before settlement, the next run
must observe the remote state before deciding whether the command succeeded,
should retry, or needs user action.

Run:

```sh
notion-datasource-sync doctor --store .notion-datasource-sync/store.sqlite --root-id workspace-main --data-source-id <id> --workspace-root "$PWD/notion-workspace"
notion-datasource-sync conflicts list --store .notion-datasource-sync/store.sqlite --root-id workspace-main --data-source-id <id> --workspace-root "$PWD/notion-workspace"
```

## Live E2E Leaves Fixtures Behind

The live harness records every created object in a local `tmp/` ledger and, when
configured, publishes a sanitized visible ledger page. Rerun the live suite with
the same scratch parent so cleanup can archive stale fixtures. If cleanup still
fails, inspect the ledger for object ids and verify the integration still has
access to the parent.
