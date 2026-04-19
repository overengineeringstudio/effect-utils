import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../../cache/in-memory-cache.ts'
import { Heading2 } from '../../components/blocks.tsx'
import { h } from '../../components/h.ts'
import { sync } from '../../renderer/sync.ts'
import {
  archiveScratchPage,
  createScratchPage,
  IntegrationTestLayer,
  readPageTree,
  SKIP_INTEGRATION,
  type ReadBlockNode,
} from './setup.ts'

/**
 * Flat DailyPage fixture: each session is a single `paragraph` keyed by
 * `blockKey={id}`.
 *
 * Why not Toggle: the derisk timeline uses `<Toggle title=…>` with a nested
 * `<Paragraph>` body, but the current renderer does not project the toggle
 * `title` prop to `rich_text[]`, so every append/insert of a toggle hits a
 * Notion 400. Until that renderer gap is closed, we exercise the min-op diff
 * contract against a flat paragraph shape. R20's op-count table matches
 * exactly because each session is one block (no nested children).
 */
type Session = { readonly id: string; readonly title: string; readonly body: string }

const sessionBlock = (s: Session): ReactNode =>
  h('paragraph', { blockKey: s.id }, `${s.title} — ${s.body}`)

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
    {h('paragraph', { blockKey: 'stats' }, `${screenTime} · ${apps} apps`)}
    {h('divider', null)}
    <Heading2>Timeline</Heading2>
    {sessions.map(sessionBlock)}
  </>
)

const v1: readonly Session[] = [
  { id: 's1', title: '09:00 Terminal', body: '30 min focused' },
  { id: 's2', title: '10:00 Browser', body: 'research' },
  { id: 's3', title: '11:00 VSCode', body: 'coding session' },
]

/** Top-level block count: 4 static (h2, p, divider, h2) + N session paragraphs. */
const totalBlockCount = (sessionCount: number): number => 4 + sessionCount

const withScratchPage = <A,>(
  label: string,
  body: (pageId: string) => Effect.Effect<A, unknown, NotionConfig | HttpClient.HttpClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pageId = yield* createScratchPage(label)
      try {
        return yield* body(pageId)
      } finally {
        yield* archiveScratchPage(pageId).pipe(Effect.catchAll(() => Effect.void))
      }
    }).pipe(Effect.provide(IntegrationTestLayer)),
  ) as Promise<A>

const plainText = (node: ReadBlockNode): string => {
  const rt = (node.payload.rich_text ?? []) as readonly { plain_text?: string }[]
  return rt[0]?.plain_text ?? ''
}

const findSessionByTitle = (
  tree: readonly ReadBlockNode[],
  needle: string,
): ReadBlockNode | undefined =>
  tree.find((b) => b.type === 'paragraph' && plainText(b).startsWith(needle))

describe.skipIf(SKIP_INTEGRATION)('sync() mutation contract against live Notion', () => {
  it('initial render on cold cache → appends only (= total block count)', async () => {
    await withScratchPage('mutations-initial', (pageId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        const tree = <DailyPage screenTime="4h 12m" apps={7} sessions={v1} />
        const res = yield* sync(tree, { pageId, cache }).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        )
        expect(res.appends).toBe(totalBlockCount(v1.length))
        expect(res.updates).toBe(0)
        expect(res.inserts).toBe(0)
        expect(res.removes).toBe(0)
        expect(res.fallbackReason).toBe('cold-cache')

        const server = yield* readPageTree(pageId).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        )
        expect(server).toHaveLength(totalBlockCount(v1.length))
      }),
    )
  }, 120_000)

  it('same-tree resync → {0,0,0,0}', async () => {
    await withScratchPage('mutations-noop', (pageId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        const tree = <DailyPage screenTime="4h 12m" apps={7} sessions={v1} />
        yield* sync(tree, { pageId, cache }).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        )
        const res = yield* sync(tree, { pageId, cache }).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        )
        expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
        expect(res.fallbackReason).toBeUndefined()
      }),
    )
  }, 120_000)

  it('one body change → {updates: 1}', async () => {
    await withScratchPage('mutations-body-change', (pageId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        yield* sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
          pageId,
          cache,
        }).pipe(Effect.mapError((cause) => new Error(String(cause))))

        const v2: readonly Session[] = [
          { id: 's1', title: '09:00 Terminal', body: '45 min focused' },
          v1[1]!,
          v1[2]!,
        ]
        const res = yield* sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, {
          pageId,
          cache,
        }).pipe(Effect.mapError((cause) => new Error(String(cause))))

        expect(res).toMatchObject({ appends: 0, updates: 1, inserts: 0, removes: 0 })

        const server = yield* readPageTree(pageId).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        )
        const s1 = findSessionByTitle(server, '09:00 Terminal')
        expect(s1).toBeDefined()
        expect(plainText(s1!)).toBe('09:00 Terminal — 45 min focused')
      }),
    )
  }, 120_000)

  it('append session → {appends: 1}', async () => {
    await withScratchPage('mutations-append-session', (pageId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        yield* sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
          pageId,
          cache,
        }).pipe(Effect.mapError((cause) => new Error(String(cause))))

        const v2: readonly Session[] = [...v1, { id: 's4', title: '12:00 Slack', body: 'chat' }]
        const res = yield* sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, {
          pageId,
          cache,
        }).pipe(Effect.mapError((cause) => new Error(String(cause))))

        expect(res).toMatchObject({ appends: 1, updates: 0, inserts: 0, removes: 0 })

        const server = yield* readPageTree(pageId).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        )
        expect(findSessionByTitle(server, '12:00 Slack')).toBeDefined()
      }),
    )
  }, 120_000)

  it('insert session mid → {inserts: 1}', async () => {
    await withScratchPage('mutations-insert-mid', (pageId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        yield* sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
          pageId,
          cache,
        }).pipe(Effect.mapError((cause) => new Error(String(cause))))

        const v2: readonly Session[] = [
          v1[0]!,
          v1[1]!,
          { id: 's2b', title: '10:30 Figma', body: 'design' },
          v1[2]!,
        ]
        const res = yield* sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, {
          pageId,
          cache,
        }).pipe(Effect.mapError((cause) => new Error(String(cause))))

        expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 1, removes: 0 })

        const server = yield* readPageTree(pageId).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        )
        const titles = server
          .filter((b) => b.type === 'paragraph')
          .map(plainText)
          .filter((t) => t.match(/^\d\d:\d\d /))
        expect(titles).toEqual([
          '09:00 Terminal — 30 min focused',
          '10:00 Browser — research',
          '10:30 Figma — design',
          '11:00 VSCode — coding session',
        ])
      }),
    )
  }, 120_000)

  it('delete session → {removes: 1}', async () => {
    await withScratchPage('mutations-delete', (pageId) =>
      Effect.gen(function* () {
        const cache = InMemoryCache.make()
        yield* sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
          pageId,
          cache,
        }).pipe(Effect.mapError((cause) => new Error(String(cause))))

        const v2: readonly Session[] = v1.filter((s) => s.id !== 's2')
        const res = yield* sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, {
          pageId,
          cache,
        }).pipe(Effect.mapError((cause) => new Error(String(cause))))

        expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 1 })

        const server = yield* readPageTree(pageId).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        )
        expect(findSessionByTitle(server, '10:00 Browser')).toBeUndefined()
        expect(findSessionByTitle(server, '09:00 Terminal')).toBeDefined()
        expect(findSessionByTitle(server, '11:00 VSCode')).toBeDefined()
      }),
    )
  }, 120_000)
})
