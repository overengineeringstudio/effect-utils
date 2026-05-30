# Schema Migration Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **SCHEMA-R01 Observe schema drift (was R30):** Remote schema drift must update schema projections and reclassify pending local intents before any write.
- **SCHEMA-R02 Additive schema writes (was R31):** Property adds and non-destructive metadata updates may be automated only after schema preflight and read-after-write verification.
- **SCHEMA-R03 Rename semantics (was R32):** Renames must preserve property ID identity and row values.
- **SCHEMA-R04 Destructive schema writes (was R33):** Property deletion, type conversion, and option deletion must require an explicit migration plan.
- **SCHEMA-R05 Conversion reporting (was R34):** Type conversions must report potentially lossy value mappings before execution.
- **SCHEMA-R06 Option deletion guard (was R35):** Select and multi-select option deletion must detect rows that would lose selected values.

## Acceptable Tradeoffs

- **SCHEMA-T01 Explicit schema migration (was T04):** Schema writes may require a migration document or command even when a single Notion API call could apply the change.
