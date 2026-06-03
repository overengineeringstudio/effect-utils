# Notion Datasource Sync Spec

This document is the top-level index for the Notion datasource sync system specification. Builds on [requirements.md](./requirements.md). Serves [vision.md](./vision.md).

## Status

Draft -- the sync-control layer, live Notion gateway, NotionMD body boundary,
remote adoption flow, guarded write model, and self-contained
`<database-id>.sqlite` replica contract exist. The canonical writable public
surface is `rows`; `changes`, `conflicts`, and `sync_status` expose user-action
state; `debug_*` views expose read-only diagnostics; `_nds_*` tables are private
sync-control state.

This spec is decomposed into per-subsystem slices under [`subsystems/`](./subsystems/). Each slice owns its own requirements, spec, and capability-gap content. This document keeps only the cross-cutting material that does not belong to any single sub-system.

## Sub-system Index

| Sub-system         | Spec                                            | Requirements                                                    |
| ------------------ | ----------------------------------------------- | --------------------------------------------------------------- |
| Domain Model       | [spec](./subsystems/domain-model/spec.md)       | [requirements](./subsystems/domain-model/requirements.md)       |
| Sync Store         | [spec](./subsystems/sync-store/spec.md)         | [requirements](./subsystems/sync-store/requirements.md)         |
| Notion Gateway     | [spec](./subsystems/notion-gateway/spec.md)     | [requirements](./subsystems/notion-gateway/requirements.md)     |
| Body Adapter       | [spec](./subsystems/body-adapter/spec.md)       | [requirements](./subsystems/body-adapter/requirements.md)       |
| Local Workspace    | [spec](./subsystems/local-workspace/spec.md)    | [requirements](./subsystems/local-workspace/requirements.md)    |
| Replica API        | [spec](./subsystems/replica-api/spec.md)        | [requirements](./subsystems/replica-api/requirements.md)        |
| Planner Guards     | [spec](./subsystems/planner-guards/spec.md)     | [requirements](./subsystems/planner-guards/requirements.md)     |
| Schema Migration   | [spec](./subsystems/schema-migration/spec.md)   | [requirements](./subsystems/schema-migration/requirements.md)   |
| Sync Orchestration | [spec](./subsystems/sync-orchestration/spec.md) | [requirements](./subsystems/sync-orchestration/requirements.md) |
| Watch Daemon       | [spec](./subsystems/watch-daemon/spec.md)       | [requirements](./subsystems/watch-daemon/requirements.md)       |
| CLI                | [spec](./subsystems/cli/spec.md)                | [requirements](./subsystems/cli/requirements.md)                |

## Scope

This top-level spec defines:

- the package shape across the Notion sync stack,
- the cross-cutting authority model that ties sub-systems together,
- the cross-cutting telemetry contract,
- the cross-cutting verification strategy,
- open design questions that cut across multiple sub-systems.

It does not define:

- SQLite store details, event families, projections, or outbox lifecycle -- see `subsystems/sync-store`,
- the public `<database-id>.sqlite` replica or write intent contract -- see `subsystems/replica-api`,
- the canonical domain model, hashers, and path semantics -- see `subsystems/domain-model` and `subsystems/local-workspace`,
- planner flow, guard matrix, delete/move/restore semantics -- see `subsystems/planner-guards`,
- schema-migration semantics -- see `subsystems/schema-migration`,
- body-adapter semantics -- see `subsystems/body-adapter`,
- watch-daemon loop, polling, leases -- see `subsystems/watch-daemon`,
- CLI command shape and structured output -- see `subsystems/cli`,
- remote query/property completeness and API version contract -- see `subsystems/notion-gateway`,
- fail-closed capability boundaries -- see [`capability-gaps.md`](./capability-gaps.md).

## Package Shape

```
@overeng/notion-core
  pure dependency-free Notion primitives, helpers, tuple builders,
  and classifiers

@overeng/notion-effect-schema
  Effect Schema wire schemas, decoders, encoders, schema transforms,
  and schema facades

@overeng/notion-effect-client
  versioned Notion HTTP API services, pagination, retries, rate limits,
  and API error mapping

@overeng/notion-md
  .nmd page-body adapter implementing PageBodySyncPort

@overeng/notion-datasource-sync
  data-source binding, canonical hashes, SQLite event log, projections,
  outbox, conflicts, leases, migrations, planner, daemon, CLI commands,
  Notion gateway adapter

@overeng/notion-cli
  raw/debug/schema/codegen commands and datasource-sync command surface
```

