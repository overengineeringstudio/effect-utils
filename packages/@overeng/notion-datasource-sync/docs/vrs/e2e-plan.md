# Notion Datasource Sync E2E Plan

This plan is derived from [requirements.md](./requirements.md) and [spec.md](./spec.md). It is the execution and verification plan for implementing `@overeng/notion-datasource-sync`; the VRS documents remain the authoritative system contract.

## Verification Levels

| Level | Name                     | Purpose                                                                                                      | Required proof                                                                                                                           | Runs in CI     |
| ----- | ------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| L1    | Pure unit                | Canonicalization, hashing, guard decisions, planning, conflict classification                                | Deterministic fixtures and property-level edge cases with no filesystem, SQLite, network, timers, or NotionMD dependency                 | Always         |
| L2    | Fake-service integration | Effect services with fake Notion gateways, fake body adapter, fake filesystem, fake clock, fake rate limiter | End-to-end command planning/execution paths with typed failures and retry schedules                                                      | Always         |
| L3    | SQLite integration       | Real SQLite store, migrations, replay, outbox, crash recovery, leases                                        | Durable event and projection invariants survive process restarts, duplicate attempts, schema upgrades, and replay from empty projections | Always         |
| L4    | Filesystem integration   | Real temp workspace, path claims, `.nmd` adapter boundary, local delete/repair, object-store damage          | Local artifact semantics are safe without depending on Notion or private NotionMD internals                                              | Always         |
| L5    | Daemon integration       | Local watcher, polling scheduler, queue backpressure, cancellation, restarts, lease renewal                  | Watch mode uses the same planner as one-shot sync and recovers from missed/coalesced signals                                             | Always         |
| L6    | Live Notion E2E          | Real temporary Notion data sources/pages for API semantics                                                   | Isolated live fixtures prove behavior that fake services cannot prove                                                                    | Secret-gated   |
| L7    | Long-running soak        | Daemon over repeated local/remote mutations with repair scans                                                | Repeated mixed mutations converge to clean `doctor` state with no unresolved outbox, tombstones, or leaked fixtures                      | Manual/nightly |

Every guard in the spec must have:

- an L1 or L2 test that asserts the typed guard/error/conflict shape,
- a higher-level proof when the guard crosses SQLite, filesystem, daemon, or Notion behavior,
- a negative assertion that the guarded write/delete/forget/overwrite does not happen,
- a structured diagnostic assertion that omits secrets, signed URLs, full private bodies, and private workspace identifiers.

Every requirement must map to at least one scenario row. Every scenario row must name the lowest deterministic level that proves planner behavior and the highest effectful level needed to prove integration behavior.

## Live Test Harness

| Concern              | Plan                                                                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace            | Use a secret-provided parent page with permission to create child databases/data sources and pages. Create all data sources, rows, body pages, relation targets, and file fixtures under that parent.                                                                             |
| Run identity         | Generate one opaque run ID. Prefix every temporary title with the run ID and persist a local run ledger containing only object IDs, fixture purpose, and cleanup state.                                                                                                           |
| Isolation            | Never depend on pre-existing workspace schema, views, rows, permissions, or test order. Each live test creates the minimum schema it needs.                                                                                                                                       |
| API version          | Pin live requests to `Notion-Version: 2026-03-11`. Diagnostics and private artifacts record the version used without recording tokens, workspace URLs, or private payloads.                                                                                                       |
| Capability preflight | Before data assertions, verify the configured integration can read, query, update properties, update schema, update markdown, trash, restore, and access fixture parents. Capability failures are harness/configuration failures, not data facts.                                 |
| Cleanup              | Trash all run-created pages/data sources, then verify by direct retrieve where Notion allows it. Cleanup runs after each test and again at suite end from the ledger. Failed cleanup is a test failure and emits sanitized IDs only.                                              |
| Orphan recovery      | The suite provides a cleanup-only mode that reads a previous run ledger and removes leaked fixtures. CI stores the ledger as a private artifact, not in the repository.                                                                                                           |
| Rate limits          | Use the shared Notion client limiter. L2 tests assert 429, `Retry-After`, jitter, cancellation, and max-attempt behavior; L6 tests run serially or with a strict low-concurrency group.                                                                                           |
| Pagination           | Live tests create enough rows/properties/blocks to require cursor pagination for data-source query, page-property item retrieval where applicable, and block children retrieval through the body adapter. Interrupted or partial scans must not advance completeness checkpoints. |
| Query contract       | Every remote scan records the filter, sort, cursor, page size, high-watermark, API version, and scoped-membership mode used for observation. Tests must prove changed query shape invalidates membership proof.                                                                   |
| Permissions          | Live tests cover accessible objects. Ambiguous 403/404 and restricted-object behavior is primarily L2 unless a dedicated restricted fixture is safely available.                                                                                                                  |
| Secrets              | Read tokens through the repo secret flow. Do not persist token paths, workspace URLs, signed URLs, raw private payloads, or full page bodies.                                                                                                                                     |
| Evidence             | Store sanitized summaries in committed docs only when behavior is durable and non-sensitive. Raw live responses stay in private CI artifacts with TTL when needed for debugging.                                                                                                  |

