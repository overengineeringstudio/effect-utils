import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../../cache/in-memory-cache.ts'
import { Heading2, Paragraph } from '../../components/blocks.tsx'
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
 * Shared fixture mirroring the pixeltrail timeline shape from the derisk
 * report. Each session is a `toggle` with a nested `paragraph` body; the
 * stats line is a plain `paragraph`. Toggles carry `blockKey={id}` so
 * mid-list inserts don't degrade to tail-reorders.
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
      h('toggle', { blockKey: s.id, title: s.title }, <Paragraph>{s.body}</Paragraph>),
    )}
  </>
)

const v1: readonly Session[] = [
  { id: 's1', title: '09:00 Terminal', body: '30 min focused' },
  { id: 's2', title: '10:00 Browser', body: 'research' },
  { id: 's3', title: '11:00 VSCode', body: 'coding session' },
]

/**
 * Top-level block count for a v1-shaped `DailyPage`: 4 static blocks (h2, p,
 * divider, h2) + N toggles. Each toggle's nested paragraph is a child, so
 * total blocks created = 4 + 2*N.
 */
const totalBlockCount = (sessionCount: number): number => 4 + 2 * sessionCount

/** Run a scenario body with a fresh scratch page; always archive on exit. */
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

/** Pluck the rich_text[0].plain_text of a block (or '' if missing). */
const plainText = (node: ReadBlockNode): string => {
  const rt = (node.payload.rich_text ?? []) as readonly { plain_text?: string }[]
  return rt[0]?.plain_text ?? ''
}

const findToggleByTitle = (
  tree: readonly ReadBlockNode[],
  title: string,
): ReadBlockNode | undefined =>
  tree.find((b) => {
    if (b.type !== 'toggle') return false
    const rt = (b.payload.rich_text ?? []) as readonly { plain_text?: string }[]
    return rt[0]?.plain_text === title
  })

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
        // 4 static top-level + 3 toggles = 7 top-level blocks.
        expect(server).toHaveLength(4 + v1.length)
        // Each toggle has one child paragraph.
        const toggles = server.filter((b) => b.type === 'toggle')
        expect(toggles).toHaveLength(v1.length)
        for (const t of toggles) expect(t.children).toHaveLength(1)
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
        const toggle = findToggleByTitle(server, '09:00 Terminal')
        expect(toggle).toBeDefined()
        expect(plainText(toggle!.children[0]!)).toBe('45 min focused')
      }),
    )
  }, 120_000)

  it('append session → {inserts: 2} (toggle + nested paragraph)', async () => {
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

        // Derisk contract: 2 new-block ops total. Nested paragraph is a
        // child block in our reconciler (not embedded), so the total splits
        // as 1 append (tail toggle) + 1 append (its child paragraph) = 2.
        expect(res.updates).toBe(0)
        expect(res.removes).toBe(0)
        expect(res.appends + res.inserts).toBe(2)

        const server = yield* readPageTree(pageId).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        )
        const toggle = findToggleByTitle(server, '12:00 Slack')
        expect(toggle).toBeDefined()
        expect(plainText(toggle!.children[0]!)).toBe('chat')
      }),
    )
  }, 120_000)

  it('insert session mid → {inserts: 2} (toggle + nested paragraph)', async () => {
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

        expect(res.updates).toBe(0)
        expect(res.removes).toBe(0)
        expect(res.appends + res.inserts).toBe(2)

        const server = yield* readPageTree(pageId).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        )
        const toggleTitles = server
          .filter((b) => b.type === 'toggle')
          .map((b) => {
            const rt = (b.payload.rich_text ?? []) as readonly { plain_text?: string }[]
            return rt[0]?.plain_text ?? ''
          })
        expect(toggleTitles).toEqual([
          '09:00 Terminal',
          '10:00 Browser',
          '10:30 Figma',
          '11:00 VSCode',
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

        // Removing the parent toggle is a single remove; Notion cascades
        // the child paragraph.
        expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 1 })

        const server = yield* readPageTree(pageId).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        )
        expect(findToggleByTitle(server, '10:00 Browser')).toBeUndefined()
        expect(findToggleByTitle(server, '09:00 Terminal')).toBeDefined()
        expect(findToggleByTitle(server, '11:00 VSCode')).toBeDefined()
      }),
    )
  }, 120_000)
})
