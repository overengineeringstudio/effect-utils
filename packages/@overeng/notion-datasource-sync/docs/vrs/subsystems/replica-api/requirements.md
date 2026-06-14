# Replica API Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **REPLICA-R01 Full data-source contract:** User-facing data files must only be created from the full data-source membership query. Query-contract/filter/high-watermark variants are internal test/debug concerns and must not be exposed as establishment or sync modes.
- **REPLICA-R02 Public data file:** Each established workspace must expose one user-facing data file per tracked data source as the stable local SQL/API surface.
- **REPLICA-R03 Internal store boundary:** Private sync-control state must live under hidden implementation state, not as part of the public data-file API. If the implementation uses private SQLite tables internally, they must not be documented or relied on as user-editable API.
- **REPLICA-R04 Portable data surface:** The public data file must remain copyable/back-up-able as user data without requiring users to understand hidden sync-control state. Shared-mode safety still depends on the hidden workspace control plane.
- **REPLICA-R05 Generic read model:** The data file must expose stable public surfaces for `pages`, `schema`, `schema_properties`, `changes`, `conflicts`, `sync_status`, and read-only `debug_*` diagnostics.
- **REPLICA-R06 Ergonomic pages view:** The writable `pages` view must provide property-name columns and tolerate property rename/collision cases.
- **REPLICA-R07 Writable intents:** Local data edits must enter the system as explicit, durable write intents with target identity, base hashes, desired value, actor/source, and conflict policy.
- **REPLICA-R08 Intent safety:** Local SQL writes must not call Notion directly; CLI sync must plan, dry-run, enqueue, execute, verify, and settle intents through the guarded outbox model.
- **REPLICA-R09 Public schema versioning:** The replica API schema must be versioned separately from the internal store schema and generated view definitions.
- **REPLICA-R10 Clean public namespace:** Public data files must expose `pages` as the only writable page/property surface. They must not expose public `rows` aliases or alternate public page tables.
- **REPLICA-R11 Versioned artifact namespace:** Public data files and hidden replica/control-plane artifacts must declare explicit namespace/schema versions and fail closed on unknown or mixed versions.

## Acceptable Tradeoffs

- **REPLICA-T01 Intent ledger staging:** The SQLite API exposes `changes` as a read-only lifecycle ledger. Ordinary supported page/property edits must be accepted through writable `pages` so users do not have to operate planner, outbox, or event internals.