Live tests must be written so every created fixture can be cleaned up even if planning, assertion, or process shutdown fails after the fixture is created. The harness records each object before mutating it.

Current page-property endpoint status: `@overeng/notion-effect-client` does not yet expose the Notion page-property-item endpoint (`GET /v1/pages/{page_id}/properties/{property_id}`), so `@overeng/notion-datasource-sync` must keep `page_property_paginate` fail-closed. Strict live mode that requires `page_property_paginate` must fail before row queries, page reads, property/schema/page mutations, or verified-cleaned ledger writes.

Acceptance criteria for enabling `page_property_paginate`:

- Add a Notion client wrapper for `GET /v1/pages/{page_id}/properties/{property_id}` with `page_id`, `property_id`, `start_cursor`, and `page_size`, using `Notion-Version: 2026-03-11`.
- Decode both single `property_item` responses and paginated list responses, including `results`, `next_cursor`, `has_more`, and `next_url`.
- Cover paginated property types `title`, `rich_text`, `relation`, `people`, and rollup pagination semantics with client tests.
- Map decoded results to `PagePropertyItemPage` in the datasource gateway and advertise `page_property_paginate` only after fake-service and credential-gated live E2E coverage passes.

## Traceability Artifacts

Implementation must maintain these generated or test-owned artifacts:

| Artifact                       | Purpose                                                                                                  | Gate                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Requirement-to-scenario matrix | Maps R01-R73 to scenario IDs and test files                                                              | Fails if a requirement has no test mapping                                                  |
| Guard-to-test matrix           | Maps each spec guard to typed tests and higher-level proofs                                              | Fails if a guard lacks planner and integration coverage                                     |
| Live fixture ledger            | Tracks run-created Notion objects and cleanup state                                                      | Secret-gated suite fails on leaked fixtures                                                 |
| Migration corpus               | Stores old SQLite schemas/event histories for forward migration tests                                    | L3 fails if current migrations cannot upgrade and replay them                               |
| Redaction corpus               | Contains representative unsafe payload fragments and expected sanitized diagnostics                      | L1/L2 fail if unsafe data appears                                                           |
| API compatibility manifest     | Records the supported Notion API version, required capability set, and live smoke proof for that version | Fails release if the pinned version or capability model changes without fake and live proof |

The matrices may be generated from test metadata, but they must be reviewed as release artifacts before the package is marked releasable.

## Failure Injection

| Surface                   | Injected failure                                                                                                                                                                                                                                                                                   | Required assertion                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Notion transport          | 429 with and without `Retry-After`, 5xx, network timeout, connection reset, malformed success body, stale cursor, duplicate page in paginated results                                                                                                                                              | Commands retry only when safe, preserve outbox state, and never settle without read-after-write verification                                                                                     |
| Notion authorization      | 401 token failure, 403 restricted page, ambiguous 404, missing update/schema/trash/restore capability, relation target inaccessible                                                                                                                                                                | Sync fails closed with capability or `PermissionAmbiguous` errors; no delete, forget, overwrite, or relation drop occurs                                                                         |
| Notion API drift          | Changed API version, missing response field, unknown enum variant, changed nested property shape, extra unsupported surface                                                                                                                                                                        | Decode drift produces typed unsupported-state guards, preserves unaffected projections, and requires compatibility proof before support is accepted                                              |
| Notion consistency        | Remote write succeeds but immediate verification reads old data, timestamp precision differs from prior observations, query omits known row, filtered query hides known row                                                                                                                        | Executor retries/defers verification, planner treats timestamps as wakeups only, tombstone classification uses direct retrieve and respects the query contract                                   |
| Notion query completeness | Cursor failure, partial page, interrupted scan, 10k query cap reached, changed filter/sort/page size, stale high-watermark contract, no-sort unstable ordering                                                                                                                                     | Completeness checkpoints do not advance; absence is not classified from incomplete or incompatible scans                                                                                         |
| Webhook signal input      | Duplicate, missing, aggregated, stale, delayed, and out-of-order connection webhook events                                                                                                                                                                                                         | Events enqueue dirty-entity hints only; every hint triggers fresh API reads before planning and no event order is treated as authority                                                           |
| SQLite                    | Crash after intent commit, crash after command enqueue, attempted-without-settlement restart, remote write before settlement, duplicate settlement, replay from empty projections, migration interrupted before version commit                                                                     | Event log remains authoritative; first verified settlement wins; ambiguous attempts verify current remote state before retry or settlement                                                       |
| SQLite storage            | WAL unavailable/misconfigured, foreign keys disabled, busy database, event codec decode failure, compaction with pending outbox/open conflict/active lease/ambiguous command                                                                                                                       | Store startup fails closed or repairs explicitly; codec fixtures stay backward-compatible; compaction is blocked until durable state is safe                                                     |
| Filesystem                | Local file deleted, branch-like mass deletion, workspace rebuild from empty directory, sidecar deleted, object body missing, path collision, case-insensitive collision, Unicode normalization collision, traversal path, symlink outside workspace, partial write                                 | Repair or conflict is created; path claims prevent overwrite; local delete never implies remote trash without explicit trusted policy and identity proof                                         |
| Body adapter              | Adapter attempts property/page metadata/schema/trash writes, truncated markdown, unknown block IDs, ambiguous markdown selection, markdown update would delete child pages/databases, synced-page unsupported, adapter returns stale base hash, body push conflict, materialization failure midway | Datasource sync rejects surface leaks and records no settlement; body writes block on lossy/destructive state; property sync can still proceed when surfaces are independent                     |
| Daemon                    | Lease expires, second daemon attempts settlement, cancellation during poll, cancellation during outbox attempt, same-bucket timestamp changes, partial-cycle cursor persistence, watcher event dropped, own-write materialization echo, queue full                                                 | Stale writer is fenced; cancellation leaves durable intent/outbox state; cursors do not skip same-bucket changes; own writes are suppressed by command identity; repair scan detects missed work |
| Telemetry                 | Payload contains token-like strings, signed URLs, private body text, workspace URLs                                                                                                                                                                                                                | Logs, spans, errors, snapshots, and CLI output redact or reject unsafe retention                                                                                                                 |

