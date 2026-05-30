# Notion Datasource Sync Requirements

## Context

These requirements serve [vision.md](./vision.md). They define the production constraints for a standalone Notion data-source sync primitive that composes with the existing Notion packages in `effect-utils`. Per [decision 0001](./decisions/0001-subsystem-decomposition.md), most requirements are re-homed into per-sub-system slices under [`subsystems/`](./subsystems/); this top-level document keeps only the global assumptions, the genuinely cross-cutting requirements, and the authoritative trace index.

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

- **XC-R01 Standalone package (was R01):** Datasource sync must be implemented as a standalone package, not as a built-in `@overeng/notion-md` feature.
- **XC-R02 No silent LWW (was R25):** Last-writer-wins must not be the default behavior for any bidirectional surface. _(Canonical statement; sub-systems reference this rather than copying it, e.g. PLAN-R03.)_
- **XC-R03 Secret safety (was R52):** CLI, telemetry, fixtures, and errors must never print tokens, signed URLs, full private document bodies, or private workspace identifiers.

### Observability

- **OBS-R01 Span coverage (was R57):** Every CLI command, daemon pass, Notion API request, SQLite transaction, planner decision, outbox attempt, conflict decision, migration, and destructive operation must emit useful spans.
- **OBS-R02 Trace attributes (was R58):** Spans must include concise labels plus data-source, row, property, command, conflict, surface, operation, result, and Notion request identifiers when available.
- **OBS-R03 Safe telemetry (was R59):** Telemetry must not include credentials, full document bodies, raw private payloads, or signed file URLs.

### Verification

- **VERIFY-R01 Unit coverage (was R60):** Canonicalization, schema hashing, row hashing, planners, conflict classification, and guard decisions must have deterministic unit tests.
- **VERIFY-R02 Fake-service integration (was R61):** Sync flows must have Effect integration tests against fake Notion gateways, fake body adapters, and fake filesystem/storage services.
- **VERIFY-R03 SQLite replay coverage (was R62):** Event replay, projection rebuild, migration, crash recovery, outbox idempotency, and lease fencing must be covered by SQLite integration tests.
- **VERIFY-R04 Filesystem coverage (was R63):** Path claims, local edits, local deletes, sidecar damage, object store repair, and workspace scans must be tested against a real local filesystem.
- **VERIFY-R05 Daemon coverage (was R64):** `sync --watch` mode must be tested for polling overlap, local file events, restart recovery, queue backpressure, cancellation, and stale lease behavior.
- **VERIFY-R06 Incremental sync coverage (was R64a):** Watch tests must cover checkpoint reuse, same-boundary overlap, incremental absence safety, inline query-row hydration, local-first outbound work, and periodic full-reconcile behavior.
- **VERIFY-R07 Live Notion coverage (was R65):** Supported Notion API semantics must have isolated live E2E coverage with creation, mutation, verification, and cleanup.
- **VERIFY-R08 Guard matrix (was R66):** Every problematic edge case must map to a named guard, expected behavior, and at least one unit, fake integration, SQLite, filesystem, daemon, or live E2E test.

## Acceptable Tradeoffs

Only cross-cutting tradeoffs remain here; the rest moved to their owning sub-systems (see the trace index).

- **VERIFY-T01 Live test cost (was T06):** Live E2E tests may be slower and require secrets because mocks cannot prove Notion API edge semantics.

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
| cross-cutting (this doc) | XC-R01–R03, OBS-R01–R03, VERIFY-R01–R08, VERIFY-T01 | this file                                                                             |

### Original id -> new home

