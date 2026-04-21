import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import { Fragment, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import type { NotionCache } from '../cache/types.ts'
import {
  BulletedListItem,
  Callout,
  Column,
  ColumnList,
  Heading2,
  Paragraph,
  Table,
  TableRow,
  Toggle,
} from '../components/blocks.ts'
import { createFakeNotion, type FakeNotion } from '../test/mock-client.ts'
import type { SyncMetrics } from './sync-metrics.ts'
import { sync } from './sync.ts'

/**
 * Shape-dimension scenarios mirroring a pixeltrail daily-log page:
 *   - 1 summary callout
 *   - 2 activity tables (50 rows each)
 *   - 10 image-gallery column-list sections (2 columns each)
 *   - 30 bullet items
 *   - 20 paragraphs
 *   - 10 toggles
 *   - 5 h2 section headings
 *
 * Every nested container is an "atomic" block (column_list, table) so its
 * children ride inlined in the parent's create body — one append HTTP call
 * per container regardless of nested child count (up to Notion's 100 cap).
 *
 * The tests pin cold-op counts, warm no-op, 1-append, 1-update, and
 * table-row content edits. Table row edits are the interesting one: Notion
 * treats `table_row.cells` as part of the row's payload, so editing a
 * single cell's text is a single PATCH against the row. Historically
 * drivers mis-cascade this into a full table rewrite — we pin the
 * efficient path.
 */
const ROOT = '00000000-0000-4000-8000-000000000010'

const runWith = <A,>(
  fake: FakeNotion,
  eff: Effect.Effect<A, unknown, HttpClient.HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

const collect = async (
  fake: FakeNotion,
  element: ReactNode,
  cache: NotionCache,
): Promise<SyncMetrics> => {
  let captured: SyncMetrics | undefined
  await runWith(
    fake,
    sync(element, {
      pageId: ROOT,
      cache,
      onMetrics: (m) => {
        captured = m
      },
    }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
  )
  if (captured === undefined) throw new Error('onMetrics was never invoked')
  return captured
}

interface TableSpec {
  readonly id: string
  readonly rows: readonly { readonly id: string; readonly cells: readonly string[] }[]
}

interface PageSpec {
  readonly callout: string
  readonly tables: readonly TableSpec[]
  readonly columnSections: readonly {
    readonly id: string
    readonly left: string
    readonly right: string
  }[]
  readonly bullets: readonly { readonly id: string; readonly text: string }[]
  readonly paragraphs: readonly { readonly id: string; readonly text: string }[]
  readonly toggles: readonly { readonly id: string; readonly text: string }[]
  readonly headings: readonly { readonly id: string; readonly text: string }[]
}

const cell = (s: string): ReactNode => <>{s}</>

const RealisticPage = ({
  spec,
  keyedAtomics = false,
}: {
  readonly spec: PageSpec
  /**
   * When true, pass `blockKey` to Table / ColumnList / Column so their
   * identity survives sibling shifts. Contrast case for
   * `[shape-insert-before-*]` scenarios.
   */
  readonly keyedAtomics?: boolean
}): ReactNode => (
  <>
    <Fragment key="callout">
      <Callout blockKey="callout">{spec.callout}</Callout>
    </Fragment>
    {spec.headings.map((h) => (
      <Fragment key={h.id}>
        <Heading2 blockKey={h.id}>{h.text}</Heading2>
      </Fragment>
    ))}
    {spec.tables.map((t) => (
      <Fragment key={t.id}>
        <Table tableWidth={t.rows[0]!.cells.length} {...(keyedAtomics ? { blockKey: t.id } : {})}>
          {t.rows.map((r) => (
            <Fragment key={r.id}>
              <TableRow cells={r.cells.map(cell)} />
            </Fragment>
          ))}
        </Table>
      </Fragment>
    ))}
    {spec.columnSections.map((c) => (
      <Fragment key={c.id}>
        <ColumnList {...(keyedAtomics ? { blockKey: c.id } : {})}>
          <Fragment key={`${c.id}-l`}>
            <Column {...(keyedAtomics ? { blockKey: `${c.id}-l` } : {})}>
              <Paragraph blockKey={`${c.id}-l-p`}>{c.left}</Paragraph>
            </Column>
          </Fragment>
          <Fragment key={`${c.id}-r`}>
            <Column {...(keyedAtomics ? { blockKey: `${c.id}-r` } : {})}>
              <Paragraph blockKey={`${c.id}-r-p`}>{c.right}</Paragraph>
            </Column>
          </Fragment>
        </ColumnList>
      </Fragment>
    ))}
    {spec.bullets.map((b) => (
      <Fragment key={b.id}>
        <BulletedListItem blockKey={b.id}>{b.text}</BulletedListItem>
      </Fragment>
    ))}
    {spec.paragraphs.map((p) => (
      <Fragment key={p.id}>
        <Paragraph blockKey={p.id}>{p.text}</Paragraph>
      </Fragment>
    ))}
    {spec.toggles.map((t) => (
      <Fragment key={t.id}>
        <Toggle blockKey={t.id} title={t.text} />
      </Fragment>
    ))}
  </>
)

const baseSpec = (): PageSpec => ({
  callout: 'Summary for today',
  headings: Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, text: `Section ${i}` })),
  tables: Array.from({ length: 2 }, (_, i) => ({
    id: `t${i}`,
    rows: Array.from({ length: 50 }, (_, r) => ({
      id: `t${i}-r${r}`,
      cells: [`r${r}-a`, `r${r}-b`, `r${r}-c`],
    })),
  })),
  columnSections: Array.from({ length: 10 }, (_, i) => ({
    id: `cs${i}`,
    left: `gallery ${i} left`,
    right: `gallery ${i} right`,
  })),
  bullets: Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, text: `bullet ${i}` })),
  paragraphs: Array.from({ length: 20 }, (_, i) => ({ id: `pp${i}`, text: `paragraph ${i}` })),
  toggles: Array.from({ length: 10 }, (_, i) => ({ id: `tg${i}`, text: `toggle ${i}` })),
})

