# Notion Datasource Sync Experiments

This file records evidence used by [spec.md](./spec.md). It is non-normative; the spec is the source of truth.

## Evidence Map

| Evidence      | Supports                                                                                                            | Remaining proof needed                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| E01, E10      | Data-source identity, direct page retrieval, tombstone classification, timestamp-as-wakeup                          | Automated live L6 regression tests for the observed trash, restore, move, and pagination behaviors                                |
| E02           | SQLite event log, projection rebuild, outbox settlement, path claims                                                | Crash-injection tests for interrupted migrations, remote-write-before-settlement, duplicate settlement, and checkpoint compaction |
| E03           | Narrow NotionMD body adapter boundary                                                                               | Live body pagination, truncation/unknown-block guards, and partial materialization cleanup                                        |
| E05, E07, E09 | Effect service ports, pure planner boundary, fake-service testability, conflict classification                      | Generated guard-to-test traceability that proves every guard has typed local coverage                                             |
| E06, E08      | Property-ID canonicalization and explicit schema migration guards                                                   | Live schema-write matrix for option rename/removal, type conversion impact reports, and read-after-write hash verification        |
| E11           | Local daemon model with overlap polling, leases, backpressure, and repair scans                                     | Executed L5/L7 daemon restart, cancellation, stuck-outbox, queue pressure, and soak tests                                         |
| E12           | Current Notion API compatibility risks for `2026-03-11`, query completeness, markdown guards, webhooks, and Workers | Automated fake-service coverage plus live smoke re-verification under the pinned API version                                      |

## E01 Live Notion Data-Source Behavior

**Hypothesis:** Data-source sync must use `data_source_id`, direct page retrieval, and overlap polling instead of relying on database identity or query results alone.

**Method:** Created temporary live data sources and rows in an isolated Notion workspace, then exercised schema retrieval, row query, page retrieval, property updates, body updates, trash, restore, and move behavior.

**Results:**

- Database containers and data sources are distinct; the data source is the schema/query boundary.
- Page `last_edited_time` was too coarse to be a complete conflict oracle.
- Body updates and property updates share page-level edit signals but are separate payload surfaces.
- Trashed rows disappear from data-source queries but remain directly retrievable with trash state.
- Moved-out rows disappear from the source query while direct retrieve reveals a parent change.
- Property rename preserves property ID and row values.

**Conclusion:** Query results and timestamps are invalidation signals. Correctness requires direct retrieval, stable property IDs, per-surface hashes, and tombstone classification.

## E02 SQLite Event Store

**Hypothesis:** SQLite can serve as the local sync control plane if events are append-only and projections are rebuildable.

**Method:** Built a local SQLite prototype with event IDs, projections for data sources/properties/rows/outbox/conflicts/path claims/tombstones, deterministic replay, and settlement handling.

**Results:**

- Event ID dedupe, deterministic replay digest, projection rebuild, conflict projection, first-settlement-wins, and path-claim release all worked locally.
- Outbox-as-projection kept network effects outside SQL transactions.

**Conclusion:** SQLite should be authoritative for local events, intents, outbox, conflicts, tombstones, leases, checkpoints, and migrations; projections remain disposable.

## E03 NotionMD Adapter

**Hypothesis:** Datasource sync can materialize row page bodies through public NotionMD APIs without becoming a NotionMD feature.

**Method:** Created a temporary live page, materialized it locally through NotionMD, edited the local `.nmd` body, pushed it back, verified clean status, and cleaned up.

**Results:**

- First-time materialization of an existing Notion page through public NotionMD sync APIs is viable.
- Body sync remains independently guarded and does not need to own row property state.
- Current public markdown endpoints expose `truncated` and `unknown_block_ids`; update operations have destructive and ambiguous modes that need explicit body guards before datasource sync treats them as safe writes.

**Conclusion:** Datasource sync should depend on a narrow `PageBodySyncPort`. NotionMD should implement that port and may expose a smaller materialization helper if useful.

## E04 Notion Workers

**Hypothesis:** Notion Workers sync might replace a local bidirectional sync daemon.

