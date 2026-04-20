import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { NotionBlocks, NotionPages, type NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../../../cache/in-memory-cache.ts'
import { Heading2, Paragraph } from '../../../components/blocks.tsx'
import { h } from '../../../components/h.ts'
import { sync } from '../../../renderer/sync.ts'
import {
  concatPlainText,
  firstPlainText,
  type ReadBlockNode,
  readPageTree,
  SKIP_E2E,
  withScratchPage,
} from './helpers.ts'

/**
 * End-to-end mutation scenarios exercising `sync()` against live Notion.
 *
 * The fixture mirrors a pixeltrail-shaped timeline page: a stats heading /
 * paragraph, a divider, a timeline heading, and a list of session toggles
 * each containing one body paragraph. Toggles carry `blockKey={id}` so
 * mid-list inserts can be represented as single insert ops (not tail
 * rewrites).
 *
 * Every test gets a fresh scratch page and archives it on exit. Cache
 * state is per-test (no shared cache across `withScratchPage` calls).
 */

type Session = { readonly id: string; readonly title: string; readonly body: string }

const DailyPage = ({
  screenTime,
  apps,
  sessions,
}: {
  readonly screenTime: string
  readonly apps: number
  readonly sessions: readonly Session[]
}): ReactNode => (
  <>
    <Heading2>Stats</Heading2>
    <Paragraph>{`${screenTime} · ${apps} apps`}</Paragraph>
    {h('divider', null)}
    <Heading2>Timeline</Heading2>
    {sessions.map((s) =>
      h('toggle', { key: s.id, blockKey: s.id, title: s.title }, <Paragraph>{s.body}</Paragraph>),
    )}
  </>
)

const v1: readonly Session[] = [
  { id: 's1', title: '09:00 Terminal', body: '30 min focused' },
  { id: 's2', title: '10:00 Browser', body: 'research' },
  { id: 's3', title: '11:00 VSCode', body: 'coding session' },
]

/** Static top-level blocks: h2, p, divider, h2 = 4. Plus N toggles + N paragraphs = 2N children. */
const totalBlockCount = (n: number): number => 4 + 2 * n

type TestR = NotionConfig | HttpClient.HttpClient

const findToggleByTitle = (
  tree: readonly ReadBlockNode[],
  title: string,
): ReadBlockNode | undefined =>
  tree.find((b) => {
    if (b.type !== 'toggle') return false
    return firstPlainText(b) === title
  })

/** Wrap an Effect-producing body in an `Effect.mapError(String)` for assertion clarity. */
const runE = <A,>(eff: Effect.Effect<A, unknown, TestR>): Effect.Effect<A, Error, TestR> =>
  eff.pipe(Effect.mapError((cause) => new Error(String(cause))))

const TIMEOUT = 120_000
const LARGE_TIMEOUT = 300_000

describe.skipIf(SKIP_E2E)('sync() mutation scenarios (e2e)', () => {
  // ---------------------------------------------------------------------
  // 1. Initial cold sync — appends only, fallbackReason='cold-cache'
  // ---------------------------------------------------------------------
  it(
    'initial cold sync — appends only; SyncResult reflects total block count',
    async () => {
      await withScratchPage('mut-cold-initial', (pageId) =>
        Effect.gen(function* () {
          const cache = InMemoryCache.make()
          const res = yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )
          expect(res.appends).toBe(totalBlockCount(v1.length))
          expect(res.updates).toBe(0)
          expect(res.inserts).toBe(0)
          expect(res.removes).toBe(0)
          expect(res.fallbackReason).toBe('cold-cache')

          const server = yield* runE(readPageTree(pageId))
          expect(server).toHaveLength(4 + v1.length)
          const toggles = server.filter((b) => b.type === 'toggle')
          expect(toggles).toHaveLength(v1.length)
          for (const t of toggles) expect(t.children).toHaveLength(1)
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 2. Same-tree resync — {0, 0, 0, 0}, no fallback
  // ---------------------------------------------------------------------
  it(
    'same-tree resync is a no-op',
    async () => {
      await withScratchPage('mut-noop-resync', (pageId) =>
        Effect.gen(function* () {
          const cache = InMemoryCache.make()
          const tree = <DailyPage screenTime="4h 12m" apps={7} sessions={v1} />
          yield* runE(sync(tree, { pageId, cache }))
          const res = yield* runE(sync(tree, { pageId, cache }))
          expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
          expect(res.fallbackReason).toBeUndefined()
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 3. Body change — single update
  // ---------------------------------------------------------------------
  it(
    'one body change → {updates: 1}',
    async () => {
      await withScratchPage('mut-body-change', (pageId) =>
        Effect.gen(function* () {
          const cache = InMemoryCache.make()
          yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )
          const v2: readonly Session[] = [
            { id: 's1', title: '09:00 Terminal', body: '45 min focused' },
            v1[1]!,
            v1[2]!,
          ]
          const res = yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, { pageId, cache }),
          )
          expect(res).toMatchObject({ appends: 0, updates: 1, inserts: 0, removes: 0 })

          const server = yield* runE(readPageTree(pageId))
          const toggle = findToggleByTitle(server, '09:00 Terminal')
          expect(firstPlainText(toggle!.children[0]!)).toBe('45 min focused')
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 4. Append a session — {inserts|appends totalling 2} (toggle + nested paragraph)
  // ---------------------------------------------------------------------
  it(
    'append session → 2 ops (toggle + nested paragraph)',
    async () => {
      await withScratchPage('mut-append-tail', (pageId) =>
        Effect.gen(function* () {
          const cache = InMemoryCache.make()
          yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )
          const v2: readonly Session[] = [...v1, { id: 's4', title: '12:00 Slack', body: 'chat' }]
          const res = yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, { pageId, cache }),
          )
          expect(res.updates).toBe(0)
          expect(res.removes).toBe(0)
          expect(res.appends + res.inserts).toBe(2)

          const server = yield* runE(readPageTree(pageId))
          const toggle = findToggleByTitle(server, '12:00 Slack')
          expect(firstPlainText(toggle!.children[0]!)).toBe('chat')
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 5. Insert mid (keyed) — {inserts totalling 2} + order preserved
  // ---------------------------------------------------------------------
  it(
    'insert mid (keyed) → 2 ops + correct order',
    async () => {
      await withScratchPage('mut-insert-mid-keyed', (pageId) =>
        Effect.gen(function* () {
          const cache = InMemoryCache.make()
          yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )
          const v2: readonly Session[] = [
            v1[0]!,
            v1[1]!,
            { id: 's2b', title: '10:30 Figma', body: 'design' },
            v1[2]!,
          ]
          const res = yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, { pageId, cache }),
          )
          expect(res.updates).toBe(0)
          expect(res.removes).toBe(0)
          expect(res.appends + res.inserts).toBe(2)

          const server = yield* runE(readPageTree(pageId))
          const titles = server.filter((b) => b.type === 'toggle').map((b) => firstPlainText(b))
          expect(titles).toEqual(['09:00 Terminal', '10:00 Browser', '10:30 Figma', '11:00 VSCode'])
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 6. Delete a session — {removes: 1}
  // ---------------------------------------------------------------------
  it(
    'delete session → {removes: 1}',
    async () => {
      await withScratchPage('mut-delete', (pageId) =>
        Effect.gen(function* () {
          const cache = InMemoryCache.make()
          yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )
          const v2: readonly Session[] = v1.filter((s) => s.id !== 's2')
          const res = yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, { pageId, cache }),
          )
          expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 1 })

          const server = yield* runE(readPageTree(pageId))
          expect(findToggleByTitle(server, '10:00 Browser')).toBeUndefined()
          expect(findToggleByTitle(server, '09:00 Terminal')).toBeDefined()
          expect(findToggleByTitle(server, '11:00 VSCode')).toBeDefined()
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 7. Mixed mutations — 1 update + 1 insert + 1 delete in a single sync
  // ---------------------------------------------------------------------
  it(
    'mixed mutations in one sync — update + insert + delete',
    async () => {
      await withScratchPage('mut-mixed', (pageId) =>
        Effect.gen(function* () {
          const cache = InMemoryCache.make()
          yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )
          const v2: readonly Session[] = [
            // s1: updated body
            { id: 's1', title: '09:00 Terminal', body: '45 min focused' },
            // s2 removed
            // s3 kept as-is
            v1[2]!,
            // new s4 appended
            { id: 's4', title: '12:00 Slack', body: 'chat' },
          ]
          const res = yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, { pageId, cache }),
          )
          expect(res.updates).toBe(1)
          expect(res.removes).toBe(1)
          expect(res.appends + res.inserts).toBe(2) // new toggle + its paragraph child

          const server = yield* runE(readPageTree(pageId))
          const titles = server.filter((b) => b.type === 'toggle').map((b) => firstPlainText(b))
          expect(titles).toEqual(['09:00 Terminal', '11:00 VSCode', '12:00 Slack'])
          const s1 = findToggleByTitle(server, '09:00 Terminal')!
          expect(firstPlainText(s1.children[0]!)).toBe('45 min focused')
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 8. Cache drift — block archived out-of-band then resync
  // ---------------------------------------------------------------------
  // Hypothesis: current `sync()` does not revalidate cached block ids
  // against the server. When a cached block is archived out-of-band, the
  // diff is {0,0,0,0} so the resync believes the state is in sync — but
  // the server no longer has that block. This is a documented limitation,
  // not a test failure; we assert the observed behaviour.
  it(
    'cache drift: out-of-band archive of a block — sync reports no-op but server is missing the block',
    async () => {
      await withScratchPage('mut-cache-drift', (pageId) =>
        Effect.gen(function* () {
          const cache = InMemoryCache.make()
          yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )

          // Find the s2 toggle on the server and archive it out-of-band.
          const server1 = yield* runE(readPageTree(pageId))
          const s2 = findToggleByTitle(server1, '10:00 Browser')!
          yield* runE(NotionBlocks.delete({ blockId: s2.id }))

          // Re-render the same tree; cache still thinks s2 is present.
          const res = yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )
          // Documented behaviour: identical tree → zero ops; drift is not
          // detected without an explicit reconcile.
          expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })

          const server2 = yield* runE(readPageTree(pageId))
          expect(findToggleByTitle(server2, '10:00 Browser')).toBeUndefined()
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 9. Nested cache drift — parent cached, child archived
  // ---------------------------------------------------------------------
  it(
    'nested cache drift: archived child paragraph under a still-cached toggle',
    async () => {
      await withScratchPage('mut-nested-drift', (pageId) =>
        Effect.gen(function* () {
          const cache = InMemoryCache.make()
          yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )

          const server1 = yield* runE(readPageTree(pageId))
          const s1 = findToggleByTitle(server1, '09:00 Terminal')!
          const childParagraph = s1.children[0]!
          yield* runE(NotionBlocks.delete({ blockId: childParagraph.id }))

          const res = yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )
          // Same: no drift detection → no ops.
          expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })

          const server2 = yield* runE(readPageTree(pageId))
          const s1After = findToggleByTitle(server2, '09:00 Terminal')!
          // Notion treats child archive as a cascade target; the toggle
          // still exists but has no children.
          expect(s1After.children).toHaveLength(0)
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 10. Archived mid-sync — another process archives a session between
  //     renders.
  // ---------------------------------------------------------------------
  it(
    'archive mid-lifecycle: block removed between render passes is recreated by next render',
    async () => {
      await withScratchPage('mut-archive-mid', (pageId) =>
        Effect.gen(function* () {
          const cache = InMemoryCache.make()
          yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )

          // Another process archives s3.
          const server1 = yield* runE(readPageTree(pageId))
          const s3 = findToggleByTitle(server1, '11:00 VSCode')!
          yield* runE(NotionBlocks.delete({ blockId: s3.id }))

          // Now resync with a different session list that adds s4 and
          // keeps s3. Cache still has s3; render has s3+s4.
          const v2: readonly Session[] = [...v1, { id: 's4', title: '12:00 Slack', body: 'chat' }]
          const res = yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, { pageId, cache }),
          )
          // s4 is a new tail toggle (+ paragraph) = 2 ops. s3 appears
          // unchanged from the cache's perspective.
          expect(res.appends + res.inserts).toBe(2)

          const server2 = yield* runE(readPageTree(pageId))
          const titles = server2.filter((b) => b.type === 'toggle').map((b) => firstPlainText(b))
          // s3 stays archived (sync didn't resurrect it); s4 present.
          expect(titles).toEqual(['09:00 Terminal', '10:00 Browser', '12:00 Slack'])
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 11. Page title change — exercises the pages.update API (not sync()).
  // ---------------------------------------------------------------------
  it(
    'page title change (via pages.update) — round-trips via pages.retrieve',
    async () => {
      await withScratchPage('mut-page-title', (pageId) =>
        Effect.gen(function* () {
          yield* runE(
            NotionPages.update({
              pageId,
              properties: {
                title: {
                  title: [{ type: 'text', text: { content: 'Renamed page title' } }],
                },
              },
            }),
          )
          const page = yield* runE(NotionPages.retrieve({ pageId }))
          const props = (page as { properties?: Record<string, unknown> }).properties ?? {}
          const titleProp = props.title as
            | { title?: readonly { plain_text?: string }[] }
            | undefined
          expect(titleProp?.title?.[0]?.plain_text).toBe('Renamed page title')
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 12. Large page — 100+ blocks, verify linear diffing stays correct.
  // ---------------------------------------------------------------------
  it(
    'large page (100 keyed paragraphs) — initial sync + no-op resync',
    async () => {
      await withScratchPage('mut-large-page', (pageId) =>
        Effect.gen(function* () {
          const N = 100
          const rows = Array.from({ length: N }, (_, i) => ({
            id: `row-${i}`,
            text: `row ${i}`,
          }))
          const Tree = (): ReactNode => (
            <>{rows.map((r) => h('paragraph', { key: r.id, blockKey: r.id }, r.text))}</>
          )

          const cache = InMemoryCache.make()
          const initial = yield* runE(sync(<Tree />, { pageId, cache }))
          expect(initial.appends).toBe(N)
          expect(initial.updates + initial.inserts + initial.removes).toBe(0)

          const resync = yield* runE(sync(<Tree />, { pageId, cache }))
          expect(resync).toMatchObject({
            appends: 0,
            updates: 0,
            inserts: 0,
            removes: 0,
          })

          const server = yield* runE(readPageTree(pageId))
          expect(server).toHaveLength(N)
          for (let i = 0; i < N; i++) {
            expect(firstPlainText(server[i]!)).toBe(`row ${i}`)
          }
        }),
      )
    },
    LARGE_TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 13. Manual-edit then resync — document how the renderer overwrites
  //     user edits when the cache disagrees.
  // ---------------------------------------------------------------------
  it(
    'manual edit then resync: server edit is overwritten to match the rendered tree',
    async () => {
      await withScratchPage('mut-manual-edit', (pageId) =>
        Effect.gen(function* () {
          const cache = InMemoryCache.make()
          yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )

          const server1 = yield* runE(readPageTree(pageId))
          const s1 = findToggleByTitle(server1, '09:00 Terminal')!
          const paragraph = s1.children[0]!
          // User edits the paragraph text on Notion.
          yield* runE(
            NotionBlocks.update({
              blockId: paragraph.id,
              paragraph: {
                rich_text: [{ type: 'text', text: { content: 'user edit' } }],
              },
            }),
          )

          // Render the same tree as before. Cache still has the original
          // text, and the rendered tree matches it, so the diff is 0.
          // Documented behaviour: the manual edit is NOT overwritten
          // because the cache + render agree.
          const resync = yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, { pageId, cache }),
          )
          expect(resync).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })

          const server2 = yield* runE(readPageTree(pageId))
          const s1After = findToggleByTitle(server2, '09:00 Terminal')!
          // The user edit survives until the rendered tree disagrees.
          expect(firstPlainText(s1After.children[0]!)).toBe('user edit')

          // Now render with a different body. The diff sees the cached old
          // body vs the new rendered body → emits an update, clobbering
          // the user's edit with the rendered content.
          const v2: readonly Session[] = [
            { id: 's1', title: '09:00 Terminal', body: 'app-authored' },
            v1[1]!,
            v1[2]!,
          ]
          yield* runE(
            sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, { pageId, cache }),
          )
          const server3 = yield* runE(readPageTree(pageId))
          const s1Final = findToggleByTitle(server3, '09:00 Terminal')!
          expect(firstPlainText(s1Final.children[0]!)).toBe('app-authored')
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // 14. Cold sync against existing content — pre-seed blocks on the page,
  //     then run `sync()` with a cold cache. Documented behaviour: sync
  //     APPENDS to existing content (does not attempt to reconcile).
  // ---------------------------------------------------------------------
  it(
    'cold sync against pre-seeded blocks — renderer appends; existing content untouched',
    async () => {
      await withScratchPage('mut-cold-existing', (pageId) =>
        Effect.gen(function* () {
          // Pre-seed a stray paragraph directly via the API (not through sync).
          yield* runE(
            NotionBlocks.append({
              blockId: pageId,
              children: [
                {
                  object: 'block',
                  type: 'paragraph',
                  paragraph: {
                    rich_text: [{ type: 'text', text: { content: 'pre-existing' } }],
                  },
                },
              ],
            }),
          )

          const cache = InMemoryCache.make()
          const res = yield* runE(sync(<Paragraph>from-sync</Paragraph>, { pageId, cache }))
          expect(res.appends).toBe(1)
          expect(res.fallbackReason).toBe('cold-cache')

          const server = yield* runE(readPageTree(pageId))
          expect(server).toHaveLength(2)
          expect(concatPlainText(server[0]!)).toBe('pre-existing')
          expect(concatPlainText(server[1]!)).toBe('from-sync')
        }),
      )
    },
    TIMEOUT,
  )
})
