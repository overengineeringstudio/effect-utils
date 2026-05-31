# Notion Datasource Sync Requirements

## Context

These requirements serve [vision.md](./vision.md). They define the production constraints for a standalone Notion data-source sync primitive that composes with the existing Notion packages in `effect-utils`. Per [decision 0001](./decisions/0001-subsystem-decomposition.md), subsystem-specific requirements live under [`subsystems/`](./subsystems/); this top-level document keeps only the global assumptions, the genuinely cross-cutting requirements, and the authoritative trace index.

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

## Cross-cutting Requirements

These constraints apply across every sub-system and stay single-sourced here.

### Safety, Boundaries, And Secrets

- **XC-R01 Standalone package:** Datasource sync must be implemented as a standalone package, not as a built-in `@overeng/notion-md` feature.
- **XC-R02 No silent LWW:** Last-writer-wins must not be the default behavior for any bidirectional surface. _(Canonical statement; sub-systems reference this rather than copying it, e.g. PLAN-R03.)_
- **XC-R03 Secret safety:** CLI, telemetry, fixtures, and errors must never print tokens, signed URLs, full private document bodies, or private workspace identifiers.
- **XC-R04 No unwanted data loss:** Established sync, daemon cycles, repair, migration, and body materialization must not discard user-authored local or remote content. A destructive, replacing, hiding, or settling action is allowed only after the affected surface has captured local desired state, a known base hash, a fresh counterpart observation, an explicit planner/guard decision, and one of: verified supersession, durable recoverable conflict material, or an explicit approved destructive/reversible intent.

### Observability

- **OBS-R01 Span coverage:** Every CLI command, daemon pass, Notion API request, SQLite transaction, planner decision, outbox attempt, conflict decision, migration, and destructive operation must emit useful spans.
- **OBS-R02 Trace attributes:** Spans must include concise labels plus data-source, row, property, command, conflict, surface, operation, result, and Notion request identifiers when available.
- **OBS-R03 Safe telemetry:** Telemetry must not include credentials, full document bodies, raw private payloads, or signed file URLs.

### Verification

- **VERIFY-R01 Unit coverage:** Canonicalization, schema hashing, row hashing, planners, conflict classification, and guard decisions must have deterministic unit tests.
- **VERIFY-R02 Fake-service integration:** Sync flows must have Effect integration tests against fake Notion gateways, fake body adapters, and fake filesystem/storage services.
- **VERIFY-R03 SQLite replay coverage:** Event replay, projection rebuild, migration, crash recovery, outbox idempotency, and lease fencing must be covered by SQLite integration tests.
- **VERIFY-R04 Filesystem coverage:** Path claims, local edits, local deletes, sidecar damage, object store repair, and workspace scans must be tested against a real local filesystem.
- **VERIFY-R05 Daemon coverage:** `sync --watch` mode must be tested for polling overlap, local file events, restart recovery, queue backpressure, cancellation, and stale lease behavior.
- **VERIFY-R06 Incremental sync coverage:** Watch tests must cover checkpoint reuse, same-boundary overlap, incremental absence safety, inline query-row hydration, local-first outbound work, and periodic full-reconcile behavior.
- **VERIFY-R07 Live Notion coverage:** Supported Notion API semantics must have isolated live E2E coverage with creation, mutation, verification, and cleanup.
- **VERIFY-R08 Guard matrix:** Every problematic edge case must map to a named guard, expected behavior, and at least one unit, fake integration, SQLite, filesystem, daemon, or live E2E test.
- **VERIFY-R09 No-data-loss acceptance:** Bidirectional safety tests must prove the full chain behind XC-R04: local capture before materialization, explicit base/local/remote planning, guarded outbox writes, read-after-write settlement, guarded materialization, rebuild/replay preservation, and remote mutation-ledger assertions. A correct final projection is insufficient if an unsafe local overwrite or remote mutation was attempted.

## Acceptable Tradeoffs

Only cross-cutting tradeoffs live here; subsystem-specific tradeoffs live in their owning sub-system slices.

- **VERIFY-T01 Live test cost:** Live E2E tests may be slower and require secrets because mocks cannot prove Notion API edge semantics.

## Sub-system trace index

### Sub-system id ranges

| Sub-system               | Namespaced id range                                 | Requirements slice                                                                    |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| domain-model             | DOMAIN-R01–R10                                      | [domain-model/requirements.md](./subsystems/domain-model/requirements.md)             |
| sync-store               | STORE-R01–R08, STORE-T01                            | [sync-store/requirements.md](./subsystems/sync-store/requirements.md)                 |
| notion-gateway           | GW-R01–R08, GW-T01                                  | [notion-gateway/requirements.md](./subsystems/notion-gateway/requirements.md)         |
| body-adapter             | BODY-R01–R02                                        | [body-adapter/requirements.md](./subsystems/body-adapter/requirements.md)             |
| local-workspace          | FS-R01–R02                                          | [local-workspace/requirements.md](./subsystems/local-workspace/requirements.md)       |
| replica-api              | REPLICA-R01–R09, REPLICA-T01                        | [replica-api/requirements.md](./subsystems/replica-api/requirements.md)               |
| planner-guards           | PLAN-R01–R13, PLAN-T01–T02                          | [planner-guards/requirements.md](./subsystems/planner-guards/requirements.md)         |
| schema-migration         | SCHEMA-R01–R06, SCHEMA-T01                          | [schema-migration/requirements.md](./subsystems/schema-migration/requirements.md)     |
| sync-orchestration       | SYNC-R01–R02                                        | [sync-orchestration/requirements.md](./subsystems/sync-orchestration/requirements.md) |
| watch-daemon             | DAEMON-R01–R10, DAEMON-T01                          | [watch-daemon/requirements.md](./subsystems/watch-daemon/requirements.md)             |
| cli                      | CLI-R01–R05                                         | [cli/requirements.md](./subsystems/cli/requirements.md)                               |
| cross-cutting (this doc) | XC-R01–R04, OBS-R01–R03, VERIFY-R01–R09, VERIFY-T01 | this file                                                                             |
