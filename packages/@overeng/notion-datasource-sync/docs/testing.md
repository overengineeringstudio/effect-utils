# Testing And Demo

`@overeng/notion-datasource-sync` uses layered tests. Prefer the lowest layer
that proves the behavior, then add live tests only for Notion semantics that fake
services cannot prove.

| Layer       | Command                                                                                                                                    | Network | Purpose                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ---------------------------------------- |
| Unit        | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/core/contracts.unit.test.ts --config vitest.config.ts`       | no      | schemas, contracts, hashes, guards       |
| Fake E2E    | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/fake-service.e2e.test.ts --config vitest.config.ts`      | no      | planner/store/outbox behavior            |
| Body E2E    | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/body-adapter.e2e.test.ts --config vitest.config.ts`      | no      | NotionMD adapter boundary                |
| Daemon E2E  | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/daemon.e2e.test.ts --config vitest.config.ts`            | no      | watch loop, restart, lease, backpressure |
| Live Notion | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/live-notion.e2e.test.ts --config vitest.config.ts`       | yes     | real Notion API semantics                |

Run package TypeScript after code changes:

```sh
pnpm --dir packages/@overeng/notion-datasource-sync exec tsc -p tsconfig.json --pretty false
```

## Live E2E

Live tests are credential-gated:

```sh
export NOTION_API_TOKEN="secret_..."
export NOTION_DATASOURCE_SYNC_LIVE=1
export NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID=<dedicated-scratch-parent-page-id>
export NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID=<visible-ledger-page-id>

CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run \
  src/e2e/live-notion.e2e.test.ts --config vitest.config.ts
```

The parent page must be a dedicated scratch page shared with the integration.
Tests create isolated temporary data sources and rows under that parent, record
all created objects in a local `tmp/` ledger, and archive fixtures during
cleanup.

When `NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID` is set, the suite publishes a
sanitized summary to that Notion page. The ledger must not contain tokens, token
paths, raw private page bodies, signed URLs, or private workspace URLs.

## Automated Demo

The durable showcase is documented in
[`../demo/README.md`](../demo/README.md).

```sh
export NOTION_API_TOKEN="secret_..."
export NOTION_DATASOURCE_SYNC_LIVE=1
export NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID=<demo-page-id>
export NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID=<demo-page-id>

CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run \
  src/e2e/live-notion.e2e.test.ts --config vitest.config.ts \
  -t 'refreshes the visible demo page with a datasource-sync showcase'
```

The demo refreshes one durable Notion page, archives stale demo data-source
blocks, creates multiple current inline data sources with different schemas, and
includes a 500-row activity source for high-cardinality query pagination.

## Traceability

Scenario metadata lives in `src/testing/scenarios.ts`. The VRS E2E plan maps
requirements and guards to verification levels. Add or update scenario metadata
when adding a new guard, supported surface, or live proof.
