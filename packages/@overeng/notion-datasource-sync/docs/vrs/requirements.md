# Notion Datasource Sync Requirements

## Context

These requirements serve [vision.md](./vision.md). They define the production constraints for a standalone Notion data-source sync primitive that composes with the existing Notion packages in `effect-utils`.

## Assumptions

- **A01 Data-source boundary:** Notion data sources are the schema and row-query boundary. Databases are containers and must not be treated as the table identity.
- **A02 Notion signal model:** Notion queries, page timestamps, webhooks, and workers are invalidation or projection mechanisms, not durable ordered change streams.
- **A03 Body adapter:** `@overeng/notion-md` owns `.nmd` page-body materialization and guarded body pushes.
- **A04 Effect runtime:** Implementation uses Effect services, Effect Schema, typed errors, scoped resources, and Effect CLI conventions.
- **A05 Local daemon scope:** Initial watch mode is a local daemon. Hosted webhooks and Notion Workers may feed the same reconciliation queues later but are not required for correctness; provider flags must report explicit running/degraded status instead of silently becoming dead flags.
- **A06 SQLite control plane:** Internal sync-control state uses SQLite as the durable event log, outbox, projection, conflict, tombstone, lease, checkpoint, and migration store.
- **A07 Live verification:** Claims about Notion behavior require representative live E2E tests in an isolated temporary Notion workspace.
- **A08 Notion drift:** Notion API behavior, connection capabilities, and workspace permissions may differ by API version, workspace, and integration configuration.
- **A09 Local replica:** The user-facing local data API is a separate SQLite replica file, not the internal sync-control store.

## Acceptable Tradeoffs

- **T01 Conservative writes:** The system may block writes that are probably safe when it cannot prove they preserve remote and local state.
- **T02 Store complexity:** SQLite introduces migrations and operational complexity because replayability, crash recovery, and auditability are required.
- **T03 Polling first:** Local daemon polling is acceptable before webhook support if overlap windows, dedupe, repair scans, and direct tombstone verification are implemented.
- **T04 Explicit schema migration:** Schema writes may require a migration document or command even when a single Notion API call could apply the change.
- **T05 Typed unsupported states:** Unsupported Notion features may be preserved, blocked, or surfaced as conflicts before they become first-class editable local shapes.
- **T06 Live test cost:** Live E2E tests may be slower and require secrets because mocks cannot prove Notion API edge semantics.
- **T07 Version conservatism:** The system may require an explicit compatibility update before accepting changed Notion API shapes or newly available capabilities.
- **T08 Intent-first writes:** The user-facing SQLite API may require explicit write-intent rows before writable SQL views exist, because every local edit needs reviewable guards, dry-run behavior, and conflict detection.

## Requirements

### Must Preserve Layer Boundaries

- **R01 Standalone package:** Datasource sync must be implemented as a standalone package, not as a built-in `@overeng/notion-md` feature.
- **R02 Body adapter boundary:** Page bodies must sync through a `PageBodySyncPort` so `@overeng/notion-md` can be used without datasource-sync owning body internals.
- **R03 Client boundary:** Raw Notion HTTP access must remain in the API-client layer; datasource-sync consumes typed gateway services.
- **R04 Domain boundary:** Data-source, row, schema, property, body-pointer, file, conflict, and outbox concepts must have domain types independent from local file layout.
- **R05 Data-source identity:** Sync identity must use stable `data_source_id` values for table membership and schema decisions.

### Must Maintain A Durable Local Control Plane

- **R06 SQLite authority:** SQLite must be the authoritative local source for events, accepted local intent, outbox lifecycle, conflicts, tombstones, path claims, leases, checkpoints, and migrations.
- **R07 Append-only events:** Domain history must be recorded as versioned append-only events with payload hashes and idempotency keys.
- **R08 Deterministic projections:** Projections must be rebuildable from events and produce deterministic digests for the same event history.
- **R09 Durable local intent:** A local edit is considered accepted only after its intent event commits.
- **R10 Network isolation:** Network writes must never run inside SQLite transactions.
- **R11 Outbox settlement:** Remote command settlement must be idempotent; the first verified settlement wins and later retries must not corrupt projections.
- **R12 Store migrations:** SQLite schema migrations must be versioned, testable, forward-only, and able to preserve replayability.
- **R13 Raw retention:** Raw Notion payload retention must be opt-in or TTL-bound and must exclude credentials, full private bodies, and signed file URLs from logs.

### Must Model Notion State By Stable Semantics

- **R14 Property IDs:** Data-source properties must be keyed by Notion property ID. Display names are labels and may change.
- **R15 Schema hash:** Schema projections must hash property IDs, property types, and type configuration; display names must not be the row-value identity.
- **R16 Row value hash:** Row property values must have stable canonical hashes independent from JSON field ordering and display-name changes.
- **R17 Body pointer:** A row page body must be represented as a pointer to body sync state, not flattened into row properties.
- **R18 Computed properties:** Formula, rollup, created-time, created-by, last-edited-time, last-edited-by, unique-id, and other computed/system properties must be read-only locally; attempted local writes must be rejected before enqueueing remote commands.
- **R19 Relation references:** Relations must store target page IDs and availability state so inaccessible targets cannot be silently dropped.
- **R20 File references:** File and media properties must preserve stable metadata and availability while treating expiring Notion URLs as observation artifacts, not durable identifiers.

