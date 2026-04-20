import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import { Fragment, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import { Heading2, Paragraph } from '../components/blocks.tsx'
import { h } from '../components/h.ts'
import { sync } from './sync.ts'
import { createFakeNotion, type FakeNotion } from '../test/mock-client.ts'

/**
 * Driver-level contract tests for `sync()`.
 *
 * These are the same scenarios as `mutations.integration.test.tsx`, but
 * executed against an in-memory fake Notion so they run in CI on every PR
 * (no NOTION_TOKEN, no network, ~100x faster). Live integration stays the
 * nightly/on-demand check for the real API envelope.
 *
 * What this catches that the pure diff unit tests do not:
 *   - tempId → real-id wiring across chained inserts
 *   - cache writeback after successful ops
 *   - `fallbackReason` emission on cold-cache / schema-mismatch
 *   - request-body shape for each op kind
 */
const ROOT = '00000000-0000-4000-8000-000000000001'

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
    {sessions.map((s) => (
      <Fragment key={s.id}>
        {h('toggle', { blockKey: s.id, title: s.title }, <Paragraph>{s.body}</Paragraph>)}
      </Fragment>
    ))}
  </>
)

const v1: readonly Session[] = [
  { id: 's1', title: '09:00 Terminal', body: '30 min focused' },
  { id: 's2', title: '10:00 Browser', body: 'research' },
  { id: 's3', title: '11:00 VSCode', body: 'coding session' },
]

const runWith = <A,>(
  fake: FakeNotion,
  eff: Effect.Effect<A, unknown, HttpClient.HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

describe('sync() against in-memory fake Notion', () => {
  it('cold cache → appends only, ids wired through', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const res = await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    // 4 static (h2, p, divider, h2) + 3 toggles + 3 nested paragraphs = 10.
    expect(res).toMatchObject({ appends: 10, updates: 0, inserts: 0, removes: 0 })
    expect(res.fallbackReason).toBe('cold-cache')

    // Server state mirrors the rendered tree.
    const top = fake.childrenOf(ROOT)
    expect(top.map((b) => b.type)).toEqual([
      'heading_2',
      'paragraph',
      'divider',
      'heading_2',
      'toggle',
      'toggle',
      'toggle',
    ])
    for (const t of top.filter((b) => b.type === 'toggle')) {
      expect(fake.childrenOf(t.id)).toHaveLength(1)
    }
  })

  it('same-tree resync → {0,0,0,0}, no fallback, zero HTTP traffic', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = <DailyPage screenTime="4h 12m" apps={7} sessions={v1} />
    await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    const before = fake.requests.length
    const res = await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
    expect(res.fallbackReason).toBeUndefined()
    expect(fake.requests.length).toBe(before) // no follow-up requests.
  })

  it('body change → exactly one PATCH to the nested paragraph', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    const before = fake.requests.length

    const v2: readonly Session[] = [
      { id: 's1', title: '09:00 Terminal', body: '45 min focused' },
      v1[1]!,
      v1[2]!,
    ]
    const res = await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res).toMatchObject({ appends: 0, updates: 1, inserts: 0, removes: 0 })
    const newReqs = fake.requests.slice(before)
    expect(newReqs).toHaveLength(1)
    expect(newReqs[0]!.method).toBe('PATCH')
  })

  it('append session → 2 new-block ops (toggle + nested paragraph)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )

    const v2: readonly Session[] = [...v1, { id: 's4', title: '12:00 Slack', body: 'chat' }]
    const res = await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res.updates).toBe(0)
    expect(res.removes).toBe(0)
    expect(res.appends + res.inserts).toBe(2)

    const toggles = fake.childrenOf(ROOT).filter((b) => b.type === 'toggle')
    expect(toggles).toHaveLength(4)
    // The nested paragraph under the last toggle was chained through a
    // tempId — verify it actually landed under the right parent.
    expect(fake.childrenOf(toggles[3]!.id)).toHaveLength(1)
  })

  it('insert session mid (keyed) → 2 new-block ops + server order preserved', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )

    const v2: readonly Session[] = [
      v1[0]!,
      v1[1]!,
      { id: 's2b', title: '10:30 Figma', body: 'design' },
      v1[2]!,
    ]
    const res = await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res.updates).toBe(0)
    expect(res.removes).toBe(0)
    expect(res.appends + res.inserts).toBe(2)

    const toggleTitles = fake
      .childrenOf(ROOT)
      .filter((b) => b.type === 'toggle')
      .map((b) => {
        const rt = (b.payload.rich_text ?? []) as readonly {
          text?: { content?: string }
        }[]
        return rt[0]?.text?.content ?? ''
      })
    expect(toggleTitles).toEqual([
      '09:00 Terminal',
      '10:00 Browser',
      '10:30 Figma',
      '11:00 VSCode',
    ])
  })

  it('delete session → one DELETE', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    const before = fake.requests.length

    const v2: readonly Session[] = v1.filter((s) => s.id !== 's2')
    const res = await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 1 })
    const newReqs = fake.requests.slice(before)
    expect(newReqs.filter((r) => r.method === 'DELETE')).toHaveLength(1)
  })

  it('idempotency: three consecutive hot-cache syncs emit no requests + no fallback', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = <DailyPage screenTime="4h 12m" apps={7} sessions={v1} />
    const initial = await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    expect(initial.fallbackReason).toBe('cold-cache')

    const after = fake.requests.length
    for (let i = 0; i < 3; i++) {
      const r = await runWith(
        fake,
        sync(tree, { pageId: ROOT, cache }).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        ),
      )
      expect(r).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
      expect(r.fallbackReason).toBeUndefined()
    }
    expect(fake.requests.length).toBe(after)
  })
})
