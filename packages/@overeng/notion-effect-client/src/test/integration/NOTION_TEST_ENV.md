# Notion Test Environment

The `@overeng/notion-effect-client` integration tests create isolated live
fixtures for each Vitest process instead of depending on durable page or
database IDs in a shared Notion workspace.

## Prerequisites

- `NOTION_API_TOKEN`: a Notion integration token
- `NOTION_TEST_PARENT_PAGE_ID`: a dedicated scratch parent page shared with the
  integration token

`NOTION_MD_TEST_PARENT_PAGE_ID` is accepted as a legacy fallback, but new CI and
local setups should use `NOTION_TEST_PARENT_PAGE_ID`.

## Fixture Lifecycle

At startup, `setupIntegrationFixtures` verifies that the token can retrieve the
configured parent page, then creates a temporary run root under that parent. All
pages, blocks, databases, data sources, and rows used by the tests are created
under that run root.

During teardown, the run root page and its database are archived. A failed or
interrupted run may leave an archived-or-active scratch child page named
`effect-utils notion live fixture: ...`; those pages can be safely deleted after
confirming no test process is still running.

## Test Fixtures

The provisioned fixture set includes:

- a root page for the current test run,
- a page containing representative block types,
- a nested page for recursive block fetching,
- a rich text page,
- an empty mutation page,
- a database with one data source and Alpha, Beta, and Gamma rows.

The current IDs are exported from `setup.ts` as `TEST_IDS` after
`setupIntegrationFixtures` completes. Tests must not hard-code Notion object IDs.

## Running Tests

```bash
NOTION_TEST_PARENT_PAGE_ID=<scratch-parent-page-id> dt test:notion-effect-client
```

The broader Notion integration lane also uses the same scratch parent:

```bash
NOTION_TEST_PARENT_PAGE_ID=<scratch-parent-page-id> dt test:integration
```
