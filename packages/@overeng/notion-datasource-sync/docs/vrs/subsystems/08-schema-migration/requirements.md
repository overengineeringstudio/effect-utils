# Schema Migration Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **SCHEMA-R01 Observe schema drift:** Remote schema drift must update schema projections and reclassify pending local intents before any write.
- **SCHEMA-R02 Additive schema writes:** Property adds and non-destructive metadata updates may be automated only after schema preflight and read-after-write verification.
- **SCHEMA-R03 Rename semantics:** Renames must preserve property ID identity and row values.
- **SCHEMA-R04 Destructive schema writes:** Property deletion, type conversion, and option deletion must require an explicit migration plan.
- **SCHEMA-R05 Conversion reporting:** Type conversions must report potentially lossy value mappings before execution.
- **SCHEMA-R06 Option deletion guard:** Select and multi-select option deletion must detect rows that would lose selected values.

## Acceptable Tradeoffs

- **SCHEMA-T01 Explicit schema migration:** Schema writes may require a migration document or command even when a single Notion API call could apply the change.
