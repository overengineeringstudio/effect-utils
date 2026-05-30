# Domain Model Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **DOMAIN-R01 Domain boundary (was R04):** Data-source, row, schema, property, body-pointer, file, conflict, and outbox concepts must have domain types independent from local file layout.
- **DOMAIN-R02 Data-source identity (was R05):** Sync identity must use stable `data_source_id` values for table membership and schema decisions.
- **DOMAIN-R03 Property IDs (was R14):** Data-source properties must be keyed by Notion property ID. Display names are labels and may change.
- **DOMAIN-R04 Schema hash (was R15):** Schema projections must hash property IDs, property types, and type configuration; display names must not be the row-value identity.
- **DOMAIN-R05 Row value hash (was R16):** Row property values must have stable canonical hashes independent from JSON field ordering and display-name changes.
- **DOMAIN-R06 Body pointer (was R17):** A row page body must be represented as a pointer to body sync state, not flattened into row properties.
- **DOMAIN-R07 Computed properties (was R18):** Formula, rollup, created-time, created-by, last-edited-time, last-edited-by, unique-id, and other computed/system properties must be read-only locally; attempted local writes must be rejected before enqueueing remote commands.
- **DOMAIN-R08 Relation references (was R19):** Relations must store target page IDs and availability state so inaccessible targets cannot be silently dropped.
- **DOMAIN-R09 File references (was R20):** File and media properties must preserve stable metadata and availability while treating expiring Notion URLs as observation artifacts, not durable identifiers.
- **DOMAIN-R10 Shared schemas (was R53):** Wire schemas and canonicalizers must be reusable by datasource-sync, NotionMD, Notion React, and CLI tooling.
