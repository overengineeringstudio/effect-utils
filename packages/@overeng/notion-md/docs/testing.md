# Testing

`@overeng/notion-md` has three useful verification layers.

| Layer       | Command                                                                                                                                 | Network | Purpose                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------ |
| Unit        | `CI=1 pnpm --dir packages/@overeng/notion-md exec vitest run src/merge.test.ts`                                                         | no      | pure merge/update planning                             |
| Fake E2E    | `CI=1 pnpm --dir packages/@overeng/notion-md exec vitest run src/sync.e2e.test.ts`                                                      | no      | full sync behavior with fake Notion gateway            |
| Live Notion | `CI=1 pnpm --dir packages/@overeng/notion-md exec vitest run src/live.integration.test.ts --config vitest.integration.config.ts`        | yes     | real Notion Markdown, page, block APIs                 |
| Live Corpus | `CI=1 pnpm --dir packages/@overeng/notion-md exec vitest run src/corpus-live.integration.test.ts --config vitest.integration.config.ts` | yes     | verify the checked fidelity corpus against real Notion |

Live Notion tests require:

- `NOTION_API_TOKEN`
- `NOTION_TEST_PARENT_PAGE_ID`

The configured parent must be a dedicated scratch page shared with the
integration token.

## Live Corpus Refresh

The checked fidelity corpus in `src/corpus/fidelity-corpus.ts` is captured from
real Notion through the same block-observation renderer used by `pullPage`.
Normal verification compares the checked corpus values against a fresh live
capture.

To intentionally refresh the checked corpus values, run:

```bash
NOTION_MD_CAPTURE_CORPUS=1 \
NOTION_API_TOKEN=<notion-integration-token> \
NOTION_TEST_PARENT_PAGE_ID=<scratch-parent-page-id> \
CI=1 pnpm --dir packages/@overeng/notion-md exec vitest run src/corpus-live.integration.test.ts --config vitest.integration.config.ts
```

Review the resulting `src/corpus/fidelity-corpus.ts` diff before committing it.

## Live E2E Page Policy

The E2E parent is not a report archive. Tests create short-lived scratch child
pages named `notion-md e2e: ...` and archive them during teardown.

To make the page visibly useful, the suite also maintains a durable child page
named `notion-md e2e run ledger`. Each live run updates that ledger with:

- latest pass/fail status,
- start and finish timestamps,
- Git SHA or `local`,
- GitHub run id or `local`,
- number of stale scratch pages archived before the run,
- per-test duration and error message when a test fails.

If the parent appears empty in Notion, check whether the integration token can
see child pages and whether the ledger child page exists. A successful live run
should leave the ledger visible and no active `notion-md e2e:` scratch pages.

## Demo Fixture

The live E2E parent is for tests. The durable showcase is separate:

https://www.notion.so/overeng-notion-md-demo-automated-369f141b18dc80e4850cff344ad5b48e

Its local counterpart is
[`../demo/showcase.nmd`](../demo/showcase.nmd).
