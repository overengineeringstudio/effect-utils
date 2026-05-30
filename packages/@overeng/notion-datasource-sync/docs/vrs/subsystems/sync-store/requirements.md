# Sync Store Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **STORE-R01 SQLite authority (was R06):** SQLite must be the authoritative local source for events, accepted local intent, outbox lifecycle, conflicts, tombstones, path claims, leases, checkpoints, and migrations.
- **STORE-R02 Append-only events (was R07):** Domain history must be recorded as versioned append-only events with payload hashes and idempotency keys.
- **STORE-R03 Deterministic projections (was R08):** Projections must be rebuildable from events and produce deterministic digests for the same event history.
- **STORE-R04 Durable local intent (was R09):** A local edit is considered accepted only after its intent event commits.
- **STORE-R05 Network isolation (was R10):** Network writes must never run inside SQLite transactions.
- **STORE-R06 Outbox settlement (was R11):** Remote command settlement must be idempotent; the first verified settlement wins and later retries must not corrupt projections.
- **STORE-R07 Store migrations (was R12):** SQLite schema migrations must be versioned, testable, forward-only, and able to preserve replayability.
- **STORE-R08 Raw retention (was R13):** Raw Notion payload retention must be opt-in or TTL-bound and must exclude credentials, full private bodies, and signed file URLs from logs.

## Acceptable Tradeoffs

- **STORE-T01 Store complexity (was T02):** SQLite introduces migrations and operational complexity because replayability, crash recovery, and auditability are required.