| Original | New id                                 | File                                                                   |
| -------- | -------------------------------------- | ---------------------------------------------------------------------- |
| R01      | XC-R01                                 | requirements.md (this file)                                            |
| R02      | BODY-R01                               | subsystems/body-adapter/requirements.md                                |
| R03      | GW-R01                                 | subsystems/notion-gateway/requirements.md                              |
| R04      | DOMAIN-R01                             | subsystems/domain-model/requirements.md                                |
| R05      | DOMAIN-R02                             | subsystems/domain-model/requirements.md                                |
| R06      | STORE-R01                              | subsystems/sync-store/requirements.md                                  |
| R07      | STORE-R02                              | subsystems/sync-store/requirements.md                                  |
| R08      | STORE-R03                              | subsystems/sync-store/requirements.md                                  |
| R09      | STORE-R04                              | subsystems/sync-store/requirements.md                                  |
| R10      | STORE-R05                              | subsystems/sync-store/requirements.md                                  |
| R11      | STORE-R06                              | subsystems/sync-store/requirements.md                                  |
| R12      | STORE-R07                              | subsystems/sync-store/requirements.md                                  |
| R13      | STORE-R08                              | subsystems/sync-store/requirements.md                                  |
| R14      | DOMAIN-R03                             | subsystems/domain-model/requirements.md                                |
| R15      | DOMAIN-R04                             | subsystems/domain-model/requirements.md                                |
| R16      | DOMAIN-R05                             | subsystems/domain-model/requirements.md                                |
| R17      | DOMAIN-R06                             | subsystems/domain-model/requirements.md                                |
| R18      | DOMAIN-R07                             | subsystems/domain-model/requirements.md                                |
| R19      | DOMAIN-R08                             | subsystems/domain-model/requirements.md                                |
| R20      | DOMAIN-R09                             | subsystems/domain-model/requirements.md                                |
| R21      | PLAN-R01                               | subsystems/planner-guards/requirements.md                              |
| R22      | PLAN-R02                               | subsystems/planner-guards/requirements.md                              |
| R23      | SYNC-R01                               | subsystems/sync-orchestration/requirements.md                          |
| R24      | SYNC-R02                               | subsystems/sync-orchestration/requirements.md                          |
| R25      | XC-R02 (canonical); PLAN-R03 (pointer) | requirements.md (this file); subsystems/planner-guards/requirements.md |
| R26      | PLAN-R04                               | subsystems/planner-guards/requirements.md                              |
| R27      | PLAN-R05                               | subsystems/planner-guards/requirements.md                              |
| R28      | PLAN-R06                               | subsystems/planner-guards/requirements.md                              |
| R29      | PLAN-R07                               | subsystems/planner-guards/requirements.md                              |
| R30      | SCHEMA-R01                             | subsystems/schema-migration/requirements.md                            |
| R31      | SCHEMA-R02                             | subsystems/schema-migration/requirements.md                            |
| R32      | SCHEMA-R03                             | subsystems/schema-migration/requirements.md                            |
| R33      | SCHEMA-R04                             | subsystems/schema-migration/requirements.md                            |
| R34      | SCHEMA-R05                             | subsystems/schema-migration/requirements.md                            |
| R35      | SCHEMA-R06                             | subsystems/schema-migration/requirements.md                            |
| R36      | PLAN-R08                               | subsystems/planner-guards/requirements.md                              |
| R37      | PLAN-R09                               | subsystems/planner-guards/requirements.md                              |
| R38      | PLAN-R10                               | subsystems/planner-guards/requirements.md                              |
| R39      | PLAN-R11                               | subsystems/planner-guards/requirements.md                              |
| R40      | PLAN-R12                               | subsystems/planner-guards/requirements.md                              |
| R41      | PLAN-R13                               | subsystems/planner-guards/requirements.md                              |
| R42      | DAEMON-R01                             | subsystems/watch-daemon/requirements.md                                |
| R43      | DAEMON-R02                             | subsystems/watch-daemon/requirements.md                                |
| R44      | DAEMON-R03                             | subsystems/watch-daemon/requirements.md                                |
| R45      | DAEMON-R04                             | subsystems/watch-daemon/requirements.md                                |
| R46      | DAEMON-R05                             | subsystems/watch-daemon/requirements.md                                |
| R47      | DAEMON-R06                             | subsystems/watch-daemon/requirements.md                                |
| R47a     | DAEMON-R07                             | subsystems/watch-daemon/requirements.md                                |
| R47b     | DAEMON-R08                             | subsystems/watch-daemon/requirements.md                                |
| R47c     | DAEMON-R09                             | subsystems/watch-daemon/requirements.md                                |
| R48      | CLI-R01                                | subsystems/cli/requirements.md                                         |
| R49      | CLI-R02                                | subsystems/cli/requirements.md                                         |
| R50      | CLI-R03                                | subsystems/cli/requirements.md                                         |
| R51      | CLI-R04                                | subsystems/cli/requirements.md                                         |
| R51a     | CLI-R05                                | subsystems/cli/requirements.md                                         |
| R52      | XC-R03                                 | requirements.md (this file)                                            |
| R53      | DOMAIN-R10                             | subsystems/domain-model/requirements.md                                |
| R54      | GW-R02                                 | subsystems/notion-gateway/requirements.md                              |
| R55      | BODY-R02                               | subsystems/body-adapter/requirements.md                                |
| R56      | DAEMON-R10                             | subsystems/watch-daemon/requirements.md                                |
| R57      | OBS-R01                                | requirements.md (this file)                                            |
| R58      | OBS-R02                                | requirements.md (this file)                                            |
| R59      | OBS-R03                                | requirements.md (this file)                                            |
| R60      | VERIFY-R01                             | requirements.md (this file)                                            |
| R61      | VERIFY-R02                             | requirements.md (this file)                                            |
| R62      | VERIFY-R03                             | requirements.md (this file)                                            |
| R63      | VERIFY-R04                             | requirements.md (this file)                                            |
| R64      | VERIFY-R05                             | requirements.md (this file)                                            |
| R64a     | VERIFY-R06                             | requirements.md (this file)                                            |
| R65      | VERIFY-R07                             | requirements.md (this file)                                            |
| R66      | VERIFY-R08                             | requirements.md (this file)                                            |
| R67      | GW-R03                                 | subsystems/notion-gateway/requirements.md                              |
| R68      | GW-R04                                 | subsystems/notion-gateway/requirements.md                              |
| R69      | GW-R05                                 | subsystems/notion-gateway/requirements.md                              |
| R70      | GW-R06                                 | subsystems/notion-gateway/requirements.md                              |
| R71      | GW-R07                                 | subsystems/notion-gateway/requirements.md                              |
| R72      | REPLICA-R01                            | subsystems/replica-api/requirements.md                                 |
| R73      | GW-R08                                 | subsystems/notion-gateway/requirements.md                              |
| R74      | REPLICA-R02                            | subsystems/replica-api/requirements.md                                 |
| R75      | REPLICA-R03                            | subsystems/replica-api/requirements.md                                 |
| R76      | REPLICA-R04                            | subsystems/replica-api/requirements.md                                 |
| R77      | REPLICA-R05                            | subsystems/replica-api/requirements.md                                 |
| R78      | REPLICA-R06                            | subsystems/replica-api/requirements.md                                 |
| R79      | REPLICA-R07                            | subsystems/replica-api/requirements.md                                 |
| R80      | REPLICA-R08                            | subsystems/replica-api/requirements.md                                 |
| R81      | REPLICA-R09                            | subsystems/replica-api/requirements.md                                 |
| A01–A09  | A01–A09 (unchanged)                    | requirements.md (this file)                                            |
| T01      | PLAN-T01                               | subsystems/planner-guards/requirements.md                              |
| T02      | STORE-T01                              | subsystems/sync-store/requirements.md                                  |
| T03      | DAEMON-T01                             | subsystems/watch-daemon/requirements.md                                |
| T04      | SCHEMA-T01                             | subsystems/schema-migration/requirements.md                            |
| T05      | PLAN-T02                               | subsystems/planner-guards/requirements.md                              |
| T06      | VERIFY-T01                             | requirements.md (this file)                                            |
| T07      | GW-T01                                 | subsystems/notion-gateway/requirements.md                              |
| T08      | REPLICA-T01                            | subsystems/replica-api/requirements.md                                 |

> Note: FS-R01–R02 (local-workspace) are not in this table because they were derived from the spec's path-semantics section, not from an original numbered requirement.
