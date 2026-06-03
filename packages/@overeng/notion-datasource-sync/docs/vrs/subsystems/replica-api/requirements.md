# Replica API Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **REPLICA-R01 Full replica contract:** User-facing `<database-id>.sqlite` files must only be created from the full database membership query. Query-contract/filter/high-watermark variants are internal test/debug concerns and must not be exposed as establishment or sync modes.
- **REPLICA-R02 Public replica file:** Each established workspace must expose one `<database-id>.sqlite` file as the stable user-facing local replica/API.
- **REPLICA-R03 Internal store boundary:** Private sync-control state must live inside `_nds_*` tables in that same SQLite file and must not be documented as user-editable API.
- **REPLICA-R04 Portable replica:** `<database-id>.sqlite` must remain copyable/back-up-able without required config or store sidecars while preserving accepted intents, conflicts, and settlement state.
- **REPLICA-R05 Generic read model:** The replica must expose stable public surfaces for `rows`, `schema`, `schema_properties`, `changes`, `conflicts`, `sync_status`, and read-only `debug_*` diagnostics.
- **REPLICA-R06 Ergonomic rows view:** The writable `rows` view must provide property-name columns and tolerate property rename/collision cases.
- **REPLICA-R07 Writable intents:** Local data edits must enter the system as explicit, durable write intents with target identity, base hashes, desired value, actor/source, and conflict policy.
- **REPLICA-R08 Intent safety:** Local SQL writes must not call Notion directly; CLI sync must plan, dry-run, enqueue, execute, verify, and settle intents through the guarded outbox model.
- **REPLICA-R09 Public schema versioning:** The replica API schema must be versioned separately from the internal store schema and generated view definitions.

## Acceptable Tradeoffs

- **REPLICA-T01 Intent ledger staging:** The SQLite API exposes `changes` as a read-only lifecycle ledger. Ordinary supported row edits must be accepted through writable `rows` so users do not have to operate planner, outbox, or event internals.
