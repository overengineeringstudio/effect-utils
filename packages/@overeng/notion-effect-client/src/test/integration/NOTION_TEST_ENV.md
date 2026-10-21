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

Search tests create their own uniquely titled page under the scratch parent and
a database with the same run-scoped title beneath that page. The query/title is
a single random token, without shared fixture-name words. They poll search every
two seconds until both the page and data source are indexed, with a 60-second
total polling timeout (including HTTP retries). Stream readiness stops
inclusively after observing every required fixture ID, rather than exhausting
unrelated workspace results at one result per request. Missing fixtures still
fail readiness; the deadline is unchanged. The database and page are archived
when the test scope closes, including on assertion failure.

Each search readiness shape logs diagnostics on success and failure: time spent
in the shape and since polling began, completed page count, fixture and
non-fixture result counts, and cursor-chain mismatches. Result counts include
repeated observations across polling attempts. Per-page details and cursor-cycle
tracking are bounded to 100 entries; aggregate counts cover all observed pages.
Cursor comparisons use full SHA-256 hashes, while logs retain only hash prefixes,
never raw cursors, queries, or titles. The first page of each polling attempt has
no predecessor, so its cursor-chain comparison is `null`.

The offline `search.unit.test.ts` tests use the existing HTTP fixture layer to
cover both manual and exhaustive streamed pagination with opaque Unicode
cursors, an empty non-terminal page, and a terminal null cursor. They also cover
the live fixture consumer with unrelated results before/between fixtures, an
unbounded unrelated tail, missing fixtures, and fresh state on each execution.
They need no credentials and never contact Notion.

Without a scratch parent, fixture-backed tests are skipped via
`SKIP_FIXTURE_INTEGRATION`. Token-only search checks validate response objects
and empty-query handling without requiring any workspace content. Without a
token, all live integration tests are skipped.

Live HTTP cases use `Vitest.it.live`, not `Vitest.it.effect`. The latter
installs a virtual `TestClock`: without an explicit clock adjustment, even a
one-second retry backoff never elapses and the outer Vitest timeout fires.
Fixture provisioning remains in `beforeAll`, outside each test's timeout.
Unit retry tests use the virtual clock only when they explicitly advance it.

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
NOTION_TEST_PARENT_PAGE_ID=<scratch-parent-page-id> devenv tasks run test:notion-effect-client
```

The broader Notion integration lane also uses the same scratch parent:

```bash
NOTION_TEST_PARENT_PAGE_ID=<scratch-parent-page-id> devenv tasks run test:integration
```