## Work Plan

### Phase 0: VRS And Guard Contract

Work:

- Land the VRS documents and guard matrix.
- Assign every requirement to verification levels.
- Decide package staging while preserving conceptual boundaries.
- Create test metadata conventions for scenario IDs, requirement IDs, guard IDs, and live-fixture ownership.
- Create the API compatibility manifest for `Notion-Version: 2026-03-11`, including `in_trash`, `meeting_notes`, and block append `position` compatibility expectations.

E2E proof:

- Docs lint/check passes.
- Guard matrix contains no unowned edge-case category.
- Requirement-to-scenario and guard-to-test matrices can be generated from placeholder metadata before implementation begins.
- R67-R73 have scenario IDs and at least one fake-service proof slot before gateway implementation begins.

### Phase 1: Shared Schema And Domain Foundations

Work:

- Normalize data-source, schema, row, property-value, body-pointer, file-ref, tombstone, and conflict domain types.
- Implement branded IDs and exact decoders for all consumed Notion payloads.
- Implement canonical hashes for schema and row values.
- Define canonical redaction rules for raw payload snippets and diagnostics.
- Model API-versioned decode drift as typed unsupported states that can block only affected surfaces.

E2E proof:

- L1 fixtures for property ID rename stability, row hash stability, computed read-only properties, relation refs, file URL exclusion, timezone/date canonicalization, empty/null value differences, and unknown property variants.
- L2 fake Notion payload decode tests for unknown/extra fields and unsupported variants.
- L1 redaction corpus for tokens, signed URLs, workspace URLs, private body text, and raw payload retention decisions.
- L1/L2 API-version fixtures for supported version tags, version mismatch diagnostics, unknown enum variants, missing required fields, `archived` vs `in_trash` drift, `transcription` vs `meeting_notes` drift, and unaffected projection preservation after decode drift.

### Phase 2: SQLite Sync Core

Work:

- Implement event log, projection rebuild, outbox, conflict projection, tombstone projection, path claims, checkpoints, leases, and migrations.
- Ensure network execution is outside SQL transactions.
- Define migration compatibility fixtures before the first non-trivial schema migration lands.
- Configure SQLite with WAL, foreign-key enforcement, and explicit busy timeout semantics.
- Define stable event codec fixtures for every event family before events are persisted.

E2E proof:

- L3 replay digest test from a non-trivial event history.
- L3 crash tests for command enqueued before execution, attempted-without-settlement restart, remote write before settlement, duplicate settlement, and projection rebuild.
- L3 ambiguous outcome tests for property, body, schema, trash, and materialization commands prove restart verifies current remote/body state before retrying, settling, or opening conflict.
- L3 lease fencing test with two simulated daemons.
- L3 migration tests upgrade every stored schema version, preserve replayability, reject downgrade attempts, and leave no half-applied migration after interruption.
- L3 checkpoint/compaction tests prove event replay and compacted replay produce the same digest.
- L3 WAL/foreign-key/busy-timeout tests prove invalid configuration fails closed and concurrent writers do not bypass leases.
- L3 event codec fixtures prove backward decode compatibility and typed failure for corrupt or future-version events.
- L3 compaction guard tests block compaction with pending outbox, active lease, attempted-without-settlement command, open conflict, unresolved tombstone, or ambiguous materialization state.