The exact package split may be staged. The current implementation keeps the
sync-core event store, projections, outbox, conflicts, leases, migrations, and
canonical datasource-sync hash helpers inside `@overeng/notion-datasource-sync`.
Their module boundaries must remain extractable.

Milestone 1 follows the Option B package boundary. `@overeng/notion-core` is the
target package for pure dependency-free Notion primitives, helpers, tuple
builders, and classifiers. It must not import Effect.
`@overeng/notion-effect-schema` owns Effect Schema wire schemas and schema
facades. `@overeng/notion-effect-client` owns the HTTP API service boundary.
`.nmd` contracts do not move into `@overeng/notion-core` in this milestone;
page-body sync remains behind the NotionMD body boundary. Canonical codecs do
not move yet; their current ownership remains staged until a later extraction.
Datasource sync must not depend on private NotionMD internals.

## Authority Model

The authority model is cross-cutting: it pins down which surface owns truth for which fact, so sub-systems can be designed independently without inventing competing sources of truth. The per-sub-system specs deepen each row below.

| Surface                       | Authoritative source                                          | Local representation                               | Write rule                                    |
| ----------------------------- | ------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| Current remote schema         | Notion after observation                                      | `schema_projection`                                | Re-read before schema-affecting writes        |
| Current remote row properties | Notion after observation                                      | `row_projection`, `property_shadow`                | Re-read relevant row/properties before writes |
| Current remote page body      | NotionMD remote observation                                   | `body_pointer`                                     | Delegate body guards to `PageBodySyncPort`    |
| Local page-body desired state | NotionMD `.nmd` capture before materialize                    | body local-observation / body intent / conflict    | Preserve before overwrite; plan via body port |
| Public local replica          | Derived from sync-control events                              | `<database-id>.sqlite` public surfaces             | User reads current state and writes intents   |
| Local sync intent             | Entry: `rows`; ledger: `changes`; authority: SQLite event log | `changes`, `sync_event`, `outbox`                  | Commit intent before command execution        |
| Conflicts                     | SQLite event log/projection                                   | `conflict_projection`                              | Resolve by appending events                   |
| Tombstones                    | SQLite event log/projection                                   | `tombstone_projection`                             | Create only after direct classification       |
| File paths                    | SQLite path claims + filesystem                               | `path_claim_projection`                            | Never overwrite another page claim            |
| API/capability contract       | Notion client + live preflight                                | `api_contract_projection`, `capability_projection` | Block unsupported version/capability drift    |
| Query completeness            | Notion query pages after complete scan                        | `query_scan_checkpoint`                            | Advance only after terminal page              |
| Watch ownership               | SQLite lease                                                  | `lease_projection`                                 | Fence stale daemons                           |

Local authority has three invariants that apply across every sub-system:

| Invariant              | Enforcement                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| Intent-before-effect   | A local edit becomes accepted only when its `LocalIntentAccepted` event commits. |
| Effect-after-outbox    | Network writes execute only from committed outbox commands.                      |
| Projection-from-events | Public rows/debug views are derived from private events and can be rebuilt.      |

## Telemetry

Requirement trace: R52, R57-R59, R67-R73.

All spans use safe, low-cardinality names, concise `span.label` values, and an allowlist of attributes. The CLI process uses `service.name=notion-datasource-sync-cli`; `sync --watch` mode uses `service.name=notion-datasource-sync-daemon`.

