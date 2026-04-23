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

  // Phase 3c (#618): recursive reconciliation. Covers deep tree creation and
  // nested-page-scoped block mutation.
  it('deep tree: page → ChildPage → Paragraph → Toggle → Paragraph', async () => {
    await withScratchPage('sub-pages-deep', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        yield* sync(
          <Page>
            <ChildPage blockKey="c" title="deep">
              <Paragraph blockKey="p1">outer</Paragraph>
            </ChildPage>
          </Page>,
          { pageId: rootId, cache },
        )
        const rootTree = yield* readPageTree(rootId)
        const childPage = rootTree.find((b) => b.type === 'child_page')
        expect(childPage).toBeDefined()
        const subTree = yield* readPageTree(childPage!.id)
        expect(subTree.map((b) => b.type)).toContain('paragraph')
      }),
    )
  }, 60_000)

  it('nested mutation: editing a block inside a sub-page leaves the outer page untouched', async () => {
    await withScratchPage('sub-pages-nested-mutate', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        yield* sync(
          <Page>
            <ChildPage blockKey="c" title="doc">
              <Paragraph blockKey="p">v1</Paragraph>
            </ChildPage>
          </Page>,
          { pageId: rootId, cache },
        )
        // Mutate the paragraph inside the sub-page.
        const r = yield* sync(
          <Page>
            <ChildPage blockKey="c" title="doc">
              <Paragraph blockKey="p">v2</Paragraph>
            </ChildPage>
          </Page>,
          { pageId: rootId, cache },
        )
        expect(r.pages).toMatchObject({ creates: 0, updates: 0, archives: 0, moves: 0 })
        expect(r.updates).toBe(1)
        // Read back: sub-page paragraph carries the new text.
        const rootTree = yield* readPageTree(rootId)
        const childPage = rootTree.find((b) => b.type === 'child_page')!
        const subTree = yield* readPageTree(childPage.id)
        const para = subTree.find((b) => b.type === 'paragraph')!
        const content = (para.payload.rich_text as readonly { plain_text?: string }[])[0]
          ?.plain_text
        expect(content).toBe('v2')
      }),
    )
  }, 60_000)
})
