# Testing And Demo

`@overeng/notion-datasource-sync` uses layered tests. Prefer the lowest layer
that proves the behavior, then add live tests only for Notion semantics that fake
services cannot prove.

| Layer       | Command                                                                                                                               | Network | Purpose                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------- |
| Unit        | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/core/contracts.unit.test.ts --config vitest.config.ts`  | no      | schemas, contracts, hashes, guards                         |
| Fake E2E    | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/fake-service.e2e.test.ts --config vitest.config.ts` | no      | planner/store/outbox behavior                              |
| Body E2E    | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/body-adapter.e2e.test.ts --config vitest.config.ts` | no      | NotionMD adapter boundary                                  |
| CLI E2E     | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/cli.e2e.test.ts --config vitest.config.ts`          | no      | CLI parsing, dry-run, adoption safety, webhook status seam |
| Replica E2E | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/replica-*.e2e.test.ts --config vitest.config.ts`    | no      | `<database-id>.sqlite` reads, intents, conflicts           |
| Daemon E2E  | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/daemon.e2e.test.ts --config vitest.config.ts`       | no      | `sync --watch` loop, local SQLite CDC, restart, lease      |
| Live Notion | `CI=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/live-notion.e2e.test.ts --config vitest.config.ts`  | yes     | real Notion API semantics                                  |

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
disposable database/data source with title, checkbox, rich text, number, select,
and date properties. It omits schema JSON, proves the live schema is discovered
into `schema_properties`, projects values into `rows`, and verifies `rows`
property columns precede `_` system columns.
For read-only checks against a large existing database, use the database URL
with `--dry-run --limit <rows>` first; the limit is a capped preview, not a
partial adoption mode.

Replica tests must prove that establishment creates
`<workspace>/<database-id>.sqlite`, that the filename uses the Notion database
ID rather than the display name, that multiple databases establish as separate
SQLite files, and that no `.notion-datasource-sync/store.sqlite` or config
sidecar is required state. `rows`, `schema`, `schema_properties`, `changes`,
`conflicts`, `sync_status`, and read-only `debug_*` views must match observed
Notion rows, while private `_nds_*` tables remain non-public.

Daemon tests must prove that `sync --watch <workspace>` processes the same public
SQLite CDC as `sync <workspace>`. A pending `rows` update, insert, or lifecycle
change must be read from `changes`, planned through the shared planner,
executed through the outbox when safe, and reflected back through `changes`,
`conflicts`, and `sync_status`. Remote polling coverage alone is not sufficient
watch-mode coverage.

The focused replica E2E suite covers direct current-state CDC, body/lifecycle
changes, metadata planning/settlement, schema fail-closed behavior, row-create
planning/settlement behavior, external URL file staging/attachment, safe and
unsafe conflict-resolution requests, dry-run no-settlement, stale bases, invalid
payloads, generated/debug view escaping, database-ID filename portability,
backup/copy via SQLite checkpoint/backup semantics, and fail-closed tamper
detection for `_nds_*` state. Dry-run assertions must check that no public rows
are mutated, no intents settle, no private events append, no outbox commands
execute, and no body files materialize.

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
Current acceptance proves that each data source/database is represented as its
own `<database-id>.sqlite` file with realistic schemas/cardinality, bounded
page-query progress, and capped dry-run behavior. Full streaming projection of
arbitrarily large `rows` rebuilds is a follow-up once replica rebuilds no longer
materialize a whole observed batch in memory.

Regression follow-up: keep large-replica verification bounded until full
streaming public-replica rebuilds are proven. Bounded previews and targeted
scratch-row checks must not be documented or implemented as partial product
replicas.

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
- local `<database-id>.sqlite` readback comparisons,
- before/after sample checks proving Notion `last_edited_time`, `in_trash`, and
  archive state did not change.

Do not run local write-intent apply tests against real user databases without an
explicit disposable fixture plan and approval.

## Traceability

Scenario metadata lives in `src/testing/scenarios.ts`. The VRS E2E plan maps
requirements and guards to verification levels. Add or update scenario metadata
when adding a new guard, supported surface, or live proof.

Required coverage for the self-contained SQLite contract:

- database-ID filename creation and display-name rename safety,
- multi-database workspace with one SQLite file per Notion database,
- full database replica semantics; filtered/query-contract scans are internal
  test/debug inputs only,
- public surface shape: `rows`, `schema`, `schema_properties`, `changes`,
  `conflicts`, `sync_status`,
- `rows` as the primary writable API, including `sync --watch` processing of local CDC,
- read-only `debug_*` diagnostics,
- private `_nds_*` tamper/corruption fail-closed behavior,
- copy/backup portability using SQLite checkpoint/backup semantics,
- live scratch adoption and readback without split-store state.