### Phase 3: Data-Source Remote Observation

Work:

- Implement `NotionDataSourceGateway` over typed client APIs.
- Bind local root to `data_source_id`.
- Pull schema, query rows, retrieve known pages, and classify query absence candidates.
- Record query contracts and completeness checkpoints for every remote scan.
- Add capability preflight before init, doctor, schema writes, markdown writes, and live tests treat remote failures as data facts.

E2E proof:

- L2 fake pagination and partial failure tests.
- L2 stale cursor, duplicate page, empty page, unsupported filter/sort, changed query contract, interrupted scan, 10k query-cap reached, filtered absence, no-sort unstable ordering, and partial-page retrieve tests.
- L2 capability preflight tests for missing read, query, update, schema, markdown, trash, restore, and parent-access operations.
- L6 live test for `2026-03-11` version reporting, capability preflight, database-to-data-source resolution, row query pagination, page-property item pagination where applicable, timestamp wake-up behavior with no correctness decision depending on timestamp granularity, direct page retrieve, query absence candidate creation, filtered-query non-absence behavior, and no inference from views.

### Phase 4: Local Workspace Projection

Work:

- Define local path strategy, path claims, row manifests, and body-pointer materialization.
- Integrate `PageBodySyncPort` with NotionMD without depending on NotionMD internals.
- Define filename normalization for duplicate titles, invalid characters, Unicode normalization, and case-insensitive filesystems.
- Treat local path rename as a local organization change unless an explicit title-edit command is accepted.

E2E proof:

- L4 title collision, row-ID suffix stability, case-folding collision, Unicode normalization collision, reserved-character, long-title, duplicate-title, path traversal, symlink-outside-root, partial-write, and sidecar-damage tests.
- L4 local path rename tests prove no remote title edit is planned by default.
- L4 local delete vs local forget tests.
- L6 live body materialization test through the public NotionMD adapter, including paginated block children and cleanup after partial materialization failure where injectable.

### Phase 5: Bidirectional Property Sync

Work:

- Detect local property edits.
- Plan remote row property patches with base hashes and current-schema preflight.
- Verify writes by read-after-write.
- Keep pending local intent distinct from later remote observations until the planner resolves or conflicts them.

E2E proof:

- L1 conflict classifier tests for same-property, disjoint-property, property-vs-body, and computed-property writes.
- L2 stale-base, schema-drift, read-after-write mismatch, transient verification lag, computed-property write rejection, relation target unavailable, and file URL identity fake tests.
- L3 pending-intent shadowing test proves replay preserves local intent and remote same-surface observation, then opens a durable conflict instead of overwriting either side.
- L2 page-property pagination tests for relation, people, rich-text mention, title mention, and rollup values where page retrieval can be incomplete or unavailable.
- L2 write-capability preflight tests ensure missing update/schema capabilities block planning before remote mutation.
- L6 live test for every supported writable property type that Notion permits in temporary data sources, including title, rich text, number, checkbox, date with timezone, select, multi-select, URL, email, phone, person when fixture-safe, relation when target is fixture-owned, and files as read-only observation unless file upload is implemented.

### Phase 6: Body Adapter Sync

Work:

- Use NotionMD for row page body pull/status/push.
- Treat body state as a separate surface from row properties.
- Block body writes on truncation or unknown block IDs.
- Enforce that `PageBodySyncPort` cannot mutate row properties, page metadata, schema, trash/restore state, or datasource membership.

Current executable contract:

- Datasource-sync does not yet ship a real NotionMD adapter. The current public boundary carries body hashes and safety metadata, while NotionMD's implemented sync APIs are file/body-content oriented. That is not enough information to implement guarded `.nmd` extraction/rendering without inventing a private adapter contract.
- Until a public NotionMD adapter API exists, `src/e2e/body-adapter.e2e.test.ts` is the release gate for this boundary: missing adapters fail before body materialization, unsafe safety snapshots create body conflicts without enqueueing body pushes, and already queued body pushes remain unsettled when the adapter is absent.
- Real adapter acceptance requires a public API that can observe page body state, plan a local `.nmd` body change from actual local body content, push only the body surface, report mutation surfaces, report all `BodySafetySnapshot` fields, and prove that ordinary sync never sets `allow_deleting_content`.

E2E proof:

- L2 fake adapter surface-leak tests attempt property, page metadata, schema, trash, restore, and membership writes through the body adapter; datasource-sync rejects them and records no command settlement.
- L2 fake body adapter conflict tests for stale base, truncation, unknown block IDs, push failure, materialization failure, and adapter-level conflict.
- L2 markdown update guard tests for ambiguous `update_content` matches, missing `old_str`, `replace_content` that would delete child pages/databases without explicit destructive-body intent, synced-page unsupported errors, and unknown block IDs whose cause cannot be classified.
- L4 `.nmd` local edit, path-claim, sidecar identity, missing body object, interrupted halfway-through materialization, and repair tests.
- L6 live property-only push across remote body edit, body-only push across remote property edit, paginated body pull through NotionMD, public markdown update refusal for child-page deletion when feasible, and synced-page unsupported behavior when a safe fixture exists.

### Phase 7: Conflict Engine

Work:

- Persist conflicts for same-surface edits, delete-vs-edit, schema drift, body truncation, path collision, unavailable relations, and permission ambiguity.
- Implement conflict listing and resolution commands as events.

E2E proof:

- L1 table-driven classifier covering all conflict tags.
- L3 resolution events update projections without direct mutation.
- L4 conflict files or CLI projections do not become source of truth.
- L6 live same-property and delete-vs-edit representative tests.
- L2 structured diagnostics prove each conflict names surface, base hash, current hash, local intent, remote observation, safe next commands, and redacted evidence.

### Phase 8: Delete, Move, Restore, Forget

Work:

- Implement tombstone candidate flow and direct classifier.
- Implement guarded local delete intent, remote trash, restore, moved-out, moved-back, inaccessible, unknown, and forget semantics.
- Treat branch-like mass deletion and workspace rebuild as local repair/reprojection events, not remote trash intent.

E2E proof:

- L2 fake 403/404/restricted, missing trash/restore capability, parent mismatch, moved-between-tracked-sources, direct retrieve transient failure, incomplete scan, filtered absence, and query absence race behavior.
- L2 explicit trash/apply/trusted-policy tests prove remote trash requires an accepted destructive intent and cannot be inferred from bulk local disappearance.
- L4 local file delete, branch-like mass deletion, workspace rebuild, sidecar delete, body-object delete, store forget, restore artifact recreation, and repair tests.
- L6 live trash, restore, move out, move back, moved-between-two-tracked-fixture-sources when safe, and query absence classification tests.

### Phase 9: Schema Writes And Migrations

Work:

- Implement explicit schema migration planning for add, rename, delete, type conversion, and select/multi-select option changes.
- Produce dry-run value impact reports before destructive migrations.
- Model schema ownership as `userManaged` or `appOwned`; automatic convergence is allowed only for `appOwned` with expected base schema hash.

E2E proof:

- L1 schema diff and migration planner tests for add, rename, delete, type conversion, select/multi-select option add/remove/rename, property order changes, and unsupported property configs.
- L2 blocked destructive migration tests, dry-run impact report tests, stale schema preflight tests, and read-after-write mismatch tests.
- L2 schema ownership tests prove `userManaged` sources refuse automatic convergence and `appOwned` convergence requires the expected base schema hash.
- L3 migration-history tests prove explicit schema migration commands are evented and replayable.
- L6 live add, rename, delete, type conversion, option add, option rename, option removal, and read-after-write schema hash tests against temporary data sources.

### Phase 10: Watch Daemon

Work:

- Implement local daemon lease, filesystem watcher, remote overlap polling, known-page scans, queue backpressure, retries, and repair scans.
- Keep daemon planning identical to one-shot sync.

E2E proof:

- L2 fake-clock scheduler tests for overlap windows, dedupe, backoff, cancellation, and bounded queue behavior.
- L2 webhook-input tests for duplicate, missing, aggregated, stale, delayed, and out-of-order dirty-entity hints.
- L5 local edit coalescing, watcher drop plus repair scan, remote poll overlap, same-bucket timestamp/page ordering, partial-cycle cursor persistence, query-contract checkpoint preservation, daemon restart, stale lease, second-daemon fencing, cancellation during poll, cancellation during outbox attempt, stuck outbox, own-write suppression for materialization writes, and queue backpressure tests.
- L5 interrupted materialization test proves restart repairs or resumes from durable body pointer/object state before planning downstream writes.
- L6 live daemon test with one local edit, one remote property edit, one remote body edit, one schema drift observation, and one trash/restore cycle.
- L7 soak test with repeated mixed mutations, induced daemon restarts, repair scans, rate-limit throttling, final `doctor` clean state, and verified live cleanup.

### Phase 11: Files, Relations, Rollups, And Unsupported Features

Work:

- Model relation availability, read-only generated properties, file refs, unsupported property variants, and lossy Notion shapes.
- Add first-class editable support only after e2e proof exists.

E2E proof:

