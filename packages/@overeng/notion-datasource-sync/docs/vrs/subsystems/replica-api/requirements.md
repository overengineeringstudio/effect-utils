# Replica API Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **REPLICA-R01 Full replica contract (was R72):** User-facing `<database-id>.sqlite` files must only be created from the full database membership query. Query-contract/filter/high-watermark variants are internal test/debug concerns and must not be exposed as establishment or sync modes.
- **REPLICA-R02 Public replica file (was R74):** Each established workspace must expose one `<database-id>.sqlite` file as the stable user-facing local replica/API.
- **REPLICA-R03 Internal store boundary (was R75):** Private sync-control state must live inside `_nds_*` tables in that same SQLite file and must not be documented as user-editable API.
- **REPLICA-R04 Portable replica (was R76):** `<database-id>.sqlite` must remain copyable/back-up-able without required config or store sidecars while preserving accepted intents, conflicts, and settlement state.
- **REPLICA-R05 Generic read model (was R77):** The replica must expose stable public surfaces for `rows`, `schema`, `schema_properties`, `changes`, `conflicts`, `sync_status`, and read-only `debug_*` diagnostics.
- **REPLICA-R06 Ergonomic rows view (was R78):** The writable `rows` view must provide property-name columns and tolerate property rename/collision cases.
- **REPLICA-R07 Writable intents (was R79):** Local data edits must enter the system as explicit, durable write intents with target identity, base hashes, desired value, actor/source, and conflict policy.
- **REPLICA-R08 Intent safety (was R80):** Local SQL writes must not call Notion directly; CLI sync must plan, dry-run, enqueue, execute, verify, and settle intents through the guarded outbox model.
- **REPLICA-R09 Public schema versioning (was R81):** The replica API schema must be versioned separately from the internal store schema and generated view definitions.

## Acceptable Tradeoffs

- **REPLICA-T01 Intent-first writes (was T08):** The user-facing SQLite API may require explicit write-intent rows before writable SQL views exist, because every local edit needs reviewable guards, dry-run behavior, and conflict detection.
