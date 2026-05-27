# Supported Capabilities

This page describes the current package behavior, not every capability exposed
by the Notion API.

Follow-up work for feasible but unsupported surfaces is tracked in
[GitHub issue #698](https://github.com/overengineeringstudio/effect-utils/issues/698).

## Supported

| Surface                | Current behavior                                                     |
| ---------------------- | -------------------------------------------------------------------- |
| Data-source retrieve   | Reads schema, parent metadata, and supported property configs        |
| Data-source query      | Cursor pagination with canonical filter/sort/high-watermark contract |
| Page retrieve          | Reads row page lifecycle and property snapshots                      |
| Page-property retrieve | Cursor pagination for truncated property-item values                 |
| Property writes        | Guarded row property patches for modeled writable values             |
| Schema writes          | Safe add/rename/add-option subset with base schema hash              |
| Data-source metadata   | Guarded title/description patches with a separate metadata hash      |
| Trash/restore          | Explicit command surface with outbox verification                    |
| Body observation       | Via NotionMD-backed `PageBodySyncPort`                               |
| Body materialization   | `.nmd` files plus sidecar identity through the body port             |
| Body push              | Guarded NotionMD body push when local body path/content is available |
| Local workspace paths  | Claimed deterministic row paths with collision guards                |
| Daemon/watch           | Bounded daemon loop, lease fencing, cancellation, restart coverage   |
| OpenTelemetry          | CLI, daemon, sync, gateway, planner, executor, and guard spans       |

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
