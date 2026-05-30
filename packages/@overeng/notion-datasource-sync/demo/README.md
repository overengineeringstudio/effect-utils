# notion-datasource-sync Demo Fixture

The durable automated demo page is:

https://www.notion.so/overeng-notion-datasource-sync-demo-automated-36cf141b18dc803b98ebd21f2a243453

The checked-in source of truth for the demo is `src/demo/live-demo.ts`. It
records the page ID, database IDs, data-source IDs, expected property names, and
row counts for the current online demo. Local SQLite files are generated from
that page by credentialed automation and are not committed.

Run the read-only verifier and fast local replica proof with a Notion token that
can read the demo page:

```sh
export NOTION_API_TOKEN="secret_..."
pnpm --dir packages/@overeng/notion-datasource-sync run demo:verify
```

The same verifier is part of the repo Notion integration task:

```sh
dt test:notion-integration:notion-datasource-sync
```

The fast verifier checks the live page/database/data-source mapping, validates
the online schema and row counts for all four data sources, then generates local
SQLite replicas for the three smaller sources. Each source is represented as its
own `<database-id>.sqlite` artifact with a canonical `rows` table rather than as
one combined multi-source SQLite database. Filenames use the Notion database ID,
not the visible database title. The verifier uses default schema observation:
no schema JSON is supplied, and each artifact derives `schema_properties` and
`rows` columns from the live Notion properties.

Current domains and cardinalities:

- Projects DB: 12 rows with URL, select, multi-select, date, checkbox, number,
  and rich text properties. Demonstrates a medium-width operational table.
- Incidents DB: 30 rows with severity, owner/status metadata, timestamps, and
  runbook-style fields. Demonstrates status-heavy incident tracking.
- Customers DB: 48 rows with email, phone, ARR, renewal, plan, region, and
  health properties. Demonstrates CRM-style scalar diversity.
- Activity events DB: 500 rows proving high-cardinality paginated observation.
  Demonstrates a narrow event-log shape.

Expected local artifact shape:

```text
demo-workspace/
  <projects-database-id>.sqlite
  <incidents-database-id>.sqlite
  <customers-database-id>.sqlite
  <activity-events-database-id>.sqlite
```

The default `demo:verify` lane validates the 500-row activity source online but
does not generate the full local activity replica, because that path is
rate-limit-heavy. Run the full local replica proof explicitly:

```sh
export NOTION_API_TOKEN="secret_..."
pnpm --dir packages/@overeng/notion-datasource-sync run demo:verify:full
```

Do not check in SQLite replicas produced from live/private Notion workspaces.
The current demo intentionally commits the manifest and automation only.

`fixtures.json` points to the stable page mapping and manifest source. Live E2E
scratch ledgers remain in local `tmp/` artifacts and the configured Notion
ledger page.
