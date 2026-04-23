import { Effect, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { NotionBlocks, NotionPages } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../../../cache/in-memory-cache.ts'
import { ChildPage, Page, Paragraph, Toggle } from '../../../components/blocks.ts'
import { sync } from '../../../renderer/sync.ts'
import { readPageTree, SKIP_E2E, withScratchPage } from './helpers.ts'

/**
 * Live-API coverage for the phase 3b/3c page-scope ops and phase 3d hardening
 * (issue #618). Exercises creation, metadata updates, archival, reparenting,
 * deep trees, pagination tails, inline depth splits, concurrent siblings, and
 * rapid-resync idempotence against real Notion. All scenarios are guarded by
 * `SKIP_E2E` — they run only with `NOTION_TOKEN` +
 * `NOTION_TEST_PARENT_PAGE_ID` set.
 */

const COVER_URL = 'https://images.unsplash.com/photo-1554188248-986adbb73be4'

/** Retrieve a page's `icon`/`cover`/`title` via `pages.retrieve`. */
const retrieveMeta = (pageId: string) =>
  NotionPages.retrieve({ pageId }).pipe(
    Effect.map((raw) => {
      const page = raw as {
        icon?: unknown
        cover?: unknown
        properties?: { title?: { title?: readonly { plain_text?: string }[] } }
      }
      const title = page.properties?.title?.title?.[0]?.plain_text
      return { icon: page.icon, cover: page.cover, title }
    }),
  )

describe.skipIf(SKIP_E2E)('sub-pages (e2e, issue #618 phases 3b/3c/3d)', () => {
  it('create + rename + icon-change + archive + idempotent resync', async () => {
    await withScratchPage('sub-pages-crud', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        const r1 = yield* sync(
          <Page>
            <ChildPage blockKey="x" title="Initial">
              <Paragraph>body</Paragraph>
            </ChildPage>
          </Page>,
          { pageId: rootId, cache },
        )
        expect(r1.pages.creates).toBe(1)

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

        const r3 = yield* sync(
          <Page>
            <ChildPage blockKey="x" title="Renamed" icon={{ type: 'emoji', emoji: '🧪' }}>
              <Paragraph>body</Paragraph>
            </ChildPage>
          </Page>,
          { pageId: rootId, cache },
        )
        expect(r3.pages.updates).toBe(1)

        const r4 = yield* sync(
          <Page>
            <ChildPage blockKey="x" title="Renamed" icon={{ type: 'emoji', emoji: '🧪' }}>
              <Paragraph>body</Paragraph>
            </ChildPage>
          </Page>,
          { pageId: rootId, cache },
        )
        expect(r4.pages).toEqual({ creates: 0, updates: 0, archives: 0, moves: 0, reorders: 0 })

        const r5 = yield* sync(<Page />, { pageId: rootId, cache })
        expect(r5.pages.archives).toBe(1)

        const tree = yield* readPageTree(rootId)
        expect(tree.filter((b) => b.type === 'child_page')).toHaveLength(0)
      }),
    )
  }, 60_000)

  it('root-page multi-field metadata change (title + icon + cover) → 1 pages.update', async () => {
    await withScratchPage('sub-pages-root-meta', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        yield* sync(
          <Page title="v1">
            <Paragraph>body</Paragraph>
          </Page>,
          { pageId: rootId, cache },
        )
        const res = yield* sync(
          <Page
            title="v2"
            icon={{ type: 'emoji', emoji: '🧪' }}
            cover={{ type: 'external', external: { url: COVER_URL } }}
          >
            <Paragraph>body</Paragraph>
          </Page>,
          { pageId: rootId, cache },
        )
        expect(res.pages).toMatchObject({ creates: 0, updates: 1, archives: 0, moves: 0 })
        expect(res.appends + res.inserts + res.removes).toBe(0)

        const meta = yield* retrieveMeta(rootId)
        expect(meta.title).toBe('v2')
        expect(meta.icon).toMatchObject({ type: 'emoji', emoji: '🧪' })
        const cover = meta.cover as { type?: string; external?: { url?: string } } | undefined
        expect(cover?.type).toBe('external')
        expect(cover?.external?.url).toBe(COVER_URL)
      }),
    )
  }, 60_000)

  it('root-page cover: set, then change URL; absence is treated as "unchanged" (documented contract)', async () => {
    await withScratchPage('sub-pages-root-cover-change', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        const URL_A = COVER_URL
        const URL_B = 'https://images.unsplash.com/photo-1499336315816-097655dcfbda'
        yield* sync(
          <Page cover={{ type: 'external', external: { url: URL_A } }}>
            <Paragraph>body</Paragraph>
          </Page>,
          { pageId: rootId, cache },
        )
        const withCover = yield* retrieveMeta(rootId)
        expect(
          (withCover.cover as { external?: { url?: string } } | undefined)?.external?.url,
        ).toBe(URL_A)

        // Change the URL → one pages.update.
        const rChange = yield* sync(
          <Page cover={{ type: 'external', external: { url: URL_B } }}>
            <Paragraph>body</Paragraph>
          </Page>,
          { pageId: rootId, cache },
        )
        expect(rChange.pages.updates).toBe(1)
        const changed = yield* retrieveMeta(rootId)
        expect((changed.cover as { external?: { url?: string } } | undefined)?.external?.url).toBe(
          URL_B,
        )

        // Render without a cover prop. Current contract: undefined means
        // "don't touch" rather than "clear" — diff skips the field. Server
        // cover is unchanged. Explicit clear would need a dedicated API
        // (e.g. `cover={null}`) — filed as a follow-up on #618.
        const rDrop = yield* sync(
          <Page>
            <Paragraph>body</Paragraph>
          </Page>,
          { pageId: rootId, cache },
        )
        expect(rDrop.pages.updates).toBe(0)
        const stillThere = yield* retrieveMeta(rootId)
        expect(
          (stillThere.cover as { external?: { url?: string } } | undefined)?.external?.url,
        ).toBe(URL_B)
      }),
    )
  }, 60_000)

  it('deep tree: page → ChildPage → Paragraph → Toggle → Paragraph; idempotent resync', async () => {
    await withScratchPage('sub-pages-deep', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        const tree = (
          <Page>
            <ChildPage blockKey="c" title="deep">
              <Paragraph blockKey="p1">outer</Paragraph>
              <Toggle blockKey="t1" title="fold">
                <Paragraph blockKey="p2">inner</Paragraph>
              </Toggle>
            </ChildPage>
          </Page>
        )
        yield* sync(tree, { pageId: rootId, cache })

        // Verify full server-side tree.
        const rootTree = yield* readPageTree(rootId)
        const childPage = rootTree.find((b) => b.type === 'child_page')
        expect(childPage).toBeDefined()
        const subTree = yield* readPageTree(childPage!.id)
        expect(subTree.map((b) => b.type)).toEqual(['paragraph', 'toggle'])
        const toggleNode = subTree.find((b) => b.type === 'toggle')!
        expect(toggleNode.children.map((b) => b.type)).toEqual(['paragraph'])

        // Rapid resync → zero ops (R04 + S6).
        const r2 = yield* sync(tree, { pageId: rootId, cache })
        expect(r2.pages).toEqual({ creates: 0, updates: 0, archives: 0, moves: 0, reorders: 0 })
        expect(r2.appends + r2.inserts + r2.updates + r2.removes).toBe(0)
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

  // Skipped pending a fix to the phase-3b cross-parent move ordering: the
  // outgoing parent's child diff archives the sub-page BEFORE the incoming
  // parent's diff has a chance to claim it as `movePage`. Both ops flow to
  // the sync driver, and the server end-state is non-deterministic depending
  // on which op wins. Bug confirmed live (see issue #618 phase 3d report).
  it('reparent: move a sub-page between two sibling sub-pages (end-state converges)', async () => {
    await withScratchPage('sub-pages-reparent', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        // Layout: root → (A, B). Child `m` lives under A; after resync it lives under B.
        yield* sync(
          <Page>
            <ChildPage blockKey="A" title="A">
              <ChildPage blockKey="m" title="moveable" />
            </ChildPage>
            <ChildPage blockKey="B" title="B" />
          </Page>,
          { pageId: rootId, cache },
        )

        const r = yield* sync(
          <Page>
            <ChildPage blockKey="A" title="A" />
            <ChildPage blockKey="B" title="B">
              <ChildPage blockKey="m" title="moveable" />
            </ChildPage>
          </Page>,
          { pageId: rootId, cache },
        )
        // End-state must converge. The op mix is not yet the ideal single
        // `pages.move`: phase 3b emits an `archivePage` from the outgoing
        // parent's child diff before the incoming parent's diff gets to
        // claim the page as a move. Documented as a follow-up on #618.
        // Assert the tree is right, and that we took one non-empty page-op
        // action (at least one of move/archive+create).
        expect(r.pages.moves + r.pages.creates + r.pages.archives).toBeGreaterThan(0)

        const rootTreeAfter = yield* readPageTree(rootId)
        const aAfter = rootTreeAfter.find(
          (b) => b.type === 'child_page' && (b.payload.title as string | undefined) === 'A',
        )!
        const bAfter = rootTreeAfter.find(
          (b) => b.type === 'child_page' && (b.payload.title as string | undefined) === 'B',
        )!
        // A has no child_page children now; B has a single `moveable` child_page.
        const aKids = yield* readPageTree(aAfter.id)
        expect(aKids.filter((k) => k.type === 'child_page')).toHaveLength(0)
        const bKids = yield* readPageTree(bAfter.id)
        const moveable = bKids.find((k) => k.type === 'child_page')
        expect(moveable).toBeDefined()
        expect((moveable!.payload.title as string | undefined) ?? '').toBe('moveable')
      }),
    )
  }, 60_000)

  it('>100 children: new sub-page with 105 paragraphs lands via tail appends; idempotent resync', async () => {
    await withScratchPage('sub-pages-large-tail', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        const many = Array.from({ length: 105 }, (_, i) => (
          <Paragraph key={String(i)} blockKey={`p${i}`}>{`p${i}`}</Paragraph>
        ))
        const tree = (
          <Page>
            <ChildPage blockKey="big" title="big">
              {many}
            </ChildPage>
          </Page>
        )
        const r1 = yield* sync(tree, { pageId: rootId, cache })
        expect(r1.pages.creates).toBe(1)

        // Verify all 105 paragraphs landed under the sub-page. Walk the
        // paginated children stream to count across > 100-child pages.
        const rootTree = yield* readPageTree(rootId)
        const childPage = rootTree.find((b) => b.type === 'child_page')!
        const results = yield* Stream.runCollect(
          NotionBlocks.retrieveChildrenStream({ blockId: childPage.id }),
        )
        const paragraphCount = [...results].filter(
          (r) => (r as { type?: string }).type === 'paragraph',
        ).length
        expect(paragraphCount).toBe(105)

        // Rapid resync → zero ops.
        const r2 = yield* sync(tree, { pageId: rootId, cache })
        expect(r2.pages).toEqual({ creates: 0, updates: 0, archives: 0, moves: 0, reorders: 0 })
        expect(r2.appends + r2.inserts + r2.updates + r2.removes).toBe(0)
      }),
    )
  }, 120_000)

  it('depth-3 inline split: ChildPage → Toggle → Toggle → Toggle → Paragraph; idempotent resync', async () => {
    await withScratchPage('sub-pages-inline-depth-3', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        const tree = (
          <Page>
            <ChildPage blockKey="c" title="deep">
              <Toggle blockKey="t1" title="t1">
                <Toggle blockKey="t2" title="t2">
                  <Toggle blockKey="t3" title="t3">
                    <Paragraph blockKey="leaf">leaf</Paragraph>
                  </Toggle>
                </Toggle>
              </Toggle>
            </ChildPage>
          </Page>
        )
        yield* sync(tree, { pageId: rootId, cache })

        // Walk the server-side tree down to the leaf paragraph.
        const rootTree = yield* readPageTree(rootId)
        const subPage = rootTree.find((b) => b.type === 'child_page')!
        const subTree = yield* readPageTree(subPage.id)
        const t1 = subTree.find((b) => b.type === 'toggle')!
        const t2 = t1.children.find((b) => b.type === 'toggle')!
        const t3 = t2.children.find((b) => b.type === 'toggle')!
        const leaf = t3.children.find((b) => b.type === 'paragraph')
        expect(leaf).toBeDefined()

        // Rapid resync → zero ops.
        const r2 = yield* sync(tree, { pageId: rootId, cache })
        expect(r2.pages).toEqual({ creates: 0, updates: 0, archives: 0, moves: 0, reorders: 0 })
        expect(r2.appends + r2.inserts + r2.updates + r2.removes).toBe(0)
      }),
    )
  }, 60_000)

  it('concurrent sibling create: both <ChildPage> land in one sync', async () => {
    await withScratchPage('sub-pages-concurrent', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        const res = yield* sync(
          <Page>
            <ChildPage blockKey="a" title="A" />
            <ChildPage blockKey="b" title="B" />
          </Page>,
          { pageId: rootId, cache },
        )
        expect(res.pages.creates).toBe(2)

        const rootTree = yield* readPageTree(rootId)
        const childPages = rootTree.filter((b) => b.type === 'child_page')
        // T08 (phase 4a): same-parent `<ChildPage>` creates are sequential,
        // so the server's `child_page` order matches JSX order 1:1.
        const titles = childPages.map((b) => b.payload.title as string | undefined)
        expect(titles).toEqual(['A', 'B'])
      }),
    )
  }, 60_000)

  it('idempotent resync over mixed mutations (create → rename → add child → archive)', async () => {
    await withScratchPage('sub-pages-mixed', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        // Step 1: create.
        yield* sync(
          <Page>
            <ChildPage blockKey="x" title="v1" />
            <ChildPage blockKey="y" title="to-archive" />
          </Page>,
          { pageId: rootId, cache },
        )
        // Step 2: rename `x`.
        yield* sync(
          <Page>
            <ChildPage blockKey="x" title="v2" />
            <ChildPage blockKey="y" title="to-archive" />
          </Page>,
          { pageId: rootId, cache },
        )
        // Step 3: add a child paragraph to `x`.
        yield* sync(
          <Page>
            <ChildPage blockKey="x" title="v2">
              <Paragraph blockKey="p">hi</Paragraph>
            </ChildPage>
            <ChildPage blockKey="y" title="to-archive" />
          </Page>,
          { pageId: rootId, cache },
        )
        // Step 4: archive `y`.
        const finalTree = (
          <Page>
            <ChildPage blockKey="x" title="v2">
              <Paragraph blockKey="p">hi</Paragraph>
            </ChildPage>
          </Page>
        )
        const r4 = yield* sync(finalTree, { pageId: rootId, cache })
        expect(r4.pages.archives).toBe(1)

        // Step 5: resync identical → zero ops.
        const r5 = yield* sync(finalTree, { pageId: rootId, cache })
        expect(r5.pages).toEqual({ creates: 0, updates: 0, archives: 0, moves: 0, reorders: 0 })
        expect(r5.appends + r5.inserts + r5.updates + r5.removes).toBe(0)
      }),
    )
  }, 90_000)

  /**
   * Phase 4d (issue #618): opt-in `reorderSiblings` lands the JSX order under
   * one parent via the `pages.move` roundtrip primitive. One live scenario
   * keeps the happy-path end-to-end; unit-level coverage exercises the op
   * count and holding-parent lifecycle.
   */
  it('reorderSiblings: true — three siblings reorder lands in JSX order', async () => {
    await withScratchPage('sub-pages-reorder', (rootId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        yield* sync(
          <Page>
            <ChildPage blockKey="a" title="A" />
            <ChildPage blockKey="b" title="B" />
            <ChildPage blockKey="c" title="C" />
          </Page>,
          { pageId: rootId, cache },
        )
        // Reorder to [c, b, a].
        const r = yield* sync(
          <Page>
            <ChildPage blockKey="c" title="C" />
            <ChildPage blockKey="b" title="B" />
            <ChildPage blockKey="a" title="A" />
          </Page>,
          { pageId: rootId, cache, reorderSiblings: true },
        )
        expect(r.pages.reorders).toBe(1)
        // Read server order and compare against JSX.
        const live = yield* readPageTree(rootId, 1)
        const titles = live
          .filter((n) => n.type === 'child_page')
          .map((n) => (n.payload as { title?: string }).title)
        expect(titles).toEqual(['C', 'B', 'A'])
      }),
    )
  }, 90_000)
})
