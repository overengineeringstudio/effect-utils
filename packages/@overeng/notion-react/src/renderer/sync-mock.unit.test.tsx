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
  type FakeNotion,
  type FakeRequest,
} from '../test/mock-client.ts'
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
    // Drift rebuild: remove every still-live top-level block (so the page
    // converges on the candidate tree, not just accumulates duplicates) and
    // append the fresh candidate tree. `removes` equals the live top-level
    // block count at drift time — here: original 6 top-level blocks minus
    // the one archived out-of-band = 5.
    expect(res).toMatchObject({ appends: 10, updates: 0, inserts: 0 })
    expect(res.removes).toBeGreaterThan(0)
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
    // must reject with Notion's archived-block error shape.
    const probe = (method: 'PATCH' | 'DELETE'): Promise<unknown> =>
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
          return yield* http.execute(req)
        }),
      )
    await expect(probe('PATCH')).rejects.toThrow(/archived/i)
    await expect(probe('DELETE')).rejects.toThrow(/archived/i)
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
