# Supported Capabilities

This page describes the current package behavior, not every capability exposed
by the Notion API.

Follow-up work for feasible but unsupported surfaces is tracked in
[GitHub issue #698](https://github.com/overengineeringstudio/effect-utils/issues/698).

## Supported

| Surface                | Current behavior                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Data-source retrieve   | Reads schema, parent metadata, and supported property configs                                                               |
| Data-source query      | Cursor pagination for full database replica scans                                                                           |
| Page retrieve          | Reads row page lifecycle and property snapshots                                                                             |
| Page-property retrieve | Cursor pagination for truncated property-item values                                                                        |
| Property writes        | Guarded row property patches for modeled writable values                                                                    |
| Schema command writes  | Dedicated safe add/rename/add-option command path with base schema hash; public SQLite schema CDC remains fail-closed       |
| Data-source metadata   | Guarded title patches with a separate metadata hash                                                                         |
| Trash/restore          | Explicit command surface with outbox verification                                                                           |
| Body observation       | Via NotionMD-backed `PageBodySyncPort`                                                                                      |
| Body materialization   | `.nmd` files plus sidecar identity through the body port                                                                    |
| Body push              | Guarded NotionMD body push when local body path/content is available                                                        |
| Local workspace paths  | Claimed deterministic row paths with collision guards                                                                       |
| Daemon/watch           | Bounded daemon loop that processes local SQLite CDC plus remote polling, lease fencing, cancellation, restart coverage       |
| OpenTelemetry          | CLI, daemon, sync, gateway, planner, executor, and guard spans                                                              |
| Remote adoption        | `sync --from-notion` establishes a local workspace from an existing data source                                             |
| Local SQLite replica   | `<database-id>.sqlite` is the self-contained full-database public local read/write API and sync-state file                  |
| Local write intents    | `rows` edits are the primary write API and queue guarded intents before `sync` or `watch` applies them                      |

## Read-Only Or Guarded

| Surface                          | Policy                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Formula, rollup, created/edited  | Observed as computed; writes are rejected                                                                                                                                |
| Relation and rollup dependencies | Require shared related data sources/pages; otherwise incomplete/ambiguous                                                                                                |
| Files property                   | External URL attach uses explicit staging; direct cell edits and upload/download bytes are fail-closed                                                                   |
| Relation writes                  | Supported for remove/reorder/add from fully paginated bases when each added target is already observed in `debug_*` relation diagnostics; unobserved targets fail closed |
| People writes                    | Direct cell edits fail closed before visible mutation until deterministic accessible user identities and full paginated base values are proven                           |
| Notion-hosted signed URLs        | Excluded from stable hashes and diagnostics                                                                                                                              |
| Page-property rollup metadata    | Preserved in observation hashes without inflating relation item counts                                                                                                   |
| Data-source icon metadata        | Observed as stable identity when possible; writable icon sync is deferred                                                                                                |
| Query caps and internal filters  | Capped previews and internal filtered/debug scans do not establish replicas or classify row absence                                                                       |
| Canonical `rows`                 | Primary writable replica table for one data source; property columns first, `_` system columns last                                                                      |
| `schema` / `schema_properties`   | Read-only metadata and column/property mapping; `schema_json` is not embedded in `rows`                                                                                  |
| Local generated views            | Read-only debug views; writes go through `rows` or `changes`                                                                                                             |

## Unsupported Or Deferred

| Notion surface                           | Current policy                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data-source views                        | Read-only Notion UI view inventory is projected in `debug_*`; view writes and view-query membership authority are not synced                                   |
| Database metadata                        | Title/description CDC supported through `changes`; icon/cover/parent/trash/lock remain deferred                                                                |
| Data-source writable icons               | Deferred until file/custom/external icon identity has complete proof                                                                                           |
| Database/data-source presentation        | Layout, grouping, sorts, filters, hidden properties, and view settings are not synced                                                                          |
| File upload/download bytes               | Local-upload lifecycle fields are modeled through guarded `changes`, but upload execution remains fail-closed until retry/expiry/read-after-write proof exists |
| Destructive schema migrations            | Property delete, type conversion, option removal/rename are blocked                                                                                            |
| Status schema updates                    | Blocked until Notion behavior is proven for the desired operation                                                                                              |
| Comments                                 | Out of scope                                                                                                                                                   |
| Permissions/sharing                      | Out of scope; permission ambiguity blocks affected surfaces                                                                                                    |
| Webhooks                                 | Not required for correctness; daemon uses observation/reconciliation                                                                                           |
| Synced pages and unsupported body blocks | Delegated to NotionMD guards and blocked when lossy                                                                                                            |
| Local-first data-source creation         | Out of scope; create the data source in Notion first, then adopt it locally                                                                                    |
| Direct updates to generated SQL views    | Deferred; V1 writes use guarded `rows` updates or explicit `changes` rows                                                                                      |
| Broad schema migrations from SQL edits   | Deferred; schema drift is detected and guarded, rich migration workflows are follow-up                                                                         |

## Public Replica Write Coverage

All ordinary data edit use cases belong in the `<database-id>.sqlite` API, but each
class must have a typed intent and guard model before it mutates Notion.

| Edit class                      | Target state                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing row cell edits         | Supported primarily through scalar/property `UPDATE rows SET ...`; explicit `changes` rows are an advanced intent surface                          |
| Row creation                    | Supported through `INSERT INTO rows (...)` normalized to row-create CDC with idempotency keys, base schema guards, and returned page-id settlement |
| Row archive/restore             | Supported through `UPDATE rows SET _in_trash = 1/0` or explicit lifecycle CDC; never inferred from SQL delete                                      |
| Body edits                      | Supported through NotionMD-backed `changes` rows and body conflict guards                                                                          |
| Data-source metadata edits      | Supported through public metadata CDC for title/description, with owning-database patching and data-source metadata hash verification              |
| Database metadata edits         | Supported for title/description through `changes` with database authority                                                                          |
| External URL file attachments   | Supported through explicit `changes` staging for empty writable `files` properties                                                                 |
| Notion UI view inventory        | Supported as read-only `debug_*`; view query results are not row-membership authority and local generated SQL views are separate                   |
| People/file direct cell edits   | Fail closed before visible replica mutation; people requires deterministic user identity proof, files require explicit staging/upload lifecycle    |
| Safe schema changes             | Dedicated schema command path exists; public SQLite CDC remains blocked until post-write hash proof                                                |
| Rich/destructive schema changes | Follow-up migration workflows with impact reports and explicit approval                                                                            |
| File bytes/local uploads        | Explicit staging fields exist, but execution is blocked until File Upload identity, retry, read-after-write, and cleanup are proven                |
| Notion UI view writes           | `changes` can record typed requests, but create/update/delete stay blocked until stale-base, cleanup, and cache semantics are proven               |
| Row deletion                    | `DELETE FROM rows` is rejected; use `_in_trash` for archive/restore lifecycle intents                                                              |

## Capability Preflight

Before live sync or tests rely on a surface, preflight can require specific
capabilities:

```sh
notion-datasource-sync pull \
  "$PWD/notion-workspace/<database-id>.sqlite" \
  --required-capabilities data_source_query,page_retrieve,page_property_retrieve
```

Missing capabilities are configuration failures. They block planning before
remote mutation.
