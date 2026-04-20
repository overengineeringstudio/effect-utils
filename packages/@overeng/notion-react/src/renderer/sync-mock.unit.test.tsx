import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import { Fragment, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import { Heading2, Paragraph } from '../components/blocks.tsx'
import { h } from '../components/h.ts'
import { createFakeNotion, type FakeNotion } from '../test/mock-client.ts'
import { sync } from './sync.ts'

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

  it('same-tree resync → {0,0,0,0}, no fallback, only the drift-check GET', async () => {
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
    // Pre-flight drift check (#105) issues exactly one GET; no mutating ops.
    const newReqs = fake.requests.slice(before)
    expect(newReqs.map((r) => r.method)).toEqual(['GET'])
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
    // Pre-flight drift GET + one PATCH for the body change.
    const newReqs = fake.requests.slice(before)
    expect(newReqs.map((r) => r.method)).toEqual(['GET', 'PATCH'])
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
    expect(toggleTitles).toEqual(['09:00 Terminal', '10:00 Browser', '10:30 Figma', '11:00 VSCode'])
  })

  it('insert session at head (afterId==="") → server + working cache both prepend', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )

    /* New session sorts before every existing one → sync-diff emits an
       insert with afterId==='' (the head marker). Previously the driver
       dropped the `position` envelope and the block landed at the tail of
       the parent, corrupting order; now it must use position:{type:'start'}. */
    const v2: readonly Session[] = [{ id: 's0', title: '08:00 Email', body: 'inbox zero' }, ...v1]
    const res = await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res.updates).toBe(0)
    expect(res.removes).toBe(0)
    expect(res.inserts).toBeGreaterThanOrEqual(1)

    const toggleTitles = fake
      .childrenOf(ROOT)
      .filter((b) => b.type === 'toggle')
      .map((b) => {
        const rt = (b.payload.rich_text ?? []) as readonly {
          text?: { content?: string }
        }[]
        return rt[0]?.text?.content ?? ''
      })
    expect(toggleTitles).toEqual(['08:00 Email', '09:00 Terminal', '10:00 Browser', '11:00 VSCode'])

    /* Resync with the same tree must be a true no-op — if the working cache
       placed the new toggle at the tail while the server placed it at head,
       the next diff would see order drift and re-insert. */
    const before = fake.requests.length
    const rerun = await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(rerun).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
    const rerunReqs = fake.requests.slice(before)
    expect(rerunReqs.map((r) => r.method)).toEqual(['GET'])
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

  it('idempotency: three consecutive hot-cache syncs emit no mutations + no fallback', async () => {
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
    // Exactly one drift-check GET per hot-cache resync, no mutations.
    const methods = fake.requests.slice(after).map((r) => r.method)
    expect(methods).toEqual(['GET', 'GET', 'GET'])
  })

  it('drift detection: out-of-band archive on a tracked block forces cache-drift rebuild', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )

    // Simulate another client archiving one of the toggles out-of-band.
    const firstToggle = fake.childrenOf(ROOT).find((b) => b.type === 'toggle')!
    firstToggle.archived = true

    const res = await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res.fallbackReason).toBe('cache-drift')
    // Full rebuild: 10 fresh appends, no updates/removes.
    expect(res).toMatchObject({ appends: 10, updates: 0, inserts: 0, removes: 0 })
  })

  it('page-id-drift: cache written for a different pageId cold-starts', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const OTHER = '00000000-0000-4000-8000-000000000002'
    // Populate the cache against `ROOT`.
    await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    // Re-use the same cache for a different pageId. Must not diff against the
    // stale ROOT tree — that would target wrong-page ids. Expect cold start.
    const res = await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: OTHER,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res.fallbackReason).toBe('page-id-drift')
    expect(res).toMatchObject({ appends: 10, updates: 0, inserts: 0, removes: 0 })
    // All mutations target OTHER, not ROOT.
    expect(fake.childrenOf(OTHER).length).toBeGreaterThan(0)
  })
})
