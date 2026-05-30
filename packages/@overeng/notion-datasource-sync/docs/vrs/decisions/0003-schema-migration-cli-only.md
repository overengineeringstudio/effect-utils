# Schema migration is CLI-only, two-phase, impact-reported

Status: accepted

Schema is its own sub-system (`subsystems/schema-migration/`). All schema
mutation is CLI-only; the SQLite file never accepts schema-mutating SQL.

## Supported (additive), CLI-only

- add property, rename property (preserves property ID + row value hashes),
  add select/multi-select options with explicit existing-option evidence.
- Two-phase: `migrate schema --plan` records
  `LocalIntentAccepted.SchemaMigrationPlanned` (current/desired schema hash,
  affected property IDs, row impact summary); `migrate schema --apply` enqueues
  `CommandEnqueued.PatchDataSourceSchema` with base/desired schema hash and a
  destructive-approval token when required.

## Fail-closed (destructive), CLI-only + impact report

property delete, type conversion, option removal/rename/replace, status option
or group changes, property reorder. Blocked until an impact report computed from
fresh observations, explicit approval, and live proof exist. If any affected row
is unavailable, the migration is blocked rather than estimated.

## Why not a SQLite write path

SQLite has no DDL triggers, so `ALTER TABLE rows` interception would need an
out-of-band parser and risks SQL-column vs property-ID divergence. Routing all
schema change through the CLI keeps property-ID identity authoritative and the
plan/apply audit trail intact. See [[0002-mutation-support-matrix]].