- L1 generated-property write rejection tests.
- L1 file-ref canonicalization tests prove signed URLs, expiry times, and transient names are excluded from durable identity.
- L2 unavailable relation target, unshared related data source, duplicate relation target, file URL expiry, page-property `has_more`, rollup/formula recomputation, linked-data-source unsupported behavior, and unsupported property variant tests.
- L6 representative relation, file, generated-property, rollup, formula, people, created/last-edited metadata, and unique-id observation tests.
- L6 representative page-property pagination test where fixture size is practical; large 10k query-cap behavior remains L2/manual due live cost.
- Editable file upload/replacement remains blocked unless a separate live upload experiment proves byte identity, expiry, and replacement semantics.

### Phase 12: CLI, Telemetry, And Doctor

Work:

- Implement init, pull, status, push, sync, watch, conflicts, migrate, doctor, repair, forget, and restore.
- Add structured output and OpenTelemetry spans.
- Surface pinned API version, capability preflight results, query contract, query completeness state, and decode-drift guards in diagnostics.

E2E proof:

- L2 CLI command tests with fake services for human output, machine output, dry-run, non-zero exits, cancellation, and guard diagnostics.
- L3 doctor detects projection drift, orphaned outbox, stale lease, unresolved tombstone, path collision, missing checkpoint, incomplete scan checkpoint, incompatible query contract, migration mismatch, API compatibility mismatch, and unsafe raw retention.
- L4 doctor detects orphaned files, missing sidecars, missing body objects, symlinks, and path-claim mismatches.
- L5 daemon spans exist and omit secrets.
- L6 live command smoke test with sanitized telemetry assertions and private artifact retention checks.

### Phase 13: CI And Release Gates

Work:

- Wire fast tests into normal CI.
- Wire secret-gated live tests into integration CI.
- Add cleanup checks and run ledger for live fixtures.
- Add release-blocking checks for API compatibility manifest changes and query contract coverage.

E2E proof:

- `dt check:quick` passes for normal code changes.
- Unit/integration suites pass without secrets.
- Live suite creates, verifies, and cleans temporary Notion objects.
- Release candidate requires clean `doctor` on test workspace, no open unclassified guard cases, no unmapped requirements, no unmapped guards, no leaked live fixtures, no unsafe telemetry snapshots, pinned API compatibility proof, and no unsupported editable feature without live proof.

## Scenario Matrix

### Executable Realistic Offline Slice

The release-slice scenarios in `src/e2e/realistic-workflows.e2e.test.ts` compose the fake Notion gateway, SQLite store, one-shot planner/executor, body port, and real/fake workspace ports without credentials. They prove cross-component behavior for realistic workflows, while live Notion API semantics remain L6 evidence.

| Scenario ID                                    | Workflow proof                                                                                                                                     | Remaining boundary                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `NDS-L4-realistic-initial-materialization`     | Initial pull materializes datasource/schema/row/property/body state, rebuilds projections, and proves a second full sync is idempotent.            | Live Notion datasource/page-property semantics.                           |
| `NDS-L3-realistic-remote-drift-local-write`    | Remote disjoint property drift updates projections before a local property write is enqueued, executed, and read-after-write verified.             | Full writable property-type matrix.                                       |
| `NDS-L3-realistic-local-remote-conflict`       | Pending local intent survives remote same-property drift and replays as an open durable conflict instead of shadowing either side.                 | Human conflict-resolution strategies.                                     |
| `NDS-L3-realistic-schema-capability-failure`   | Missing page-property pagination and stale schema config block before remote mutation.                                                             | Live capability preflight and schema migration UX.                        |
| `NDS-L4-realistic-filesystem-delete-repair`    | Bare local delete remains candidate-only, explicit trusted trash settles, path collisions/escapes block, and sidecar damage is local repair state. | Broader platform filesystem matrix and live body adapter materialization. |
| `NDS-L5-realistic-daemon-restart-cancellation` | Existing daemon E2E covers restart/cancellation durability, lease fencing, and own-write suppression.                                              | Same-bucket polling and long-running soak.                                |
| `NDS-LIVE-skeleton-gated-cleanup-ledger`       | Secret-gated live skeleton records sanitized fixture ledger and cleanup shape.                                                                     | Full live fixture mutation suite.                                         |