describe('SyncMetrics — realistic daily-page shape', () => {
  it('[shape-cold] cold: atomic containers inline; flat blocks coalesce', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const m = await collect(fake, <RealisticPage spec={baseSpec()} />, cache)
    // Top-level child count = 1(callout) + 5(h2) + 2(table) + 10(column_list)
    // + 30(bullet) + 20(p) + 10(toggle) = 78 direct children under the page.
    // All fit in a single append batch (≤100). Each atomic container
    // (table, column_list) ships inlined in that batch body with no extra
    // HTTP calls.
    expect(m.actualOps.append).toBe(1)
    expect(m.actualOps.update).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    // Theoretical min = 78 top-level appends + nested absorbed children:
    //   2 tables × 50 rows = 100 rows
    //   10 column_list × (2 columns + 2 paragraphs) = 40
    // diff-plan tally counts every absorbed descendant as an append too.
    const expectedTheoretical = 78 + 100 + 40
    expect(m.theoreticalMinOps.append).toBe(expectedTheoretical)
    // OER: 1 actual / 218 theoretical. The inlined atomic bodies plus
    // 100-batch coalescing are a massive win.
    expect(m.oer.append).toBeCloseTo(1 / expectedTheoretical, 6)
    expect(m.cacheOutcome).toBe('miss')
    expect(m.ok).toBe(true)
  })

  it('[shape-warm-no-change] warm no-change: 0 mutations, drift probe only', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await collect(fake, <RealisticPage spec={baseSpec()} />, cache)
    const m = await collect(fake, <RealisticPage spec={baseSpec()} />, cache)
    expect(m.actualOps.append).toBe(0)
    expect(m.actualOps.update).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.actualOps.retrieve).toBe(1)
    expect(m.cacheOutcome).toBe('hit')
    expect(m.updateNoopCount).toBe(0)
  })

  it('[shape-append-tail-toggle] warm + 1 new toggle at tail → 1 append', async () => {
    // Appending at the tail of the page avoids the positional-key cascade
    // that bites atomic containers (Table / ColumnList / Column) which have
    // no `blockKey` prop in their current component API. Adding a block
    // *after* every atomic container means no retained sibling follows the
    // insertion point, so diff emits a plain `append` (not `insert`) and
    // no atomic container's positional key shifts.
    //
    // Deferred finding: inserting a keyed block *before* unkeyed atomic
    // containers cascades into remove+re-append of every atomic container
    // (N table rows + M column subtrees). See
    // `[shape-insert-before-unkeyed-atomics-cascade]` below.
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await collect(fake, <RealisticPage spec={baseSpec()} />, cache)
    const next: PageSpec = {
      ...baseSpec(),
      toggles: [...baseSpec().toggles, { id: 'tg-new', text: 'appended-tail' }],
    }
    const m = await collect(fake, <RealisticPage spec={next} />, cache)
    expect(m.actualOps.append).toBe(1)
    expect(m.actualOps.update).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.oer.append).toBe(1)
    expect(m.theoreticalMinOps.append).toBe(1)
  })

  it('[shape-insert-before-keyed-atomics] keyed Table/ColumnList/Column survive sibling insert → 1 op', async () => {
    // Contract: when atomic containers carry `blockKey`, inserting a keyed
    // heading ahead of them does NOT cascade. LCS matches every container
    // by identity instead of by `p:N` position, so the only emitted op is
    // the single insert for the new heading.
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await collect(fake, <RealisticPage spec={baseSpec()} keyedAtomics />, cache)
    const next: PageSpec = {
      ...baseSpec(),
      headings: [...baseSpec().headings, { id: 'h-new', text: 'mid-inserted' }],
    }
    const m = await collect(fake, <RealisticPage spec={next} keyedAtomics />, cache)
    expect(m.actualOps.append).toBe(1)
    expect(m.actualOps.update).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.oer.append).toBe(1)
    expect(m.theoreticalMinOps.append).toBe(1)
  })

  it('[shape-insert-before-unkeyed-atomics-cascade] inserting before unkeyed atomic containers cascades (documented)', async () => {
    // Inserting a heading between h4 and the first unkeyed Table/ColumnList
    // shifts every atomic container's positional key (`p:N`). LCS sees
    // those as brand-new sibling insertions and emits:
    //   - 1 insert for h-new
    //   - remove + re-insert for each shifted atomic container (2 tables
    //     + 10 column_lists = 12 containers, each with absorbed
    //     descendants folded into its create body)
    //   - but because `hasRetainedAfter` is true for every post-insertion
    //     sibling that *is* blockKey-keyed (bullets / paragraphs / toggles),
    //     they stay retained in-place.
    //
    // Actual observed: 21 append-kind HTTP calls (appends + inserts). This
    // captures the real-world cost of mixing keyed and unkeyed siblings
    // and is the concrete motivation for adding `blockKey` support to
    // atomic container components.
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await collect(fake, <RealisticPage spec={baseSpec()} />, cache)
    const next: PageSpec = {
      ...baseSpec(),
      headings: [...baseSpec().headings, { id: 'h-new', text: 'mid-inserted' }],
    }
    const m = await collect(fake, <RealisticPage spec={next} />, cache)
    // Document the observed cascade explicitly. If this number *decreases*,
    // great — likely means atomic containers gained `blockKey`. Flip the
    // assertion then.
    expect(m.actualOps.append).toBeGreaterThan(1)
    expect(m.actualOps.delete).toBeGreaterThan(0) // shifted atomics get archived
    expect(m.ok).toBe(true)
  })

  it('[shape-update-paragraph] warm + 1 paragraph text edit → 1 update', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await collect(fake, <RealisticPage spec={baseSpec()} />, cache)
    const next: PageSpec = {
      ...baseSpec(),
      paragraphs: baseSpec().paragraphs.map((p) =>
        p.id === 'pp5' ? { id: p.id, text: 'edited text' } : p,
      ),
    }
    const m = await collect(fake, <RealisticPage spec={next} />, cache)
    expect(m.actualOps.update).toBe(1)
    expect(m.actualOps.append).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.oer.update).toBe(1)
    expect(m.updateNoopCount).toBe(0)
  })

  it('[shape-update-table-row] warm + 1 table-row cell edit → 1 update (row-level PATCH)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await collect(fake, <RealisticPage spec={baseSpec()} />, cache)
    const next: PageSpec = {
      ...baseSpec(),
      tables: baseSpec().tables.map((t) =>
        t.id !== 't0'
          ? t
          : {
              ...t,
              rows: t.rows.map((r) =>
                r.id !== 't0-r10' ? r : { ...r, cells: ['EDITED', r.cells[1]!, r.cells[2]!] },
              ),
            },
      ),
    }
    const m = await collect(fake, <RealisticPage spec={next} />, cache)
    // Finding: editing one cell rewrites one `table_row` — not the whole
    // table. The diff algorithm descends into the row (atomic container
    // rule applies to `table`, not `table_row`) and the row's hash
    // changes, triggering an update on just that row.
    expect(m.actualOps.update).toBe(1)
    expect(m.actualOps.append).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.theoreticalMinOps.update).toBe(1)
    expect(m.oer.update).toBe(1)
  })
})
