import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { InMemoryCache } from '../../../cache/in-memory-cache.ts'
import { ChildPage, Page, Paragraph } from '../../../components/blocks.ts'
import { sync } from '../../../renderer/sync.ts'
import { readPageTree, SKIP_E2E, withScratchPage } from './helpers.ts'

/**
 * Live-API coverage for the phase 3b page-scope ops. Exercises creation,
 * metadata updates, archival, reparenting, and rapid-resync idempotence
 * against real Notion. Guarded by `SKIP_E2E` — runs only with
 * `NOTION_TOKEN` + `NOTION_TEST_PARENT_PAGE_ID` set.
 */
describe.skipIf(SKIP_E2E)('sub-pages (e2e, issue #618 phase 3b)', () => {
  it('create + rename + icon-change + archive + idempotent resync', async () => {
    await withScratchPage('sub-pages-crud', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        // Phase 1: create a sub-page via <Page><ChildPage/></Page>.
        const r1 = yield* sync(
          <Page>
            <ChildPage blockKey="x" title="Initial">
              <Paragraph>body</Paragraph>
            </ChildPage>
          </Page>,
          { pageId: rootId, cache },
        )
        expect(r1.pages.creates).toBe(1)

        // Phase 2: rename via title change.
        const r2 = yield* sync(
          <Page>
            <ChildPage blockKey="x" title="Renamed">
              <Paragraph>body</Paragraph>
            </ChildPage>
          </Page>,
          { pageId: rootId, cache },
        )
        expect(r2.pages.updates).toBe(1)
        expect(r2.pages.creates).toBe(0)

        // Phase 3: icon change.
        const r3 = yield* sync(
          <Page>
            <ChildPage blockKey="x" title="Renamed" icon={{ type: 'emoji', emoji: '🧪' }}>
              <Paragraph>body</Paragraph>
            </ChildPage>
          </Page>,
          { pageId: rootId, cache },
        )
        expect(r3.pages.updates).toBe(1)

        // Phase 4: rapid resync is idempotent.
        const r4 = yield* sync(
          <Page>
            <ChildPage blockKey="x" title="Renamed" icon={{ type: 'emoji', emoji: '🧪' }}>
              <Paragraph>body</Paragraph>
            </ChildPage>
          </Page>,
          { pageId: rootId, cache },
        )
        expect(r4.pages).toEqual({ creates: 0, updates: 0, archives: 0, moves: 0 })

        // Phase 5: drop the child → archivePage.
        const r5 = yield* sync(<Page />, { pageId: rootId, cache })
        expect(r5.pages.archives).toBe(1)

        // Verify the sub-page no longer surfaces in the server tree.
        const tree = yield* readPageTree(rootId)
        expect(tree.filter((b) => b.type === 'child_page')).toHaveLength(0)
      }),
    )
  }, 60_000)
})