**Method:** Inspected and scaffolded the current Notion Workers sync model and compared it against the local SQLite control-plane requirements.

**Results:**

- Workers are useful for hosted external-source projections into Worker-managed Notion databases.
- Current Worker syncs create/manage their own sync databases and do not yet replace synchronization of arbitrary existing user data sources.
- The model does not replace local event replay, local filesystem integration, bidirectional conflict handling, or local daemon lease/outbox semantics.

**Conclusion:** Workers may become an optional integration or projection backend, but they must not be required for correctness.

## E05 API Shape Prototype

**Hypothesis:** The datasource-sync API can be expressed as Effect services with typed gateways, body adapter ports, sync store ports, commands, conflicts, and events.

**Method:** Built a local TypeScript prototype using Effect Schema and fake ports.

**Results:**

- Branded IDs, tagged events, command types, conflicts, `NotionDataSourceGateway`, `PageBodySyncPort`, and `SyncStore` composed cleanly.
- The planner/reconciler boundary stayed testable without network or filesystem effects.

**Conclusion:** The implementation should keep planning pure and inject Notion, body, filesystem, and SQLite effects through ports.

## E06 Schema Normalization

**Hypothesis:** Schema and row values can be canonicalized so renames are distinct from destructive changes.

**Method:** Normalized live schema artifacts by property ID and computed deterministic schema/value hashes.

**Results:**

- Property rename changed labels but preserved property identity.
- New properties received distinct IDs.
- Row property hashes were independent from display names.
- Body pointers could carry body hash, truncation, and unknown-block metadata.

**Conclusion:** Property IDs and canonical hashes are the correct identity layer for row/property sync.

## E07 Contract Testing

**Hypothesis:** Most sync behavior can be tested locally with fake gateways before live Notion tests.

**Method:** Built fake raw transport, normalized gateway, row planner, and fake body sync port tests.

**Results:**

- Fake-service integration caught planner and adapter behavior without live Notion.
- Live tests are still required for Notion API semantics such as trash, move, schema writes, and markdown behavior.

**Conclusion:** The test pyramid should put most coverage in L1-L5 and reserve live E2E for API truths.

## E08 Schema Writes

**Hypothesis:** Schema writes need explicit migration guards because Notion can lose or transform row values.

**Method:** Exercised live schema add, rename, delete, type conversion, and multi-select option changes against a temporary data source.

**Results:**

- Rename preserved row values.
- Delete made old values unavailable.
- Rich-text-to-number conversion preserved numeric-looking strings and nulled non-numeric strings.
- Multi-select option removal could drop selected row values.
- Fresh GET matched successful PATCH responses for tested writes.

**Conclusion:** Add/rename can be guarded writes. Delete, type conversion, and option deletion require explicit migration plans with value impact reports.

## E09 Conflict Classification

**Hypothesis:** Page-level timestamps are too coarse; conflicts should be classified by smaller sync surfaces.

**Method:** Built a local conflict-classifier prototype with representative same-surface and disjoint-surface scenarios.

**Results:**

- Disjoint property edits can auto-merge.
- Property-vs-body edits can auto-merge when hashes prove independence.
- Same-property, body-body, schema-affecting, delete-vs-edit, path-collision, unavailable relation, and lossy body scenarios require conflicts or guards.

**Conclusion:** Conflict records in SQLite are authoritative. CLI or file conflict views are projections.

## E10 Delete, Move, And Restore

**Hypothesis:** Query absence must be classified by direct page retrieval.

**Method:** Exercised live trash, restore, move out, and move back behavior for temporary row pages.

**Results:**

- Trashed rows disappeared from data-source query but direct retrieve showed trash state.
- Restore made rows queryable again.
- Move-out made rows disappear from the source query while direct retrieve showed a different parent.
- Move-back restored data-source property visibility.

**Conclusion:** Absence is only a candidate. Direct retrieval must classify trash, move, restore, inaccessible, or unknown before any local or remote destructive action.

## E11 Watch Daemon Sufficiency

**Hypothesis:** A local daemon is sufficient for initial watch mode if it uses conservative reconciliation.

