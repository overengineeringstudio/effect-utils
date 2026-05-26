# notion-datasource-sync Demo Fixture

The durable automated demo page is:

https://www.notion.so/overeng-notion-datasource-sync-demo-automated-36cf141b18dc803b98ebd21f2a243453

Use `NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID=36cf141b18dc803b98ebd21f2a243453` when running the credentialed live showcase.

```sh
NOTION_DATASOURCE_SYNC_LIVE=1 \
NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID=36cf141b18dc803b98ebd21f2a243453 \
NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID=36cf141b18dc803b98ebd21f2a243453 \
pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run \
  src/e2e/live-notion.e2e.test.ts --config vitest.config.ts
```

The showcase refreshes the demo page, creates one current inline data source,
adds realistic rows and bodies, observes it through datasource-sync with the live
Notion adapter plus NotionMD body adapter, and appends a sanitized verification
summary. Reruns archive previous demo data-source blocks before creating the new
one so the page stays bounded.

`fixtures.json` records the stable page mapping and the expected automated
surface. Live E2E scratch ledgers remain in local `tmp/` artifacts and the
configured Notion ledger page.