### Must Plan And Apply Writes Safely

- **R21 Surface bases:** Every local write must reference the last-clean base hash for the smallest relevant surface.
- **R22 Timestamp role:** Page `last_edited_time` must be treated as a wake-up signal only, not as a complete conflict oracle.
- **R23 Preflight reread:** Remote writes must re-read the current remote surface and schema before applying when the command can conflict or destroy data.
- **R24 Read-after-write:** Successful remote writes must be verified by a fresh read and canonical hash comparison before settlement.
- **R25 No silent LWW:** Last-writer-wins must not be the default behavior for any bidirectional surface.
- **R26 Disjoint merge:** Proven disjoint local and remote edits must merge automatically at property/body/schema sub-surface granularity.
- **R27 Conflict records:** Same-surface edits, delete-vs-edit, schema drift affecting edited fields, body truncation, path collisions, and unavailable relations must create durable conflict records.
- **R28 Conflict resolution:** Conflict resolution must append events and commands; conflict rows must not be mutated as hidden state.
- **R29 Unsupported guard:** Unknown, truncated, unsupported, or lossy payloads must block automatic writes to affected surfaces.

### Must Handle Schema Changes Explicitly

- **R30 Observe schema drift:** Remote schema drift must update schema projections and reclassify pending local intents before any write.
- **R31 Additive schema writes:** Property adds and non-destructive metadata updates may be automated only after schema preflight and read-after-write verification.
- **R32 Rename semantics:** Renames must preserve property ID identity and row values.
- **R33 Destructive schema writes:** Property deletion, type conversion, and option deletion must require an explicit migration plan.
- **R34 Conversion reporting:** Type conversions must report potentially lossy value mappings before execution.
- **R35 Option deletion guard:** Select and multi-select option deletion must detect rows that would lose selected values.

### Must Classify Deletes, Moves, And Absence

- **R36 Query absence:** Absence from a data-source query is never sufficient evidence for deletion.
- **R37 Direct classifier:** Candidate absence must be classified by direct page retrieval as trashed, restored, moved out, moved between tracked sources, inaccessible, or unknown.
- **R38 Two-phase local delete:** Local file deletion may create a pending remote-trash intent only when sidecar state and SQLite row identity prove the target.
- **R39 Forget operation:** Removing local sync records must be a distinct explicit `forget` operation and must not imply a remote delete.
- **R40 Restore operation:** Remote and local restore must be first-class operations that clear tombstones only after observation.
- **R41 Permission ambiguity:** Permission loss, restricted objects, missing write capability, and unknown 404/403 states must fail closed instead of deleting, forgetting, or mutating data.

### Must Provide Reliable Watch Mode

- **R42 Local daemon:** `sync --watch` must run a local daemon with the same planner and guards used by one-shot commands.
- **R43 Poll overlap:** Remote polling must query from the latest complete checkpoint high-watermark with an inclusive overlap window and dedupe by materialized hashes.
- **R44 Known-page scan:** The daemon must maintain and periodically verify the known-page set with a complete full-membership scan so query absence can become a tombstone candidate.
- **R45 Backpressure:** The daemon must bound queues, honor Notion rate limits, and surface stuck commands.
- **R46 Lease fencing:** Only one logical writer may settle commands for a sync root at a time; stale leases must be fenced.
- **R47 Repair scans:** Periodic repair scans must detect missed events, projection drift, orphaned files, unresolved tombstone candidates, and any drift hidden by incremental polling windows.
- **R47a Local-first push latency:** When local SQLite CDC or runnable outbox work exists, watch mode must plan and attempt guarded outbound work without waiting for a full remote pull. Remote preflight and read-after-write guards still apply.
- **R47b Incremental absence safety:** High-watermark, filtered, capped, interrupted, or partial query results must not create disappearance or tombstone candidates. Only complete full-membership scans can provide query-absence evidence.
- **R47c Query payload hydration:** If the data-source query payload contains the complete row property values needed for hashing, observation must use those inline values and avoid per-row page retrieval. It may fall back to page retrieval only when inline payloads are missing or incomplete.

### Must Expose Operable Tools

- **R48 CLI commands:** The package must provide CLI commands for init, pull, status, push, sync, `sync --watch`, conflicts, migrate, doctor, repair, forget, and restore. There is no standalone user-facing `watch` command.
- **R49 Dry-run plans:** Mutating commands must support dry-run output that shows planned events, conflicts, outbox commands, and guard failures.
- **R50 Machine output:** CLI output must support structured machine-readable mode for CI and agent workflows.
- **R51 Human diagnostics:** CLI output must provide concise human-readable explanations for conflicts, blocked guards, retries, tombstones, and migrations.
- **R52 Secret safety:** CLI, telemetry, fixtures, and errors must never print tokens, signed URLs, full private document bodies, or private workspace identifiers.

