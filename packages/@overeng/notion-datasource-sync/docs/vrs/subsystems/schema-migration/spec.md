# Schema Migration Spec

Sub-system slice of [spec.md](../../spec.md). Serves [requirements](./requirements.md).

Requirement trace: SCHEMA-R01-SCHEMA-R06, SCHEMA-T01.

This slice specifies schema semantics: the change-policy table, the additive
subset, schema ownership, and the two-phase plan/apply contract. All schema
mutation is CLI-only; the SQLite file never accepts schema-mutating SQL. The
read-only schema surfaces (`schema`, `schema_properties`) are specified in
[../replica-api/spec.md](../replica-api/spec.md), and the schema-affecting
guards (`SchemaDriftAffectsIntent`, `DestructiveSchemaMigrationRequired`,
`OptionDeletionLosesValues`) are defined in the master guard matrix in
[../planner-guards/spec.md](../planner-guards/spec.md).

## CLI-Only Schema Mutation

Schema is changed only through `migrate schema --plan/--apply`. There is no
SQLite write path for schema:

- `schema` and `schema_properties` are read-only in the file (see
  [../replica-api/spec.md](../replica-api/spec.md)).
- `ALTER TABLE rows ...` (DDL) is rejected. SQLite has no DDL triggers, so an
  `ALTER TABLE rows` interception would need an out-of-band parser and would risk
  SQL-column vs property-ID divergence.
- There is no `kind=schema` row in the public `changes` table; schema is not a
  public SQL write intent.
- The file may surface a read-only migration preview (in `sync_status` /
  `debug_*`); apply happens via CLI.

Routing all schema change through the CLI keeps property-ID identity
authoritative and preserves an auditable two-phase plan/apply trail.

## Change Policy

| Change               | Default policy        | Required proof                                         |
| -------------------- | --------------------- | ------------------------------------------------------ |
| Remote rename        | Accept as observation | Same property ID; row value hashes unchanged           |
| Local rename         | Allowed if explicit   | Read current schema, patch, read back same property ID |
| Add property         | Allowed if explicit   | Read current schema, patch, fresh schema hash          |
| Delete property      | Migration only        | List affected rows and values before write             |
| Type conversion      | Migration only        | Show value conversion table and lossy/null conversions |
| Select option add    | Allowed if explicit   | Read-after-write option ID/name state                  |
| Select option delete | Migration only        | Detect rows that currently use removed option          |

The executable schema subset is intentionally additive: add property, rename
property (preserving property ID and row value hashes), and additive
select/multi-select option adds with matching base schema hash. Notion treats
omitted select and multi-select options in an update as removal, so schema
migration requires explicit existing-option evidence before adding options and
does not expose replace/remove semantics. Status properties remain read-only
because the public data-source update API does not support status property
updates.

Destructive schema migrations -- property delete, type conversion, option
removal/rename/replace, status option or group changes, and property reorder --
stay blocked until an impact report computed from fresh observations, explicit
approval, and live proof exist. If any affected row is unavailable, the migration
is blocked rather than estimated.

## Schema Ownership

Schema ownership is explicit per binding:

| Ownership     | Schema write policy                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `userManaged` | Never automatically converge schema. Local schema changes require explicit migration commands.                                |
| `appOwned`    | Additive convergence may be automatic only when the current schema hash matches the expected base and all schema guards pass. |

Automatic schema convergence is allowed only for `appOwned` sources and only
after the schema guards pass. `userManaged` is the default when a binding is
created for an existing data source.

## Two-Phase Plan/Apply

Schema migration commands have two phases:

| Phase | Event/command                                | Required contents                                                                           |
| ----- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Plan  | `LocalIntentAccepted.SchemaMigrationPlanned` | current schema hash, desired schema hash, affected property IDs, row impact summary         |
| Apply | `CommandEnqueued.PatchDataSourceSchema`      | Notion patch, base schema hash, desired schema hash, destructive approval token when needed |

`migrate schema --plan` records the planned intent; `migrate schema --apply`
enqueues the patch command. The row impact summary must be computed from fresh
observations for destructive changes. If any affected row is unavailable, the
migration is blocked rather than estimated.
