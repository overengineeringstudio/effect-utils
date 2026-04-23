import { HttpClient, HttpClientRequest } from '@effect/platform'
import { Effect } from 'effect'
import { Fragment, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import type { CacheNode, CacheTree, NotionCache } from '../cache/types.ts'
import {
  Column,
  ColumnList,
  Heading2,
  Image,
  Paragraph,
  Table,
  TableRow,
} from '../components/blocks.ts'
import { h } from '../components/h.ts'
import {
  createFakeNotion,
  type FakeBlock,
  FakeNotionResponseError,
  type FakeNotion,
  type FakeRequest,
} from '../test/mock-client.ts'
import type { SyncEvent } from './sync-events.ts'
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

/** Spy wrapper over `InMemoryCache` that exposes every persisted snapshot. */
const spyCache = (): {
  readonly cache: NotionCache
  readonly snapshots: readonly CacheTree[]
  readonly current: () => CacheTree | undefined
} => {
  const underlying = InMemoryCache.make()
  const snapshots: CacheTree[] = []
  let latest: CacheTree | undefined
  const cache: NotionCache = {
    load: underlying.load,
    save: (tree) =>
      Effect.gen(function* () {
        snapshots.push(tree)
        latest = tree
        yield* underlying.save(tree)
      }),
  }
  return { cache, snapshots, current: () => latest }
}

const flattenCache = (tree: CacheTree): readonly CacheNode[] => {
  const out: CacheNode[] = []
  const walk = (n: CacheNode): void => {
    out.push(n)
    for (const c of n.children) walk(c)
  }
  for (const c of tree.children) walk(c)
  return out
}

const hasGhostEntries = (tree: CacheTree): boolean =>
  flattenCache(tree).some(
    (n) => n.key.startsWith('drift:') || (n.type === 'unknown' && n.hash === ''),
  )

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
    // Drift recovery is targeted: the hybrid `driftedBase` preserves prior
    // cache entries for blocks that are still live, so only the actual drift
    // (the one missing toggle) drives ops. The diff re-inserts one toggle
    // (matching the candidate key whose block is missing) and leaves every
    // other top-level block retained. There are zero updates; `removes` is
    // zero because no prior-cache entry was orphaned (the archived toggle's
    // key is still in the candidate, so it becomes a re-insert, not a
    // remove).
    expect(res).toMatchObject({ updates: 0 })
    expect(res.appends + res.inserts).toBeLessThanOrEqual(2)
    expect(res.appends + res.inserts).toBeGreaterThanOrEqual(1)
  })

  it('drift detection: LARGE warm page with 1-block drift → minimal ops (regression: #warm-sync-slow)', async () => {
    // Regression test for: warm sync on 500+ block page hung >5 minutes
    // because any ordered-sequence mismatch triggered a full rebuild
    // (remove every live block, append every candidate block).
    // Post-fix: hybrid drift base preserves prior cache entries for blocks
    // still live, so diff emits only ops for the actual drift.
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // 20 toggle sessions is enough to make the blast radius obvious while
    // keeping the test snappy. Old behavior: 20 removes + 40 appends (2 per
    // session). New behavior: 0-2 ops for a 1-block drift.
    const manySessions: readonly Session[] = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      title: `App${i}`,
      body: `${5 + i} min focused`,
    }))
    await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={20} sessions={manySessions} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    // Archive exactly one toggle out of band.
    const firstToggle = fake.childrenOf(ROOT).find((b) => b.type === 'toggle')!
    firstToggle.archived = true

    const res = await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={20} sessions={manySessions} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res.fallbackReason).toBe('cache-drift')
    // Total ops bounded by the drift magnitude, not by tree size. Old
    // behavior emitted ~19 removes + ~22 appends; new behavior emits a
    // small constant.
    const totalOps = res.appends + res.inserts + res.updates + res.removes
    expect(totalOps).toBeLessThanOrEqual(4)
  })

  // ---------------------------------------------------------------
  // Atomic containers (column_list) — must ship full nested subtree
  // in a single `appendChildren` call. Staged-append is rejected by
  // Notion with validation_error; the fake mirrors this.
  // ---------------------------------------------------------------
  it('column_list → single appendChildren with nested column/image payload', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <ColumnList>
        <Column>
          <Image url="https://example.com/a.png" />
        </Column>
        <Column>
          <Image url="https://example.com/b.png" />
        </Column>
      </ColumnList>
    )
    const res = await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    // One diff op per rendered block: 1 column_list + 2 columns + 2 images = 5.
    // All five get absorbed into a single atomic payload, but the diff-level
    // tally still reflects the rendered shape.
    expect(res.appends).toBe(5)
    expect(res.updates + res.inserts + res.removes).toBe(0)

    // Exactly one children-append for the column_list (+ nothing else).
    // The notion-effect-client uses PATCH for `appendBlockChildren`.
    const mutating = fake.requests.filter(
      (r) => r.method === 'PATCH' && /\/blocks\/[^/]+\/children$/.test(r.path),
    )
    expect(mutating).toHaveLength(1)
    const body = mutating[0]!.body as {
      children: { type: string; column_list: { children: unknown[] } }[]
    }
    expect(body.children).toHaveLength(1)
    expect(body.children[0]!.type).toBe('column_list')
    expect(body.children[0]!.column_list.children).toHaveLength(2)

    // Server tree shape.
    const top = fake.childrenOf(ROOT)
    expect(top.map((b) => b.type)).toEqual(['column_list'])
    const cols = fake.childrenOf(top[0]!.id)
    expect(cols.map((b) => b.type)).toEqual(['column', 'column'])
    for (const c of cols) {
      const kids = fake.childrenOf(c.id)
      expect(kids.map((b) => b.type)).toEqual(['image'])
    }
  })

  it('column_list resync is a true no-op (nested tmpIds resolved to server ids)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <ColumnList>
        <Column>
          <Image url="https://example.com/a.png" />
        </Column>
        <Column>
          <Image url="https://example.com/b.png" />
        </Column>
      </ColumnList>
    )
    await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    const before = fake.requests.length
    const rerun = await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    // If nested tmpIds were not resolved, the persisted cache would carry
    // `tmp-*` ids and the second sync would throw from candidateToCache.
    expect(rerun).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
    expect(rerun.fallbackReason).toBeUndefined()
    const newReqs = fake.requests.slice(before)
    expect(newReqs.map((r) => r.method)).toEqual(['GET'])
  })

  // Warm-sync regression: any structural change inside a retained
  // column_list (column added/removed/reordered, or a column's own
  // children changed) must force a full remove+recreate of the whole
  // column_list. Notion rejects per-column mutation — appending a bare
  // `column` fails with `body.children[0].column.children should be
  // defined` (pixeltrail dogfood: warm sync of daily page, trace
  // `ac464743e6daa36e75f4f427df179a54`).
  it('column_list warm-sync: adding a column triggers full rebuild, not a bare column append', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const clV1 = (
      <ColumnList>
        <Column blockKey="left">
          <Image url="https://example.com/a.png" />
        </Column>
        <Column blockKey="right">
          <Image url="https://example.com/b.png" />
        </Column>
      </ColumnList>
    )
    const clV2 = (
      <ColumnList>
        <Column blockKey="left">
          <Image url="https://example.com/a.png" />
        </Column>
        <Column blockKey="middle">
          <Image url="https://example.com/m.png" />
        </Column>
        <Column blockKey="right">
          <Image url="https://example.com/b.png" />
        </Column>
      </ColumnList>
    )
    await runWith(
      fake,
      sync(clV1, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    // Warm sync with a new column in the middle. Must NOT emit a bare
    // `column` append — the fake's validateAtomic would reject that.
    const res = await runWith(
      fake,
      sync(clV2, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    // Full rebuild semantics: the previous column_list is removed, the
    // new one appended (+ nested rendered blocks tallied).
    expect(res.removes).toBe(1)
    expect(res.appends + res.inserts).toBeGreaterThanOrEqual(1)
    const top = fake.childrenOf(ROOT)
    expect(top.map((b) => b.type)).toEqual(['column_list'])
    const cols = fake.childrenOf(top[0]!.id)
    expect(cols).toHaveLength(3)
    expect(cols.every((c) => c.type === 'column')).toBe(true)
  })

  it('column_list warm-sync: a column whose own children changed also forces full rebuild', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const clV1 = (
      <ColumnList>
        <Column blockKey="a">
          <Image url="https://example.com/a.png" />
        </Column>
        <Column blockKey="b">
          <Image url="https://example.com/b.png" />
        </Column>
      </ColumnList>
    )
    const clV2 = (
      <ColumnList>
        <Column blockKey="a">
          <Image url="https://example.com/a.png" />
          <Paragraph>extra</Paragraph>
        </Column>
        <Column blockKey="b">
          <Image url="https://example.com/b.png" />
        </Column>
      </ColumnList>
    )
    await runWith(
      fake,
      sync(clV1, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    // The inner paragraph is new and its parent column existed; a naive
    // diff would emit `append` of a paragraph under the old column.
    // Appending children into an existing column IS supported by Notion,
    // so in principle this could be a surgical op — but the cache path
    // currently lacks an incremental-rebuild strategy below column_list,
    // so we conservatively rebuild the whole column_list to stay correct.
    const res = await runWith(
      fake,
      sync(clV2, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    expect(res.removes).toBeGreaterThanOrEqual(1)
    // Most importantly: no validation error from the fake. If a bare
    // `column` append slipped through, the fake would have thrown.
    const top = fake.childrenOf(ROOT)
    expect(top.map((b) => b.type)).toEqual(['column_list'])
  })

  // ---------------------------------------------------------------
  // Atomic container: `table` — same staged-append prohibition as
  // column_list. Rows must ship inlined; cells travel inside each
  // table_row's props (rich_text[][]), not as nested blocks.
  // ---------------------------------------------------------------
  it('table → single appendChildren with nested table_row children + cells as props', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <Table tableWidth={2}>
        <TableRow cells={['A', 'B']} />
        <TableRow cells={['C', 'D']} />
      </Table>
    )
    const res = await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    // 1 table + 2 table_rows = 3 diff-level appends, all folded into one call.
    expect(res.appends).toBe(3)
    expect(res.updates + res.inserts + res.removes).toBe(0)

    const mutating = fake.requests.filter(
      (r) => r.method === 'PATCH' && /\/blocks\/[^/]+\/children$/.test(r.path),
    )
    expect(mutating).toHaveLength(1)
    const body = mutating[0]!.body as {
      children: {
        type: string
        table: {
          table_width?: number
          children: { type: string; table_row: { cells: unknown[][] } }[]
        }
      }[]
    }
    expect(body.children).toHaveLength(1)
    expect(body.children[0]!.type).toBe('table')
    expect(body.children[0]!.table.table_width).toBe(2)
    expect(body.children[0]!.table.children).toHaveLength(2)
    // Cells are inlined into table_row props, not projected as blocks.
    expect(body.children[0]!.table.children[0]!.type).toBe('table_row')
    expect(body.children[0]!.table.children[0]!.table_row.cells).toHaveLength(2)

    // Warm re-sync is a no-op (nested table_row tmpIds resolved to server ids).
    const before = fake.requests.length
    const rerun = await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    expect(rerun).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
    expect(rerun.fallbackReason).toBeUndefined()
    const newReqs = fake.requests.slice(before)
    expect(newReqs.map((r) => r.method)).toEqual(['GET'])
  })

  it('mixed atomic nesting: ColumnList with a table inside a column', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <ColumnList>
        <Column>
          <Table>
            <TableRow cells={['A']} />
          </Table>
        </Column>
        <Column>
          <Paragraph>right</Paragraph>
        </Column>
      </ColumnList>
    )
    const res = await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    // 1 column_list + 2 columns + 1 table + 1 table_row + 1 paragraph = 6.
    expect(res.appends).toBe(6)
    // Everything folds into one PATCH on the page.
    const mutating = fake.requests.filter(
      (r) => r.method === 'PATCH' && /\/blocks\/[^/]+\/children$/.test(r.path),
    )
    expect(mutating).toHaveLength(1)

    // Server tree shape: ROOT > column_list > [column, column].
    const top = fake.childrenOf(ROOT)
    expect(top.map((b) => b.type)).toEqual(['column_list'])
    const cols = fake.childrenOf(top[0]!.id)
    expect(cols.map((b) => b.type)).toEqual(['column', 'column'])
    // First column has a table with one row.
    const leftKids = fake.childrenOf(cols[0]!.id)
    expect(leftKids.map((b) => b.type)).toEqual(['table'])
    const rows = fake.childrenOf(leftKids[0]!.id)
    expect(rows.map((b) => b.type)).toEqual(['table_row'])
    // Second column has a paragraph.
    const rightKids = fake.childrenOf(cols[1]!.id)
    expect(rightKids.map((b) => b.type)).toEqual(['paragraph'])
  })

  // ---------------------------------------------------------------
  // Large-table chunking — Notion caps `table.children` at 100 per
  // request (same 100-cap as top-level append children). Tables with
  // more rows ship the first 100 inline with the table create, then
  // issue follow-up appendBlockChildren calls in 100-row batches.
  // Pixeltrail dogfood v3 found 139-row activity tables hitting this.
  // ---------------------------------------------------------------
  const rowsOf = (n: number): ReactNode[] =>
    Array.from({ length: n }, (_, i) => <TableRow key={`r${i}`} cells={[String(i)]} />)

  const mutatingAppends = (fake: FakeNotion): readonly FakeRequest[] =>
    fake.requests.filter(
      (r) =>
        (r.method === 'PATCH' || r.method === 'POST') && /\/blocks\/[^/]+\/children$/.test(r.path),
    )

  it('table with exactly 100 rows → single appendChildren (at-cap, no follow-up)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = <Table tableWidth={1}>{rowsOf(100)}</Table>
    await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    const mutating = mutatingAppends(fake)
    expect(mutating).toHaveLength(1)
    const body = mutating[0]!.body as {
      children: { table: { children: unknown[] } }[]
    }
    expect(body.children[0]!.table.children).toHaveLength(100)
  })

  it('table with 101 rows → 2 PATCHes (100 inline + 1 follow-up append)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = <Table tableWidth={1}>{rowsOf(101)}</Table>
    await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    const mutating = mutatingAppends(fake)
    expect(mutating).toHaveLength(2)
    const createBody = mutating[0]!.body as { children: { table: { children: unknown[] } }[] }
    expect(createBody.children[0]!.table.children).toHaveLength(100)
    const overflowBody = mutating[1]!.body as { children: { type: string }[] }
    expect(overflowBody.children).toHaveLength(1)
    expect(overflowBody.children[0]!.type).toBe('table_row')

    // Server has all 101 rows in the right order.
    const top = fake.childrenOf(ROOT)
    expect(top.map((b) => b.type)).toEqual(['table'])
    const rows = fake.childrenOf(top[0]!.id)
    expect(rows).toHaveLength(101)
    // Row content preserved end-to-end: the i-th row carries cell text "i".
    // Cells are rich_text[][] after host-config projection.
    const firstCellText = (b: FakeBlock): string => {
      const cells = b.payload.cells as readonly (readonly { text?: { content?: string } }[])[]
      return cells[0]?.[0]?.text?.content ?? ''
    }
    expect(rows.map(firstCellText)).toEqual(Array.from({ length: 101 }, (_, i) => String(i)))
  })

  it('table with 150 rows → 2 PATCHes (100 inline + 50 follow-up)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = <Table tableWidth={1}>{rowsOf(150)}</Table>
    await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    const mutating = mutatingAppends(fake)
    expect(mutating).toHaveLength(2)
    const createBody = mutating[0]!.body as { children: { table: { children: unknown[] } }[] }
    expect(createBody.children[0]!.table.children).toHaveLength(100)
    const overflowBody = mutating[1]!.body as { children: unknown[] }
    expect(overflowBody.children).toHaveLength(50)

    const top = fake.childrenOf(ROOT)
    const rows = fake.childrenOf(top[0]!.id)
    expect(rows).toHaveLength(150)
  })

  it('table with 250 rows → 3 PATCHes (100 + 100 + 50)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = <Table tableWidth={1}>{rowsOf(250)}</Table>
    await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    const mutating = mutatingAppends(fake)
    expect(mutating).toHaveLength(3)
    const sizes = mutating.map((r) => {
      const body = r.body as { children: { type: string; table?: { children?: unknown[] } }[] }
      return body.children[0]!.type === 'table'
        ? body.children[0]!.table!.children!.length
        : body.children.length
    })
    expect(sizes).toEqual([100, 100, 50])
  })

  it('chunked table → warm resync is a no-op (all row tmpIds resolved)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = <Table tableWidth={1}>{rowsOf(150)}</Table>
    await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    const before = fake.requests.length
    const rerun = await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    expect(rerun).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
    expect(rerun.fallbackReason).toBeUndefined()
    const newReqs = fake.requests.slice(before)
    expect(newReqs.map((r) => r.method)).toEqual(['GET'])
  })

  it('nested atomic overflow (table with 150 rows inside column_list > column) — throws clearly', async () => {
    // A big table nested inside an atomic column_list payload cannot be
    // chunked with the current implementation: the table isn't the
    // top-level atomic container, so its rows would have to ship inline
    // with the column_list create — and that exceeds Notion's 100-per-level
    // cap. Surface loudly rather than dropping rows silently. If this
    // shape becomes common, extend chunking to nested levels.
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <ColumnList>
        <Column>
          <Table tableWidth={1}>{rowsOf(150)}</Table>
        </Column>
        <Column>
          <Paragraph>right</Paragraph>
        </Column>
      </ColumnList>
    )
    await expect(
      runWith(
        fake,
        sync(tree, { pageId: ROOT, cache }).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        ),
      ),
    ).rejects.toThrow(/nested level/i)
  })

  // -----------------------------------------------------------------
  // Fallback-path cache hygiene (pixeltrail dogfood v4).
  //
  // Every fallback reason (cold-cache / cache-drift / page-id-drift)
  // must persist a cache containing ONLY real typed/hashed entries —
  // zero `drift:*` ghost entries and zero `type:'unknown'` rows. A
  // poisoned cache drives the next warm sync to issue deletes against
  // already-archived blocks (Notion rejects with "Can't edit block that
  // is archived"), breaking convergence.
  // -----------------------------------------------------------------
  it('cold → warm: warm resync emits zero mutating ops against mock Notion (dogfood v4)', async () => {
    const fake = createFakeNotion()
    const { cache } = spyCache()
    const tree = <DailyPage screenTime="4h 12m" apps={7} sessions={v1} />
    const cold = await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    expect(cold.fallbackReason).toBe('cold-cache')
    const before = fake.requests.length
    const warm = await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    expect(warm).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
    const warmReqs = fake.requests.slice(before)
    // Only the drift-check GET; no PATCH / DELETE / POST.
    expect(warmReqs.map((r) => r.method)).toEqual(['GET'])
  })

  it('cold-cache: persisted cache has zero ghost entries', async () => {
    const fake = createFakeNotion()
    const spy = spyCache()
    await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache: spy.cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    const final = spy.current()!
    expect(final.children.length).toBeGreaterThan(0)
    expect(hasGhostEntries(final)).toBe(false)
    // Every persisted checkpoint — not just the final save — must be clean.
    for (const snap of spy.snapshots) expect(hasGhostEntries(snap)).toBe(false)
  })

  it('cache-drift: persisted cache has zero ghost entries even after drift rebuild', async () => {
    const fake = createFakeNotion()
    const spy = spyCache()
    await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache: spy.cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    // Force drift: archive a toggle out-of-band, then re-sync.
    const firstToggle = fake.childrenOf(ROOT).find((b) => b.type === 'toggle')!
    firstToggle.archived = true
    const res = await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache: spy.cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res.fallbackReason).toBe('cache-drift')
    const final = spy.current()!
    expect(hasGhostEntries(final)).toBe(false)
    for (const snap of spy.snapshots) expect(hasGhostEntries(snap)).toBe(false)
  })

  it('cache-drift → warm: subsequent warm sync is a true no-op (no deletes on archived blocks)', async () => {
    const fake = createFakeNotion()
    const spy = spyCache()
    const tree = <DailyPage screenTime="4h 12m" apps={7} sessions={v1} />
    await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache: spy.cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    // Out-of-band archive forces a cache-drift rebuild next sync.
    const firstToggle = fake.childrenOf(ROOT).find((b) => b.type === 'toggle')!
    firstToggle.archived = true
    const drifted = await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache: spy.cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    expect(drifted.fallbackReason).toBe('cache-drift')
    const before = fake.requests.length
    // Next warm sync must not re-delete the already-archived block and must
    // not touch any other live block.
    const warm = await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache: spy.cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    expect(warm).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
    const warmReqs = fake.requests.slice(before)
    expect(warmReqs.every((r) => r.method === 'GET')).toBe(true)
  })

  it('page-id-drift: persisted cache has zero ghost entries', async () => {
    const fake = createFakeNotion()
    const spy = spyCache()
    const OTHER = '00000000-0000-4000-8000-000000000002'
    await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache: spy.cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    const res = await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: OTHER,
        cache: spy.cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res.fallbackReason).toBe('page-id-drift')
    const final = spy.current()!
    expect(hasGhostEntries(final)).toBe(false)
    for (const snap of spy.snapshots) expect(hasGhostEntries(snap)).toBe(false)
  })

  it('fake Notion: update/delete against archived block fails with validation_error shape', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(
      fake,
      sync(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />, {
        pageId: ROOT,
        cache,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    const toggle = fake.childrenOf(ROOT).find((b) => b.type === 'toggle')!
    toggle.archived = true
    // Direct HTTP probe against the archived block — both PATCH and DELETE
    // must respond with Notion's archived-block error envelope (HTTP 400 +
    // `code: 'validation_error'`). The real Notion client surfaces this as
    // a `NotionApiError`; here we just check the raw HTTP shape.
    const probe = (
      method: 'PATCH' | 'DELETE',
    ): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> =>
      runWith(
        fake,
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient
          const url = `https://api.notion.com/v1/blocks/${toggle.id}`
          const req =
            method === 'PATCH'
              ? HttpClientRequest.patch(url).pipe(
                  HttpClientRequest.bodyText('{"toggle":{}}', 'application/json'),
                )
              : HttpClientRequest.del(url)
          const res = yield* http.execute(req)
          const body = (yield* res.json) as Record<string, unknown>
          return { status: res.status, body }
        }),
      )
    for (const m of ['PATCH', 'DELETE'] as const) {
      const { status, body } = await probe(m)
      expect(status).toBe(400)
      expect(body).toMatchObject({
        object: 'error',
        code: 'validation_error',
        message: expect.stringMatching(/archived/i),
      })
    }
  })

  // -----------------------------------------------------------------
  // pixeltrail dogfood v5 — idempotent delete + clean cold baseline.
  //
  // v5 symptom: warm sync's drift-recovery computed 13 deletes; Notion had
  // already archived the first target out of band → 400 validation_error
  // `Can't edit block that is archived` → sync aborted with 5 blocks still
  // alive on the page. Root: the live page accumulated leftover blocks
  // across runs (cold sync never cleaned them), plus a prior warm sync had
  // archived some blocks that the cache still believed live. Both issues
  // fixed here: cold-baseline sweep (Fix B) + idempotent delete (Fix A).
  // -----------------------------------------------------------------
  it('fix A: delete against an already-archived block → idempotent success (no abort)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // Seed two paragraphs.
    await runWith(
      fake,
      sync(
        <>
          <Paragraph>p1</Paragraph>
          <Paragraph>p2</Paragraph>
        </>,
        { pageId: ROOT, cache },
      ).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    // Unkeyed Paragraphs are positional; removing the last one in the
    // candidate tree causes a DELETE of the trailing cached block.
    const cached = fake.childrenOf(ROOT)
    const doomedId = cached[cached.length - 1]!.id
    // Simulate the dogfood v5 race: retrieve reports the block as live,
    // but the subsequent DELETE discovers Notion already archived it
    // (prior aborted sync's partial commit, another writer, etc.).
    // `failOn` injects the archived-block error envelope for that DELETE
    // while leaving the GET response untouched.
    fake.failOn((req) =>
      req.method === 'DELETE' && req.path === `/v1/blocks/${doomedId}`
        ? new FakeNotionResponseError(
            400,
            'validation_error',
            "Can't edit block that is archived. You must unarchive the block before editing.",
          )
        : undefined,
    )
    // Render a shorter tree: diff emits a delete for the trailing block.
    // The sync must absorb the 400 as idempotent success.
    const events: SyncEvent[] = []
    const res = await runWith(
      fake,
      sync(<Paragraph>p2</Paragraph>, {
        pageId: ROOT,
        cache,
        onEvent: (e) => events.push(e),
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    // No fallback needed — retrieve still reports both as live, so the
    // diff is computed against the warm cache normally.
    expect(res).toMatchObject({ removes: 1 })
    const deleteSuccesses = events.filter(
      (e): e is Extract<SyncEvent, { _tag: 'OpSucceeded' }> =>
        e._tag === 'OpSucceeded' && e.kind === 'delete',
    )
    expect(deleteSuccesses.length).toBe(1)
    expect(deleteSuccesses[0]!.note).toBe('already-archived')
    // No OpFailed delete events surfaced — idempotency absorbed the 400.
    expect(
      events.filter((e) => e._tag === 'OpFailed' && (e as { kind: string }).kind === 'delete'),
    ).toEqual([])
  })

  it('fix B: cold-baseline clean → pre-existing live children are archived before appending', async () => {
    const fake = createFakeNotion()
    // Seed the live page from a different sync run (cache discarded
    // afterwards — simulates the pre-v5 state where cold syncs left
    // orphaned blocks behind).
    await runWith(
      fake,
      sync(
        <>
          <Paragraph>leftover-1</Paragraph>
          <Paragraph>leftover-2</Paragraph>
          <Paragraph>leftover-3</Paragraph>
          <Paragraph>leftover-4</Paragraph>
          <Paragraph>leftover-5</Paragraph>
        </>,
        { pageId: ROOT, cache: InMemoryCache.make() },
      ).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    const seeded = fake.childrenOf(ROOT)
    expect(seeded.length).toBe(5)
    const seededIds = new Set(seeded.map((b) => b.id))

    // Cold sync with a fresh cache and `coldBaseline: 'clean'` (default):
    // every seeded block must be archived, then the new tree appended.
    const cache = InMemoryCache.make()
    const res = await runWith(
      fake,
      sync(
        <>
          <Paragraph>fresh-1</Paragraph>
          <Paragraph>fresh-2</Paragraph>
        </>,
        { pageId: ROOT, cache },
      ).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res.fallbackReason).toBe('cold-cache')
    expect(res).toMatchObject({ appends: 2, removes: 5 })

    // All seeded blocks are archived; only the fresh ones are live.
    for (const id of seededIds) {
      expect(fake.blocks.get(id)?.archived).toBe(true)
    }
    const liveAfter = fake.childrenOf(ROOT)
    expect(liveAfter.length).toBe(2)
    expect(liveAfter.every((b) => !seededIds.has(b.id))).toBe(true)

    // Follow-up warm sync is a true no-op against a clean baseline.
    const before = fake.requests.length
    const warm = await runWith(
      fake,
      sync(
        <>
          <Paragraph>fresh-1</Paragraph>
          <Paragraph>fresh-2</Paragraph>
        </>,
        { pageId: ROOT, cache },
      ).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(warm).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
    const warmReqs = fake.requests.slice(before)
    expect(warmReqs.every((r) => r.method === 'GET')).toBe(true)
  })

  it('fix B: coldBaseline "merge" → preserves existing children on cold sync', async () => {
    const fake = createFakeNotion()
    await runWith(
      fake,
      sync(
        <>
          <Paragraph>leftover-1</Paragraph>
          <Paragraph>leftover-2</Paragraph>
        </>,
        { pageId: ROOT, cache: InMemoryCache.make() },
      ).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    const seededIds = new Set(fake.childrenOf(ROOT).map((b) => b.id))
    const cache = InMemoryCache.make()
    const res = await runWith(
      fake,
      sync(
        <>
          <Paragraph>fresh-1</Paragraph>
        </>,
        { pageId: ROOT, cache, coldBaseline: 'merge' },
      ).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res.fallbackReason).toBe('cold-cache')
    // Merge semantics: no removes on cold; leftovers remain alive. They
    // *will* show up as cache-drift on the next warm sync (consumer's
    // choice — documented on the `coldBaseline` option).
    expect(res).toMatchObject({ removes: 0 })
    for (const id of seededIds) {
      expect(fake.blocks.get(id)?.archived).toBe(false)
    }
    expect(fake.childrenOf(ROOT).length).toBe(3)
  })

  it('fix A+B: dogfood-v5 full reproduction — cold + race-archive + warm converges', async () => {
    const fake = createFakeNotion()
    // Step 1: pre-existing live blocks from a prior run without cache.
    await runWith(
      fake,
      sync(
        <>
          <Paragraph>r0-a</Paragraph>
          <Paragraph>r0-b</Paragraph>
          <Paragraph>r0-c</Paragraph>
        </>,
        { pageId: ROOT, cache: InMemoryCache.make() },
      ).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    // Step 2: cold sync against fresh cache — Fix B archives all 3
    // leftovers, then appends 4 fresh blocks.
    const cache = InMemoryCache.make()
    const coldRes = await runWith(
      fake,
      sync(
        <>
          <Paragraph>r1-a</Paragraph>
          <Paragraph>r1-b</Paragraph>
          <Paragraph>r1-c</Paragraph>
          <Paragraph>r1-d</Paragraph>
        </>,
        { pageId: ROOT, cache },
      ).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(coldRes).toMatchObject({ fallbackReason: 'cold-cache', removes: 3, appends: 4 })
    const live = fake.childrenOf(ROOT)
    expect(live.length).toBe(4)
    // Step 3: race simulation — next warm sync will attempt to delete two
    // cached blocks (we'll render a smaller tree), but Notion has already
    // archived them out of band. Retrieve still reports them as live. The
    // DELETE call must be absorbed as idempotent.
    // Positional-key diff on 4→2 candidate drops the trailing two blocks.
    // Both doomed ids get failOn'd so both DELETEs hit the archived path.
    const racedIds = new Set([live[2]!.id, live[3]!.id])
    fake.failOn((req) =>
      req.method === 'DELETE' && racedIds.has(req.path.split('/').pop()!)
        ? new FakeNotionResponseError(
            400,
            'validation_error',
            "Can't edit block that is archived. You must unarchive the block before editing.",
          )
        : undefined,
    )
    // Step 4: warm sync with a reduced tree of 2 blocks. Diff emits 2
    // removes (the first and third cached blocks) and 0 appends (the
    // surviving r1-b, r1-d match by positional key). Both removes hit
    // already-archived blocks; Fix A absorbs both; sync converges.
    const events: SyncEvent[] = []
    const warm = await runWith(
      fake,
      sync(
        <>
          <Paragraph>r1-b</Paragraph>
          <Paragraph>r1-d</Paragraph>
        </>,
        { pageId: ROOT, cache, onEvent: (e) => events.push(e) },
      ).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(warm.removes).toBe(2)
    const deleteSuccesses = events.filter(
      (e): e is Extract<SyncEvent, { _tag: 'OpSucceeded' }> =>
        e._tag === 'OpSucceeded' && e.kind === 'delete',
    )
    expect(deleteSuccesses.length).toBe(2)
    expect(deleteSuccesses.every((e) => e.note === 'already-archived')).toBe(true)
    expect(
      events.filter((e) => e._tag === 'OpFailed' && (e as { kind: string }).kind === 'delete'),
    ).toEqual([])
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

  /**
   * Regression: pixeltrail dogfood v8 observed a warm sync on a tree
   * containing a column_list inflated the persisted cache from 609 to 710
   * total nodes even though the rendered tree was byte-for-byte identical
   * to cold. Root cause: on rebuild of a retained-but-structurally-changed
   * atomic container, the pre-flight drift retrieve populates
   * `liveTopLevelIds` and the warm diff is correct, but the cache snapshot
   * written at the end of the sync double-counted the rebuilt subtree's
   * descendants. The invariant here is: cache size on warm sync with
   * unchanged input = cache size after cold.
   */
  const totalCacheNodes = (tree: CacheTree): number => flattenCache(tree).length

  it('warm sync with column_list → cache size is stable (no growth)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <>
        <Paragraph>before</Paragraph>
        <ColumnList blockKey="cl-1">
          <Column blockKey="col-a">
            <Paragraph>a1</Paragraph>
            <Paragraph>a2</Paragraph>
          </Column>
          <Column blockKey="col-b">
            <Paragraph>b1</Paragraph>
            <Paragraph>b2</Paragraph>
          </Column>
        </ColumnList>
        <Paragraph>after</Paragraph>
      </>
    )
    await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    const coldSnapshot = await Effect.runPromise(cache.load)
    const coldTotal = totalCacheNodes(coldSnapshot!)
    const coldTop = coldSnapshot!.children.length

    // Three warm resyncs with identical input must each be a true no-op
    // w.r.t. cache shape. Repeating catches growth that compounds per run.
    for (let i = 0; i < 3; i++) {
      const res = await runWith(
        fake,
        sync(tree, { pageId: ROOT, cache }).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        ),
      )
      expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
      const warm = await Effect.runPromise(cache.load)
      expect(warm!.children.length).toBe(coldTop)
      expect(totalCacheNodes(warm!)).toBe(coldTotal)
    }
  })

  it('warm sync with column_list at tail (unkeyed) → zero growth (dogfood v8 repro)', async () => {
    // Reproduces the pixeltrail dogfood v8 shape: many top-level atomic
    // children followed by a tail column_list. The tail column_list lands at
    // a positional key; if any subtree-equality path misfires, it triggers
    // a full rebuild whose cache writeback double-counts the descendants.
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const leading: ReactNode[] = []
    for (let i = 0; i < 50; i++) {
      leading.push(<Paragraph key={`lead-${i}`}>lead {i}</Paragraph>)
    }
    const tree = (
      <>
        {leading}
        <ColumnList>
          <Column>
            {Array.from({ length: 10 }, (_, i) => (
              <Paragraph key={`a-${i}`}>col-a item {i}</Paragraph>
            ))}
          </Column>
          <Column>
            {Array.from({ length: 10 }, (_, i) => (
              <Paragraph key={`b-${i}`}>col-b item {i}</Paragraph>
            ))}
          </Column>
        </ColumnList>
      </>
    )
    await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    const coldSnap = await Effect.runPromise(cache.load)
    const coldTotal = totalCacheNodes(coldSnap!)
    const coldTop = coldSnap!.children.length

    for (let i = 0; i < 3; i++) {
      const res = await runWith(
        fake,
        sync(tree, { pageId: ROOT, cache }).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        ),
      )
      expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
      const warm = await Effect.runPromise(cache.load)
      expect(warm!.children.length).toBe(coldTop)
      expect(totalCacheNodes(warm!)).toBe(coldTotal)
    }
  })

  it('warm sync: prior cache with extra descendants triggers full-rebuild → no growth', async () => {
    /* Direct repro of the dogfood v8 shape: the prior cache has a column_list
     * entry whose descendants DON'T match the rendered candidate exactly.
     * That should trigger FULL_REBUILD_ON_SUBTREE_CHANGE. Verify the
     * resulting cache is anchored on the rendered tree, not accumulating. */
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // Cold: ColumnList with 2 cols × 2 paragraphs + 50 trailing paragraphs.
    const v1Tree = (
      <>
        <ColumnList>
          <Column>
            <Paragraph>a1</Paragraph>
            <Paragraph>a2</Paragraph>
          </Column>
          <Column>
            <Paragraph>b1</Paragraph>
            <Paragraph>b2</Paragraph>
          </Column>
        </ColumnList>
        {Array.from({ length: 50 }, (_, i) => (
          <Paragraph key={`tail-${i}`}>tail {i}</Paragraph>
        ))}
      </>
    )
    await runWith(
      fake,
      sync(v1Tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    const coldSnap = await Effect.runPromise(cache.load)
    const coldTotal = totalCacheNodes(coldSnap!)
    const coldTop = coldSnap!.children.length

    // Warm 1: change body of a nested paragraph inside the column_list. This
    // SHOULD trigger the retained-subtree full-rebuild path because hashing a
    // child changes its props hash, and subtree structural equality doesn't
    // consider hash — but still: cache shape after should equal a fresh cold
    // render of the v2 tree. Not growth.
    const v2Tree = (
      <>
        <ColumnList>
          <Column>
            <Paragraph>a1 changed</Paragraph>
            <Paragraph>a2</Paragraph>
          </Column>
          <Column>
            <Paragraph>b1</Paragraph>
            <Paragraph>b2</Paragraph>
          </Column>
        </ColumnList>
        {Array.from({ length: 50 }, (_, i) => (
          <Paragraph key={`tail-${i}`}>tail {i}</Paragraph>
        ))}
      </>
    )
    await runWith(
      fake,
      sync(v2Tree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    // Resync v2 multiple times; must be stable in cache shape.
    const v2Snap = await Effect.runPromise(cache.load)
    const v2Total = totalCacheNodes(v2Snap!)
    const v2Top = v2Snap!.children.length
    // cold total for v2 would be same shape as v1 — same node count.
    expect(v2Total).toBe(coldTotal)
    expect(v2Top).toBe(coldTop)

    for (let i = 0; i < 3; i++) {
      await runWith(
        fake,
        sync(v2Tree, { pageId: ROOT, cache }).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        ),
      )
      const s = await Effect.runPromise(cache.load)
      expect(totalCacheNodes(s!)).toBe(v2Total)
      expect(s!.children.length).toBe(v2Top)
    }
  })

  it('cold sync checkpoint snapshots include atomic-container descendants', async () => {
    /* Regression: the last checkpoint written mid-sync (i.e. before the
     * authoritative final save) must already reflect absorbed descendants
     * of atomic containers, otherwise a crash or timeout between the last
     * op and the final save leaves the cache with hollow atomic containers
     * — and the next warm sync rebuilds them, inflating the persisted
     * cache. Pixeltrail dogfood v8 tracked this as cache growth +101 in a
     * single warm sync against a column_list subtree. */
    const fake = createFakeNotion()
    const spy = spyCache()
    const tree = (
      <>
        <Paragraph>intro</Paragraph>
        <ColumnList>
          <Column>
            <Paragraph>a1</Paragraph>
            <Paragraph>a2</Paragraph>
          </Column>
          <Column>
            <Paragraph>b1</Paragraph>
            <Paragraph>b2</Paragraph>
          </Column>
        </ColumnList>
      </>
    )
    await runWith(
      fake,
      sync(tree, { pageId: ROOT, cache: spy.cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    // Every checkpoint that commits the column_list must carry its full
    // subtree (4 paragraphs under 2 columns) — not a hollowed `children:[]`.
    const withColumnList = spy.snapshots.filter((s) =>
      s.children.some((c) => c.type === 'column_list'),
    )
    expect(withColumnList.length).toBeGreaterThan(0)
    for (const snap of withColumnList) {
      const cl = snap.children.find((c) => c.type === 'column_list')!
      // column_list with 2 columns, each with 2 paragraphs = 4 leaves + 2
      // columns + 1 column_list = 7 nodes.
      expect(cl.children).toHaveLength(2)
      for (const col of cl.children) {
        expect(col.type).toBe('column')
        expect(col.children.length).toBe(2)
      }
    }
  })

  it('warm sync on scaled tree (~500 top-level) → zero growth', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const sessions: Session[] = []
    for (let i = 0; i < 500; i++) {
      sessions.push({
        id: `sess-${i}`,
        title: `session ${i}`,
        body: `body ${i}`,
      })
    }
    const bigTree = <DailyPage screenTime="8h" apps={12} sessions={sessions} />
    await runWith(
      fake,
      sync(bigTree, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    const coldSnap = await Effect.runPromise(cache.load)
    const coldTotal = totalCacheNodes(coldSnap!)
    const coldTop = coldSnap!.children.length

    for (let i = 0; i < 2; i++) {
      const res = await runWith(
        fake,
        sync(bigTree, { pageId: ROOT, cache }).pipe(
          Effect.mapError((cause) => new Error(String(cause))),
        ),
      )
      expect(res).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
      const warm = await Effect.runPromise(cache.load)
      expect(warm!.children.length).toBe(coldTop)
      expect(totalCacheNodes(warm!)).toBe(coldTotal)
    }
  })
})