| Scenario                                            | Required levels                                | Guards / requirements challenged          |
| --------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| Initial bind and pull                               | L2, L3, L4, L6                                 | R05, R06, R14-R17, R65                    |
| Clean status after pull                             | L2, L3, L4, L6                                 | R08, R21, R48                             |
| Local property edit push                            | L1, L2, L3, L6                                 | `StaleSurfaceBase`, R21-R24               |
| Remote property edit pull                           | L2, L3, L6                                     | R22, R24                                  |
| Disjoint local/remote property edits                | L1, L2, L3, L6 representative                  | R26                                       |
| Same property conflict                              | L1, L2, L3, L6                                 | `StaleSurfaceBase`, R25, R27              |
| Property edit vs body edit                          | L1, L2, L4, L6                                 | `PageTimestampWakeupOnly`, R17, R26       |
| Body truncation / unknown block IDs                 | L1, L2, L6 when reproducible                   | `BodyLossyRemote`, R29                    |
| Body adapter surface leak                           | L2, L3                                         | R02, R54-R55                              |
| Body materialization pagination                     | L2, L4, L6                                     | R02, R17, R63                             |
| Interrupted body materialization repair             | L3, L4, L5                                     | R02, R47, R63-R64                         |
| Schema rename                                       | L1, L2, L6                                     | R14, R32                                  |
| Schema add                                          | L1, L2, L6                                     | R31                                       |
| Schema delete                                       | L1, L2, L3, L6                                 | `DestructiveSchemaMigrationRequired`, R33 |
| Schema type conversion                              | L1, L2, L3, L6                                 | R34                                       |
| Select/multi-select option removal                  | L1, L2, L6                                     | R35                                       |
| Schema drift affects pending intent                 | L1, L2, L3                                     | `SchemaDriftAffectsIntent`, R30           |
| Schema ownership policy                             | L1, L2, L6 representative                      | R30-R35                                   |
| Query absence                                       | L2, L3, L6                                     | `QueryAbsenceUnclassified`, R36-R37       |
| Pagination completeness                             | L2, L3, L5, L6 representative                  | R71                                       |
| Data-source query 10k cap                           | L2, manual L6 when justified                   | R71                                       |
| Query contract mismatch                             | L1, L2, L3, L5                                 | R72                                       |
| Filtered absence                                    | L2, L3, L6 representative                      | R73                                       |
| Remote trash and restore                            | L2, L3, L6                                     | `DeleteVsEdit`, R40                       |
| Remote move out and move back                       | L2, L3, L6                                     | `MoveOutNotDelete`, R37                   |
| Moved between tracked sources                       | L2, L3, L6 when fixture-safe                   | R37                                       |
| Local file delete                                   | L2, L3, L4                                     | R38                                       |
| Branch-like mass deletion                           | L2, L3, L4                                     | R38-R39                                   |
| Workspace rebuild from empty root                   | L3, L4                                         | R38-R39, R47                              |
| Explicit trash/apply/trusted delete policy          | L2, L3, L4, L6 representative                  | R38-R41                                   |
| Local forget                                        | L2, L3, L4                                     | R39                                       |
| Sidecar/object damage                               | L3, L4                                         | R47, R63                                  |
| Path collision                                      | L1, L3, L4                                     | `PathClaimCollision`, R27                 |
| Title collision and row-ID suffix                   | L1, L4                                         | `PathClaimCollision`, R63                 |
| Case-insensitive path collision                     | L1, L4                                         | `PathClaimCollision`, R63                 |
| Unicode path collision                              | L1, L4                                         | `PathClaimCollision`, R63                 |
| Path traversal and symlink escape                   | L1, L4                                         | R63                                       |
| Path rename without title edit                      | L2, L4                                         | R21, R38                                  |
| Permission ambiguity                                | L2, L6 only with safe restricted fixture       | `PermissionAmbiguous`, R41                |
| 429 and retry-after                                 | L2, L5                                         | R45                                       |
| Network failure after enqueue                       | L2, L3                                         | R09-R11                                   |
| Remote write succeeds before local settlement crash | L3                                             | `OutboxFirstSettlementWins`, R11          |
| Attempted-without-settlement restart                | L3                                             | R10-R11, R21-R24                          |
| Ambiguous command outcome verification              | L3                                             | R10-R12, R21-R24                          |
| Duplicate settlement                                | L3                                             | `OutboxFirstSettlementWins`, R11          |
| SQLite projection replay and compaction             | L3                                             | R08, R12                                  |
| SQLite WAL/foreign-key/busy-timeout invariants      | L3                                             | R06, R10-R12                              |
| Event codec compatibility fixtures                  | L1, L3                                         | R07, R12                                  |
| Compaction blocked by unsafe state                  | L3                                             | R08, R11-R12, R27                         |
| SQLite migration from every stored version          | L3                                             | R12                                       |
| Daemon restart                                      | L5                                             | R42                                       |
| Daemon cancellation                                 | L2, L5                                         | R42, R45                                  |
| Watch same-bucket cursor ordering                   | L2, L5                                         | R43-R44                                   |
| Partial-cycle cursor preservation                   | L3, L5                                         | R43-R47                                   |
| Own-write materialization suppression               | L2, L5                                         | R42, R47                                  |
| Stale daemon lease                                  | L3, L5                                         | `LeaseFenceMismatch`, R46                 |
| Second daemon fencing                               | L3, L5                                         | `LeaseFenceMismatch`, R46                 |
| Periodic repair scan                                | L3, L4, L5                                     | R47                                       |
| Watcher event drop                                  | L5                                             | R44, R47                                  |
| Queue backpressure and stuck outbox                 | L2, L5                                         | R45                                       |
| Relation target unavailable                         | L1, L2, L6 observation                         | `UnavailableRelationTarget`, R19          |
| Page-property value pagination                      | L1, L2, L6 representative                      | R16, R19, R71                             |
| Files property observation                          | L1, L2, L6                                     | `ExpiringFileUrl`, R20                    |
| Generated/read-only property write                  | L1, L2, L6 observation                         | R18                                       |
| Unsupported remote shape                            | L1, L2                                         | `UnsupportedRemoteShape`, R29             |
| Explicit API version diagnostics                    | L1, L2, L6 smoke                               | R67                                       |
| Decode drift preserves unaffected projections       | L1, L2, L3                                     | `UnsupportedRemoteShape`, R68             |
| Capability preflight                                | L2, L6 smoke                                   | `PermissionAmbiguous`, R41, R69           |
| API compatibility update                            | L1, L2, L6 smoke                               | R70                                       |
| Markdown update guard semantics                     | L1, L2, L6 representative                      | `BodyLossyRemote`, R29                    |
| Webhook signal semantics                            | L2, L5                                         | R56                                       |
| Workers sync limitation confirmation                | L2 optional compatibility, no correctness gate | R56                                       |
| Raw payload retention redaction                     | L1, L2                                         | `RawPayloadRetentionUnsafe`, R13, R52     |
| Telemetry secret safety                             | L1, L2, L5, L6 smoke                           | R52, R59                                  |
| Live fixture cleanup failure                        | L2 harness fake, L6                            | R65                                       |
| Long-running mixed mutation convergence             | L7                                             | R42-R47, R65                              |