### Must Compose With The Notion Library Stack

- **R53 Shared schemas:** Wire schemas and canonicalizers must be reusable by datasource-sync, NotionMD, Notion React, and CLI tooling.
- **R54 Gateway ports:** Datasource sync must depend on typed ports for Notion data sources, pages, page bodies, files, and local storage.
- **R55 Adapter independence:** Alternative body adapters or local storage adapters must be possible without changing the sync planner.
- **R56 Worker/webhook optionality:** Notion Workers and webhooks may provide optional invalidation/projection inputs but must not replace local reconciliation or SQLite authority. `sync --watch --webhook manual|tailscale` must start a local receiver, enqueue durable SQLite signals, wake the daemon after successful enqueue, and continue polling in degraded provider mode unless the user requested `--webhook-required`.

### Must Be Observable

- **R57 Span coverage:** Every CLI command, daemon pass, Notion API request, SQLite transaction, planner decision, outbox attempt, conflict decision, migration, and destructive operation must emit useful spans.
- **R58 Trace attributes:** Spans must include concise labels plus data-source, row, property, command, conflict, surface, operation, result, and Notion request identifiers when available.
- **R59 Safe telemetry:** Telemetry must not include credentials, full document bodies, raw private payloads, or signed file URLs.

### Must Be Verifiable End To End

- **R60 Unit coverage:** Canonicalization, schema hashing, row hashing, planners, conflict classification, and guard decisions must have deterministic unit tests.
- **R61 Fake-service integration:** Sync flows must have Effect integration tests against fake Notion gateways, fake body adapters, and fake filesystem/storage services.
- **R62 SQLite replay coverage:** Event replay, projection rebuild, migration, crash recovery, outbox idempotency, and lease fencing must be covered by SQLite integration tests.
- **R63 Filesystem coverage:** Path claims, local edits, local deletes, sidecar damage, object store repair, and workspace scans must be tested against a real local filesystem.
- **R64 Daemon coverage:** `sync --watch` mode must be tested for polling overlap, local file events, restart recovery, queue backpressure, cancellation, and stale lease behavior.
- **R64a Incremental sync coverage:** Watch tests must cover checkpoint reuse, same-boundary overlap, incremental absence safety, inline query-row hydration, local-first outbound work, and periodic full-reconcile behavior.
- **R65 Live Notion coverage:** Supported Notion API semantics must have isolated live E2E coverage with creation, mutation, verification, and cleanup.
- **R66 Guard matrix:** Every problematic edge case must map to a named guard, expected behavior, and at least one unit, fake integration, SQLite, filesystem, daemon, or live E2E test.

### Must Handle Notion API And Capability Drift

- **R67 Explicit API version:** Every Notion request must be tied to an explicit Notion API version, and diagnostics must report the version used for observed behavior.
- **R68 Decode drift guard:** Unknown or changed Notion payload shapes for supported surfaces must produce typed unsupported-state guards without corrupting unaffected projections.
- **R69 Capability preflight:** Init, doctor, schema writes, and live tests must verify the configured integration can perform the required read, query, update, schema, trash, restore, and parent-access operations before treating failures as data facts.
- **R70 Compatibility proof:** A changed Notion API version or capability model must require fake-service coverage and at least one live smoke test before it is accepted as supported.

### Must Query Remote State Completely

- **R71 Pagination completeness:** Product remote data-source queries must page the full database until Notion reports completion; partial pages, cursor failures, capped previews, or interrupted scans must not advance completeness checkpoints or classify absence.
- **R72 Full replica contract:** User-facing `<database-id>.sqlite` files must only be created from the full database membership query. Query-contract/filter/high-watermark variants are internal test/debug concerns and must not be exposed as establishment or sync modes.
- **R73 Filtered absence:** Filtered queries and views must not imply deletion or movement for product replicas. They may only remain in private debug/test paths that do not create database-ID-named files.

### Must Expose A Local SQLite Replica API

- **R74 Public replica file:** Each established workspace must expose one `<database-id>.sqlite` file as the stable user-facing local replica/API.
- **R75 Internal store boundary:** Private sync-control state must live inside `_nds_*` tables in that same SQLite file and must not be documented as user-editable API.
- **R76 Portable replica:** `<database-id>.sqlite` must remain copyable/back-up-able without required config or store sidecars while preserving accepted intents, conflicts, and settlement state.
- **R77 Generic read model:** The replica must expose stable public surfaces for `rows`, `schema`, `schema_properties`, `changes`, `conflicts`, `sync_status`, and read-only `debug_*` diagnostics.
- **R78 Ergonomic rows view:** The writable `rows` view must provide property-name columns and tolerate property rename/collision cases.
- **R79 Writable intents:** Local data edits must enter the system as explicit, durable write intents with target identity, base hashes, desired value, actor/source, and conflict policy.
- **R80 Intent safety:** Local SQL writes must not call Notion directly; CLI sync must plan, dry-run, enqueue, execute, verify, and settle intents through the guarded outbox model.
- **R81 Public schema versioning:** The replica API schema must be versioned separately from the internal store schema and generated view definitions.
