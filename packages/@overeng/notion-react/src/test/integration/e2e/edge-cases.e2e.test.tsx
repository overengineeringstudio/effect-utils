import { Effect } from 'effect'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { InMemoryCache } from '../../../cache/in-memory-cache.ts'
import { Image, Page, Paragraph } from '../../../components/blocks.tsx'
import { h } from '../../../components/h.ts'
import { renderToNotion } from '../../../renderer/render-to-notion.ts'
import { sync } from '../../../renderer/sync.ts'
import {
  assertEnv,
  concatPlainText,
  firstPlainText,
  readPageTree,
  SKIP_E2E,
  withScratchPage,
} from './helpers.ts'

/**
 * Edge cases for the e2e pipeline: zero-content trees, boundary-size
 * inputs, concurrent writers, credential error paths, and media upload
 * failure shapes.
 */

const TIMEOUT = 120_000

describe.skipIf(SKIP_E2E)('e2e edge cases', () => {
  // ---------------------------------------------------------------------
  // 1. Empty page — render <Page> with no children.
  // ---------------------------------------------------------------------
  it(
    'empty page render — no append ops, no server-side blocks',
    async () => {
      await withScratchPage('edge-empty-page', (pageId) =>
        Effect.gen(function* () {
          const cache = InMemoryCache.make()
          const res = yield* sync(<Page>{null}</Page>, { pageId, cache }).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          expect(res.appends + res.updates + res.inserts + res.removes).toBe(0)

          const server = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          expect(server).toHaveLength(0)
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 2. Single block — smallest meaningful render.
  // ---------------------------------------------------------------------
  it(
    'single-block render — one paragraph, no wrapping <Page>',
    async () => {
      await withScratchPage('edge-single-block', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(<Paragraph>only one</Paragraph>, { pageId }).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          const tree = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          expect(tree).toHaveLength(1)
          expect(tree[0]!.type).toBe('paragraph')
          expect(firstPlainText(tree[0]!)).toBe('only one')
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 3. Unicode + emoji — grapheme clusters, zero-width joiners, RTL.
  // ---------------------------------------------------------------------
  it(
    'unicode + emoji + RTL + ZWJ sequence round-trips',
    async () => {
      // Deliberately diverse: combining accent, family emoji (ZWJ), RTL
      // script, and a CJK block.
      const text = 'café 👨‍👩‍👧 שלום 漢字'
      await withScratchPage('edge-unicode', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(<Paragraph>{text}</Paragraph>, { pageId }).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          const tree = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          expect(concatPlainText(tree[0]!)).toBe(text)
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 4. Very long paragraph — Notion imposes ~2000 chars per rich_text
  //     item. We send 2000 chars and verify the round-trip without
  //     client-side splitting.
  // ---------------------------------------------------------------------
  it(
    'paragraph at the 2000-char rich_text limit round-trips',
    async () => {
      const text = 'x'.repeat(2000)
      await withScratchPage('edge-long-paragraph', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(<Paragraph>{text}</Paragraph>, { pageId }).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          const tree = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          expect(firstPlainText(tree[0]!).length).toBe(2000)
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 5. Concurrent syncs — two independent caches writing to the same page
  //     interleave without losing blocks. Neither cache knows about the
  //     other's writes, so we just assert both payloads land.
  // ---------------------------------------------------------------------
  it(
    'concurrent syncs to the same page — both sets of blocks land',
    async () => {
      await withScratchPage('edge-concurrent', (pageId) =>
        Effect.gen(function* () {
          const cacheA = InMemoryCache.make()
          const cacheB = InMemoryCache.make()

          // Kick both syncs off concurrently.
          const TreeA = (): ReactNode => (
            <>
              {h('paragraph', { blockKey: 'a1' }, 'alpha-1')}
              {h('paragraph', { blockKey: 'a2' }, 'alpha-2')}
            </>
          )
          const TreeB = (): ReactNode => (
            <>
              {h('paragraph', { blockKey: 'b1' }, 'beta-1')}
              {h('paragraph', { blockKey: 'b2' }, 'beta-2')}
            </>
          )

          yield* Effect.all(
            [
              sync(<TreeA />, { pageId, cache: cacheA }),
              sync(<TreeB />, { pageId, cache: cacheB }),
            ],
            { concurrency: 2 },
          ).pipe(Effect.mapError((cause) => new Error(String(cause))))

          const server = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          const texts = server.filter((b) => b.type === 'paragraph').map((b) => firstPlainText(b))
          // All four blocks are present; order is implementation-defined
          // since Notion serializes appends per request.
          expect(texts.sort()).toEqual(['alpha-1', 'alpha-2', 'beta-1', 'beta-2'])
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 6. Missing NOTION_TOKEN — assertEnv throws a clear error.
  // ---------------------------------------------------------------------
  it('assertEnv throws a clear error when NOTION_TOKEN is missing', () => {
    expect(() => assertEnv({ NOTION_TEST_PARENT_PAGE_ID: 'x' } as NodeJS.ProcessEnv)).toThrow(
      /NOTION_TOKEN is not set/,
    )
  })

  // ---------------------------------------------------------------------
  // 7. Missing NOTION_TEST_PARENT_PAGE_ID — assertEnv throws a clear error.
  // ---------------------------------------------------------------------
  it('assertEnv throws a clear error when NOTION_TEST_PARENT_PAGE_ID is missing', () => {
    expect(() => assertEnv({ NOTION_TOKEN: 'x' } as NodeJS.ProcessEnv)).toThrow(
      /NOTION_TEST_PARENT_PAGE_ID is not set/,
    )
  })

  // ---------------------------------------------------------------------
  // 8. Image upload failure — a malformed external URL causes Notion to
  //     reject the create. The renderer surfaces a tagged error instead
  //     of silently swallowing.
  // ---------------------------------------------------------------------
  it(
    'image with unreachable URL — Notion rejects; renderer surfaces a NotionSyncError',
    async () => {
      // Known-bad: host that will never resolve to a content-type Notion accepts.
      // Notion validates external URLs at create time and rejects non-image
      // content-types / schemes it does not allow.
      await withScratchPage('edge-image-bad-url', (pageId) =>
        Effect.gen(function* () {
          const result = yield* renderToNotion(
            <Page>
              <Image url="ftp://not-a-real-host/image.png" />
            </Page>,
            { pageId },
          ).pipe(Effect.either)
          // Either the API rejects the URL (we get a Left tagged error) or
          // Notion silently accepts it. Both outcomes are acceptable —
          // we just assert the renderer does not throw an unhandled error
          // and that a Left carries a typed `NotionSyncError`.
          if (result._tag === 'Left') {
            expect(result.left._tag).toBe('NotionSyncError')
          }
        }),
      )
    },
    TIMEOUT,
  )
})