| Span                                           | Required attributes                                                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notion.datasource.cli`                        | span.label, command, process.role, root_id, data_source_id, dry_run, max_cycles, status.state, result                                                                                                                                       |
| `notion.datasource.sync.init`                  | span.label, process.role, operation, root_id, data_source_id, dry_run                                                                                                                                                                       |
| `notion.datasource.sync.pull`                  | span.label, process.role, operation, root_id, data_source_id, dry_run, query_complete, query_page_count, row_count, event_count, appended_events, status.state                                                                              |
| `notion.datasource.sync.establish-from-notion` | span.label, process.role, operation, root_id, data_source_id, dry_run, query_complete, row_count, appended_events, status.state                                                                                                             |
| `notion.datasource.sync.push`                  | span.label, process.role, operation, root_id, dry_run, max_executor_steps, lease_duration_ms, local_observation_count, enqueued_commands, executor_steps, status.state                                                                      |
| `notion.datasource.sync.one-shot`              | span.label, process.role, operation, root_id, data_source_id, max_executor_steps, lease_duration_ms, query_complete, row_count, enqueued_commands, executor_steps, status.state                                                             |
| `notion.datasource.observation.remote`         | span.label, process.role, operation                                                                                                                                                                                                         |
| `notion.datasource.observation.local`          | span.label, process.role, operation                                                                                                                                                                                                         |
| `notion.datasource.daemon.run`                 | span.label, process.role, operation, root_id, data_source_id, mode, max_cycles, cycles, completed_cycles, cancelled, result                                                                                                                 |
| `notion.datasource.daemon.pass`                | span.label, process.role, operation, root_id, data_source_id, mode, cycle, max_executor_steps, lease_duration_ms, result                                                                                                                    |
| `notion.datasource.sqlite.transaction`         | operation, event_count, projection_version                                                                                                                                                                                                  |
| `notion.datasource.planner.decision`           | surface_kind, decision, guard, query_contract_hash                                                                                                                                                                                          |
| `notion.datasource.outbox.attempt`             | span.label, process.role, operation, root_id, command_id, command_kind, page_id, data_source_id, attempt, result, guard, settlement_kind, lease_duration_ms                                                                                 |
| `notion.datasource.outbox.observe-surface`     | span.label, process.role, operation, command_id, command_kind, page_id, data_source_id                                                                                                                                                      |
| `notion.datasource.outbox.write-remote`        | span.label, process.role, operation, command_id, command_kind, page_id, data_source_id                                                                                                                                                      |
| `notion.datasource.conflict`                   | conflict_kind, surface_kind, result                                                                                                                                                                                                         |
| `notion.datasource.migration`                  | migration_kind, from_version, to_version, result                                                                                                                                                                                            |
| `NotionHttp.<METHOD>`                          | span.label, notion.http.method, notion.http.route, notion.http.operation, notion.http.status_code, notion.http.retry.attempts, notion.http.retry.delay_ms, notion.quota.cost, notion.rate_limit.remaining, notion.rate_limit.reset_after_ms |
| `notion.api.request`                           | span.label, process.role, operation, api_version, data_source_id, page_id, property_id, command_id, command_kind                                                                                                                            |
| `notion.datasource.fake-gateway.request`       | span.label, process.role, operation, api_version, data_source_id, page_id                                                                                                                                                                   |

Telemetry never includes raw page titles, private workspace names, full body text, raw property values, tokens, signed URLs, or local absolute paths. Notion HTTP spans use route templates such as `/data_sources/{data_source_id}/query` instead of raw URLs. IDs exposed in datasource spans are hashed unless they are already intended as non-sensitive command IDs.

## Verification

Requirement trace: XC-R04, VERIFY-R01-VERIFY-R09.

The authoritative verification contract is:

- pure unit tests for canonicalization, planners, guards, and conflict classifiers,
- Effect integration tests against fake Notion, fake body adapter, and fake filesystem services,
- SQLite integration tests for replay, crash recovery, migrations, outbox, and leases,
- replica integration tests for `<database-id>.sqlite` `rows`/`schema`/`schema_properties`/`changes`/`conflicts`/`sync_status`, read-only `debug_*` views, write intents, rebuild, and public/private boundary enforcement,
- filesystem tests for local paths, sidecars, object storage, and deletion semantics,
- daemon tests for local and remote event coalescing,
- live Notion tests for API semantics, capability preflight, current API-version behavior, and completeness boundaries that cannot be proven locally.
- credential-free readiness tests for live-lane scaffolding, including cleanup ledger replay/resume and scenario metadata traceability, so fixture hygiene can be proven without Notion credentials.

### Canonical Synthetic Live Workspace

Live verification uses a canonical synthetic workspace with three zones. Stable
Notion IDs for these zones are configuration/environment inputs and must not be
committed. A fixture may be documented in this public repository only when it is
deliberately synthetic and carries no private workspace, page, row, or body
content.

| Zone              | Purpose                                                                                  | Mutation policy                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Durable read-only | Stable data-source and page shapes for downsync, large dry-runs, and regression sampling | Runtime tests may observe only; before/after Notion reads prove sampled rows and bodies are unchanged.                              |
| Scratch nursery   | Disposable pages/data sources/rows for live write proof                                  | Runtime tests may mutate only run-created fixtures or explicitly allowlisted scratch page IDs.                                      |
| Ledger page       | Human-visible sanitized run status and cleanup evidence                                  | Harness appends or replaces only its marked ledger block; whole-page replacement is allowed only when the harness created the page. |

The provisioner lane is explicit and separate from runtime verification. It
creates or repairs the synthetic workspace, rotates stable fixture IDs, marks
deliberately public synthetic fixtures, and emits the environment/config values
used by the other lanes. Runtime live lanes fail closed when required zone IDs,
markers, or allowlists are missing.

Every live write lane carries a write allowlist derived from the scratch
nursery fixture ledger and the scenario input. Notion writes, SQLite writes, body
materialization, cleanup, archive/restore, and ledger publication must be
checked against that allowlist before execution. The remote mutation ledger is
part of the assertion surface: a correct final state does not pass if any
non-allowlisted page, data source, block, or ledger region was targeted.

Public-repository leak guard applies to all live evidence. Logs, fixtures,
scenario metadata, issues, PRs, and docs may include sanitized counts,
synthetic fixture labels, scenario IDs, and public issue numbers; they must not
include private page/database IDs, tokens, signed URLs, raw private bodies, or
private workspace names.

`src/e2e/realistic-workflows.e2e.test.ts` is the credential-free realistic workflow slice. It composes the fake gateway, SQLite store, one-shot sync, body port, and workspace ports to prove initial materialization/idempotency, remote drift plus local write, pending-intent conflict durability, fail-closed capability/schema drift, and local filesystem delete/repair behavior. This slice does not replace L6 live Notion proof for API semantics or the broader daemon and platform filesystem suites.

Replica E2E must prove:

- establishment without schema JSON creates `<workspace>/<database-id>.sqlite` and projects observed rows/schema/metadata,
- `rows`, `schema_properties`, `changes`, `conflicts`, `sync_status`, and `debug_*` views agree for sampled rows,
- `rows` property columns are generated from live schema before `_` columns and never include `schema_json`,
- local SQL insert/update/archive/restore through `rows` produces planner commands in dry-run without settling the public change,
- `DELETE FROM rows` is rejected and never becomes Archive, Forget, or permanent deletion,
- normal sync applies supported intents to disposable fake/live remotes and settles after read-after-write,
- stale base hashes become conflicts rather than overwrites,
- schema drift affecting a pending intent is guarded before apply,
- public table/view rebuild from private `_nds_*` state is deterministic,
- real user database tests remain read-only/downsync and prove representative Notion rows are unchanged.

Bidirectional safety scenarios are typed in `src/testing/bidi-safety.ts`. This
matrix is the acceptance surface for data-loss and liveness risks that span
multiple subsystems:

| Scenario                                              | Tier    | Risk             | Required proof                                                                                     |
| ----------------------------------------------------- | ------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `NDS-L4-bidi-clean-outbound-after-remote-observation` | replica | false conflict   | clean observations advance local bases unless an unresolved local intent pins the property surface |
| `NDS-L4-bidi-same-property-race-conflict`             | replica | lost update      | same-property races open durable conflicts and issue no stale remote patch                         |
| `NDS-L4-bidi-disjoint-property-merge`                 | replica | lost update      | disjoint local and remote property edits merge without rollback                                    |
| `NDS-L4-bidi-archive-edit-race`                       | replica | silent delete    | lifecycle/edit races fail closed and never infer remote trash from ambiguity                       |
| `NDS-L6-bidi-body-local-capture-first`                | live    | local overwrite  | established `sync` captures changed `.nmd` before remote body materialization can overwrite it     |
| `NDS-L5-bidi-watermark-boundary-overlap`              | daemon  | missed inbound   | incremental polling drains whole `last_edited_time` boundary buckets before checkpoint advance     |
| `NDS-L5-bidi-incremental-absence-not-tombstone`       | daemon  | silent delete    | high-watermark omissions create no absence or tombstone evidence                                   |
| `NDS-L5-bidi-relation-pagination-scoped-block`        | daemon  | global wedge     | incomplete property pagination blocks the affected property, not the whole root                    |
| `NDS-L3-bidi-ambiguous-write-idempotency`             | fake    | duplicate write  | ambiguous retries reconcile by observation without duplicate remote mutation                       |
| `NDS-L4-bidi-conflict-resolution-lifecycle`           | replica | stale projection | supported resolutions retire active local changes while preserving audit history                   |
| `NDS-L4-bidi-rebuild-replay-safety`                   | replica | stale projection | replay preserves tombstones, conflicts, terminal changes, and pinned property bases                |
| `NDS-L5-bidi-local-first-slow-pull`                   | daemon  | stale projection | eligible local CDC is pushed before slow remote pull completion                                    |
| `NDS-L5-bidi-inline-hydration-correctness`            | daemon  | missed inbound   | inline query-row values preserve hashes and avoid unnecessary per-row page reads                   |
| `NDS-L6-live-workspace-provisioner-lane`              | live    | user data loss   | provisioner owns canonical synthetic workspace creation/repair and never commits stable IDs        |
| `NDS-L6-live-workspace-read-only-downsync`            | live    | user data loss   | live test workspace rows are observed/downsynced without unintended Notion mutation                |
| `NDS-L6-live-workspace-scratch-row-bidi`              | live    | user data loss   | one allowlisted scratch row proves SQLite property, `.nmd` body, and lifecycle bidi behavior       |

Each scenario must assert the remote mutation ledger, private store, public
replica, and rebuild/replay behavior where durable state changes. An apparently
correct final state is not enough if an unsafe local overwrite or remote
mutation was attempted.

Live workspace runtime verification has two non-provisioner modes. Read-only
downsync samples non-scratch rows in the durable read-only zone, records
`page_id`, `last_edited_time`, `in_trash`, and selected stable properties, runs
the read-only/downsync command path, then proves those rows are unchanged by
direct Notion reads and an empty mutation ledger. This is the #715 large
replica/readiness lane when run at production-sized cardinality. Scratch-row
bidi verification creates or uses exactly one row whose title contains a unique
run marker in the scratch nursery; the harness records its `page_id`, scopes
every SQL write with `WHERE _page_id = <scratchPageId>`, allowlists only that
`page_id` for Notion writes, snapshots non-scratch rows before/after, and fails
if any non-scratch sampled row changes. This is the #717 live bidi/body
settlement lane. Live workspace tests must never run broad `UPDATE rows`, broad
`DELETE`, archive, restore, body materialization, or cleanup against existing
non-scratch rows.

Live write lanes use an append-only cleanup ledger as their readiness boundary.
Each disposable fixture object records its latest lifecycle and cleanup state.
Resume logic replays the ledger, ignores objects whose latest state is
`verified-cleaned`, retries unverified or `cleanup-failed` objects, and appends
the resumed cleanup result. The replay/resume algorithm is tested locally with
injected cleanup callbacks; live Notion tests are reserved for API semantics and
real fixture archive/restore behavior.

No-data-loss acceptance requires established `sync`, `push`, and `sync --watch`
to capture SQLite `rows`/`changes` and `.nmd` bodies before local
materialization that could overwrite them; accepted local intent must be visible
in `changes` and backed by private `_nds_*` events; malformed or unsupported
writes must fail atomically; remote writes must execute only from committed
outbox commands after fresh preflight reads and settle only after
read-after-write verification; `.nmd` materialization may write only when the
target is unchanged from captured base or was this process's own
materialization; changed, uncaptured, ambiguous, or path-colliding bodies must
be preserved as conflict/repair material; and rebuild/replay must preserve
pending intents, conflicts, tombstones, settlements, hashes, public visibility,
and recoverable conflict material.

## Design Questions

- **DQ1 Connection webhooks:** Hosted Notion connection webhooks may feed dirty entity hints into daemon intake. Because delivery is at-most-once, aggregated, unordered, and possibly stale, every hint must be followed by fresh API reads before planning.
- **DQ2 Workers:** Notion Workers syncs are optional Notion-hosted external-source projections. Current Worker syncs create and manage Worker-owned databases and do not replace arbitrary existing datasource sync, local filesystem reconciliation, SQLite authority, or outbox settlement.
- **DQ3 Package split staging:** The sync-core store/planner/replica layers currently live inside `@overeng/notion-datasource-sync`. They may remain there if APIs stay separated and extractable. Open design work remains for whether additional shared Notion identity, property capability, block support, and transport contracts should move upstream into `@overeng/notion-effect-schema` and `@overeng/notion-effect-client`.
- **DQ4 File upload support:** Observed Notion file URLs are temporary references. Editable file-byte sync may use durable File Upload API IDs only after additional live E2E proof for upload, expiry, and replacement behavior.
- **DQ5 Writable debug views:** Direct SQL `UPDATE`/`INSERT`/`DELETE` against `debug_*` views may later be implemented with triggers that insert the same typed intent rows that feed `changes`. The current public API supports guarded writes through canonical `rows`; `changes` remains a read-only ledger so write semantics stay visible and testable.
