# Supported Capabilities

This page describes the current package behavior, not every capability exposed
by the Notion API.

Follow-up work for feasible but unsupported surfaces is tracked in
[GitHub issue #698](https://github.com/overengineeringstudio/effect-utils/issues/698).

## Supported

| Surface                | Current behavior                                                                |
| ---------------------- | ------------------------------------------------------------------------------- |
| Data-source retrieve   | Reads schema, parent metadata, and supported property configs                   |
| Data-source query      | Cursor pagination with canonical filter/sort/high-watermark contract            |
| Page retrieve          | Reads row page lifecycle and property snapshots                                 |
| Page-property retrieve | Cursor pagination for truncated property-item values                            |
| Property writes        | Guarded row property patches for modeled writable values                        |
| Schema writes          | Safe add/rename/add-option subset with base schema hash                         |
| Data-source metadata   | Guarded title/description patches with a separate metadata hash                 |
| Trash/restore          | Explicit command surface with outbox verification                               |
| Body observation       | Via NotionMD-backed `PageBodySyncPort`                                          |
| Body materialization   | `.nmd` files plus sidecar identity through the body port                        |
| Body push              | Guarded NotionMD body push when local body path/content is available            |
| Local workspace paths  | Claimed deterministic row paths with collision guards                           |
| Daemon/watch           | Bounded daemon loop, lease fencing, cancellation, restart coverage              |
| OpenTelemetry          | CLI, daemon, sync, gateway, planner, executor, and guard spans                  |
| Remote adoption        | `sync --from-notion` establishes a local workspace from an existing data source |
| Local SQLite replica   | `notion.sqlite` is the public local read/write API for adopted data sources     |
| Local write intents    | User edits are queued as guarded intents before CLI sync applies them           |

## Read-Only Or Guarded

| Surface                          | Policy                                                                     |
| -------------------------------- | -------------------------------------------------------------------------- |
| Formula, rollup, created/edited  | Observed as computed; writes are rejected                                  |
| Relation and rollup dependencies | Require shared related data sources/pages; otherwise incomplete/ambiguous  |
| Files property                   | Metadata can be represented; upload/download byte lifecycle is unsupported |
| People property                  | Safe only when the integration can observe stable people values            |
| Notion-hosted signed URLs        | Excluded from stable hashes and diagnostics                                |
| Page-property rollup metadata    | Preserved in observation hashes without inflating relation item counts     |
| Data-source icon metadata        | Observed as stable identity when possible; writable icon sync is deferred  |
| Filtered query membership        | Does not classify row absence outside the explicit query contract          |
| Local generated views            | Read-only convenience views; writable cells/rows queue guarded intents through public tables |

## Unsupported Or Deferred

| Notion surface                           | Current policy                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Data-source views                        | Not synced; views are a separate Notion surface and not local authority               |
| Data-source writable icons               | Deferred until file/custom/external icon identity has complete proof                  |
| Database/data-source presentation        | Layout, grouping, sorts, filters, hidden properties, and view settings are not synced |
| File upload/download bytes               | Deferred; file identity remains fail-closed when bytes matter                         |
| Destructive schema migrations            | Property delete, type conversion, option removal/rename are blocked                   |
| Status schema updates                    | Blocked until Notion behavior is proven for the desired operation                     |
| Comments                                 | Out of scope                                                                          |
| Permissions/sharing                      | Out of scope; permission ambiguity blocks affected surfaces                           |
| Webhooks                                 | Not required for correctness; daemon uses observation/reconciliation                  |
| Synced pages and unsupported body blocks | Delegated to NotionMD guards and blocked when lossy                                   |
| Local-first data-source creation         | Out of scope; create the data source in Notion first, then adopt it locally           |
| Direct updates to generated SQL views    | Deferred; V1 writes use explicit `notion_local_changes` intents                       |
| Broad schema migrations from SQL edits   | Deferred; schema drift is detected and guarded, rich migration workflows are follow-up |

## Public Replica Write Coverage

All ordinary data edit use cases belong in the `notion.sqlite` API, but each
class must have a typed intent and guard model before it mutates Notion.

| Edit class                     | Target state                                                              |
| ------------------------------ | ------------------------------------------------------------------------- |
| Existing row cell edits        | Supported through `notion_cells.value_json` updates or explicit `cell_patch` intents with base hashes |
| Row creation                   | In scope through explicit `create_row` intents and read-after-write proof  |
| Row archive/restore            | In scope through explicit lifecycle intents; never inferred from SQL delete |
| Body edits                     | In scope through NotionMD-backed body intents and body conflict guards     |
| Data-source metadata edits     | In scope through metadata intents with separate metadata hash              |
| Safe schema changes            | In scope through guarded schema intents for proven additive/non-destructive operations |
| Rich/destructive schema changes | Follow-up migration workflows with impact reports and explicit approval    |
| File bytes                     | Follow-up until File Upload identity and cleanup are modeled               |

## Capability Preflight

Before live sync or tests rely on a surface, preflight can require specific
capabilities:

```sh
notion-datasource-sync pull \
  --store .notion-datasource-sync/store.sqlite \
  --root-id workspace-main \
  --data-source-id 00000000000040008000000000000001 \
  --workspace-root "$PWD/notion-workspace" \
  --required-capabilities data_source_query,page_retrieve,page_property_retrieve
```

Missing capabilities are configuration failures. They block planning before
remote mutation.
