# Testing And Demo

`@overeng/notion-datasource-sync` uses layered tests. Prefer the lowest layer
that proves the behavior, then add live tests only for Notion semantics that fake
services cannot prove.

| Layer       | Command                                                                                                                               | Network | Purpose                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------- |
| Unit        | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/core/contracts.unit.test.ts --config vitest.config.ts`  | no      | schemas, contracts, hashes, guards        |
| Fake E2E    | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/fake-service.e2e.test.ts --config vitest.config.ts` | no      | planner/store/outbox behavior             |
| Body E2E    | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/body-adapter.e2e.test.ts --config vitest.config.ts` | no      | NotionMD adapter boundary                 |
| CLI E2E     | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/cli.e2e.test.ts --config vitest.config.ts`          | no      | CLI parsing, dry-run, adoption safety     |
| Replica E2E | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/replica-*.e2e.test.ts --config vitest.config.ts`    | no      | `notion.sqlite` reads, intents, conflicts |
| Daemon E2E  | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/daemon.e2e.test.ts --config vitest.config.ts`       | no      | watch loop, restart, lease, backpressure  |
| Live Notion | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/live-notion.e2e.test.ts --config vitest.config.ts`  | yes     | real Notion API semantics                 |

Run package TypeScript after code changes:

```sh
pnpm --dir packages/@overeng/notion-datasource-sync exec tsc -p tsconfig.json --pretty false
```

## Live E2E

Live tests are credential-gated:

```sh
export NOTION_API_TOKEN="<notion-integration-token>"
export NOTION_DATASOURCE_SYNC_LIVE=1
export NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID=<dedicated-scratch-parent-page-id>
export NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID=<visible-ledger-page-id>

CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run \
  src/e2e/live-notion.e2e.test.ts --config vitest.config.ts
```

The repo task used by CI is:

```sh
dt test:notion-integration:notion-datasource-sync
```

That task skips when `NOTION_API_TOKEN` is absent. It uses
`NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID` when set and otherwise falls back to
`NOTION_TEST_PARENT_PAGE_ID`, then opts into the live suite with
`NOTION_DATASOURCE_SYNC_LIVE=1`.

The parent page must be a dedicated scratch page shared with the integration.
Tests create isolated temporary data sources and rows under that parent, record
all created objects in a local `tmp/` ledger, and archive fixtures during
cleanup.

The live suite includes `sync --from-notion` adoption semantics against a
disposable data source: dry-run writes no local events, apply records the
binding and observations, and rerun is idempotent.
For read-only checks against a large existing database, use the database URL
with `--dry-run --limit <rows>` first; the limit is a capped preview, not a
partial adoption mode.

Replica tests must prove that establishment creates `notion.sqlite`, that
generic tables and generated views match observed Notion rows, and that local SQL
edits create intents rather than immediate Notion writes. The focused replica
E2E suite covers direct current-state CDC, typed body/lifecycle tables,
metadata CDC planning/settlement, schema CDC fail-closed behavior,
row-create planning/settlement behavior, external URL file staging/attachment,
safe and unsafe conflict-resolution requests, dry-run no-settlement, stale bases,
invalid payloads, and generated view escaping. Dry-run assertions must check
that no replica rows are mutated, no
intents settle, no internal events append, no outbox commands execute, and no
body files materialize.

When `NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID` is set, the suite publishes a
sanitized summary to that Notion page. The ledger must not contain tokens, token
paths, raw private page bodies, signed URLs, or private workspace URLs.

## Automated Demo

The durable showcase is documented in
[`../demo/README.md`](../demo/README.md).

```sh
export NOTION_API_TOKEN="<notion-integration-token>"
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

CI does not run the demo on ordinary PR/push runs. To include it in the Notion
integration lane, dispatch the CI workflow manually with
`run_datasource_sync_demo=true` and provide `NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID`
as a repository secret.

## Live Write Safety

Live sync-up tests may mutate only disposable data sources created by the test
run. They must record fixture IDs in the cleanup ledger, verify read-after-write
state, and archive fixtures during cleanup.

Real user database checks are read-only/downsync only:

- `sync --from-notion <database-url> <workspace> --dry-run --limit <rows>`,
- bounded downsync with `--no-materialize-bodies`,
- local `notion.sqlite` readback comparisons,
- before/after sample checks proving Notion `last_edited_time`, `in_trash`, and
  archive state did not change.

Do not run local write-intent apply tests against real user databases without an
explicit disposable fixture plan and approval.

## Traceability

Scenario metadata lives in `src/testing/scenarios.ts`. The VRS E2E plan maps
requirements and guards to verification levels. Add or update scenario metadata
when adding a new guard, supported surface, or live proof.