## CI Gates

| Gate                   | Contents                                                                               | Trigger                                                              |
| ---------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Fast PR gate           | L1, L2, targeted L3/L4, docs checks, `git diff --check`                                | Every PR touching the package                                        |
| Full local gate        | All L1-L5 suites and generated traceability matrices                                   | Before release candidate and before large refactors land             |
| Secret-gated live gate | L6 suite with serial live fixtures, cleanup verification, sanitized artifact retention | Scheduled, manual, and release candidate                             |
| Soak gate              | L7 daemon run with induced restarts and final cleanup                                  | Manual/nightly before first release and after daemon/storage changes |

Normal CI must not require Notion secrets. Tests that require secrets must skip with an explicit "not configured" reason and must fail if partially configured secrets would leave fixtures untracked.

## Definition Of Done

The datasource-sync package is releasable when:

- every requirement in [requirements.md](./requirements.md) maps to tests,
- every guard in [spec.md](./spec.md) has an implemented typed error/conflict state,
- every guard has a negative assertion that the unsafe action did not happen,
- all L1-L5 tests pass in normal CI,
- L6 live tests pass in the secret-gated Notion integration job,
- the watch daemon can complete the L7 soak without unresolved outbox commands, unclassified tombstones, leaked fixtures, or stuck leases,
- `doctor` reports a clean store after fake, SQLite, filesystem, daemon, and live sync scenarios,
- schema migration fixtures prove upgrade and replay from every stored SQLite schema version,
- SQLite store setup proves WAL, foreign-key enforcement, busy timeout behavior, event codec compatibility, and compaction guards for pending/leased/ambiguous/conflicted state,
- the API compatibility manifest names `Notion-Version: 2026-03-11`, required capabilities, and fake-service plus live-smoke proof for that compatibility contract,
- pagination completeness, page-property pagination, query cap, query contract mismatch, and filtered absence have negative tests proving absence is not inferred from incomplete or incompatible scans,
- markdown update guards block ambiguous selection, implicit child-page/database deletion, synced-page mutation, and unknown-block writes unless an explicit supported operation proves safety,
- body adapter tests prove the adapter cannot settle property, metadata, schema, trash, restore, or membership mutations through the page-body surface,
- pending local intent, remote same-surface observation, and ambiguous attempted commands survive replay without shadowing and require verification/conflict before settlement,
- local mass deletion, workspace rebuild, path rename, traversal, symlink escape, title collision, Unicode/case collision, and row-ID suffix behavior are covered by filesystem tests before any remote mutation is planned,
- schema ownership tests prove `userManaged` sources refuse automatic convergence and `appOwned` sources require the expected base schema hash,
- watch tests cover same-bucket cursor ordering, partial-cycle cursor persistence, own-write materialization suppression, and interrupted materialization repair,
- webhook inputs are covered as signal-only dirty hints and Workers syncs remain optional compatibility/projection experiments, not correctness gates,
- live fixture ledgers prove cleanup after success and failure paths,
- logs, spans, snapshots, CLI output, and committed docs pass the redaction corpus,
- docs describe all unsupported features as explicit typed states or confirmed exceptions,
- no editable Notion property/body/file feature is released without L1/L2 planner coverage and representative L6 proof when Notion API semantics matter.
