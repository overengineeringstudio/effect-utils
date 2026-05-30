# Notion Gateway Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **GW-R01 Client boundary (was R03):** Raw Notion HTTP access must remain in the API-client layer; datasource-sync consumes typed gateway services.
- **GW-R02 Gateway ports (was R54):** Datasource sync must depend on typed ports for Notion data sources, pages, page bodies, files, and local storage.
- **GW-R03 Explicit API version (was R67):** Every Notion request must be tied to an explicit Notion API version, and diagnostics must report the version used for observed behavior.
- **GW-R04 Decode drift guard (was R68):** Unknown or changed Notion payload shapes for supported surfaces must produce typed unsupported-state guards without corrupting unaffected projections.
- **GW-R05 Capability preflight (was R69):** Init, doctor, schema writes, and live tests must verify the configured integration can perform the required read, query, update, schema, trash, restore, and parent-access operations before treating failures as data facts.
- **GW-R06 Compatibility proof (was R70):** A changed Notion API version or capability model must require fake-service coverage and at least one live smoke test before it is accepted as supported.
- **GW-R07 Pagination completeness (was R71):** Product remote data-source queries must page the full database until Notion reports completion; partial pages, cursor failures, capped previews, or interrupted scans must not advance completeness checkpoints or classify absence.
- **GW-R08 Filtered absence (was R73):** Filtered queries and views must not imply deletion or movement for product replicas. They may only remain in private debug/test paths that do not create database-ID-named files.

## Acceptable Tradeoffs

- **GW-T01 Version conservatism (was T07):** The system may require an explicit compatibility update before accepting changed Notion API shapes or newly available capabilities.
