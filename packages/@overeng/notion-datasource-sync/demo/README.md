# notion-datasource-sync Demo Fixture

The durable automated demo page is:

https://www.notion.so/overeng-notion-datasource-sync-demo-automated-36cf141b18dc803b98ebd21f2a243453

Use `NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID=36cf141b18dc803b98ebd21f2a243453` when running the credentialed live showcase.

```sh
NOTION_DATASOURCE_SYNC_LIVE=1 \
NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID=36cf141b18dc803b98ebd21f2a243453 \
NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID=36cf141b18dc803b98ebd21f2a243453 \
CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run \
  src/e2e/live-notion.e2e.test.ts --config vitest.config.ts
```

The same showcase runs through the repo task when
`NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID` is set:

```sh
dt test:notion-integration:notion-datasource-sync
```

The showcase refreshes the demo page, ensures four current inline data sources,
patches meaningful data-source descriptions through the datasource-sync metadata
surface, tops them up to the requested row counts, observes them through
datasource-sync with the live Notion adapter plus NotionMD body adapter, and
appends a sanitized verification summary. Each data source/database is
demonstrated as its own `<database-id>.sqlite` artifact with a canonical `rows`
table rather than as one combined multi-source SQLite database. Filenames use
the Notion database ID, not the visible database title. The showcase uses
default schema observation: no schema JSON is supplied, and each artifact derives
`schema_properties` and `rows` columns from the live Notion properties. Reruns
reuse the current demo data sources and archive stale extras so the page stays
bounded without rebuilding hundreds of Notion pages each time.

Current domains and cardinalities:

- Projects DB: 12 rows with body materialization, URL, select, multi-select,
  date, checkbox, number, and rich text properties. Demonstrates a medium-width
  operational table and body synchronization.
- Incidents DB: 30 rows with severity, owner/status metadata, timestamps, and
  runbook-style fields. Demonstrates status-heavy incident tracking.
- Customers DB: 48 rows with email, phone, ARR, renewal, plan, region, and
  health properties. Demonstrates CRM-style scalar diversity.
- Activity events DB: 500 rows proving high-cardinality paginated observation
  with bounded live writes. Demonstrates a narrow event-log shape.

Expected local artifact shape:

```text
demo-workspace/
  <projects-database-id>.sqlite
  <incidents-database-id>.sqlite
  <customers-database-id>.sqlite
  <activity-events-database-id>.sqlite
```

The 500-row activity source proves datasource query pagination and row
cardinality through full database replicas only. Per-row property pagination
and body materialization stay on the smaller sources so the live demo remains
bounded under Notion API rate limits. The demo does not use filtered or partial
query-contract replicas.
No live/synced SQLite databases are checked in. Any fixture checked into this
directory must be deterministic synthetic metadata, not private Notion content
or a binary replica.

`fixtures.json` records the stable page mapping and the expected automated
surface. Live E2E scratch ledgers remain in local `tmp/` artifacts and the
configured Notion ledger page.