**Method:** Designed and syntax-checked a daemon experiment using polling overlap, known-page scans, dedupe by materialized hash, tombstone classification, lease fencing, backpressure, and repair scans. Additional live mutations were blocked by current connection capabilities and were not broadened outside the allowed scope.

**Results:**

- Existing live observations support overlap polling and direct tombstone classification.
- Webhooks would not remove the need for reconciliation because Notion event delivery is not a durable ordered CDC stream.

**Conclusion:** Local daemon watch is sufficient for the initial package if implemented with overlap, dedupe, known-page verification, leases, backpressure, and repair scans.

## E12 Current Notion API Documentation Review

**Hypothesis:** The datasource-sync verification plan must track current public Notion API compatibility, not only earlier live observations.

**Method:** Reviewed Explorer D's current API research at `tmp/ds-sync-vrs-review/notion-current-api-review.md`, backed by official Notion documentation for versioning, data sources, page-property pagination, markdown endpoints, webhooks, request limits, and Workers syncs.

**Results:**

- The current API version to prove is `2026-03-11`; compatibility tests must catch `archived`/`in_trash`, `transcription`/`meeting_notes`, and block append `position` drift.
- Data-source queries are paginated and have a documented 10k result cap per query; incomplete or contract-changed scans cannot prove absence.
- Page retrieval can be incomplete for properties with many references; page-property pagination is required before canonical hashes for affected values.
- Markdown update endpoints expose truncation/unknown-block state and can fail or become unsafe for ambiguous replacements, child-page/database deletion, and synced pages.
- Connection webhooks are aggregated, unordered, potentially stale, and at-most-once signals; Workers syncs currently target Worker-managed databases and are not a correctness replacement for local reconciliation.

**Conclusion:** R67-R73 and the E2E plan should treat API version, capability preflight, decode drift, query completeness, page-property completeness, markdown update guards, webhook signal semantics, and Workers limitations as first-class verification surfaces.

## Unresolved Experiment Gaps

These are evidence gaps, not requirements. They should either become experiments before implementation depends on them, or remain blocked/unsupported states in the spec and tests.

| Gap                                            | Why it matters                                                                                                              | Current fallback                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Permission-restricted live fixtures            | Fake 403/404 tests cannot prove all workspace permission edge semantics                                                     | Treat ambiguous 403/404 as `PermissionAmbiguous` and fail closed                                  |
| Body truncation and unknown block reproduction | Body writes must block when NotionMD cannot round-trip a page safely                                                        | Fake adapter tests plus live coverage only when a reproducible fixture exists                     |
| File upload and replacement semantics          | Editable file support needs byte identity, expiry, and replacement proof                                                    | Observe file properties read-only; exclude signed URLs from durable identity                      |
| Relation target lifecycle                      | Inaccessible, moved, or deleted relation targets can look like dropped values                                               | Store target IDs plus availability state; block unsafe relation writes                            |
| Live daemon soak                               | The daemon model is designed but not yet exercised against repeated live mutations                                          | Keep daemon correctness gated by L5 locally and L7 manual/nightly before release                  |
| SQLite migration corpus                        | No historical package schema exists yet, but migrations need compatibility proof once schemas ship                          | Start the corpus with the first implemented store version and require upgrade fixtures thereafter |
| Notion verification lag after writes           | Immediate read-after-write may occasionally observe old remote state                                                        | Executor must treat mismatched verification as unsettled, not successful                          |
| API `2026-03-11` live re-verification          | Earlier live observations remain useful but need pinned-version regression proof                                            | Keep compatibility manifest blocked until fake-service coverage and live smoke pass               |
| Data-source query 10k cap                      | A cheap live fixture should not create 10k+ rows just to prove cap handling                                                 | Prove cap behavior in L2; reserve manual L6 for release-risk investigations                       |
| Page-property pagination live fixture          | Large relation/people/mention values can be cumbersome to create and clean up                                               | Prove full pagination in L2 and add one practical representative L6 fixture                       |
| Webhook signal delivery                        | Public docs describe unordered/stale/aggregated/at-most-once delivery, but live webhook tests need hosted callback plumbing | Test webhook inputs as fake/integration dirty hints; do not make webhooks a correctness gate      |
