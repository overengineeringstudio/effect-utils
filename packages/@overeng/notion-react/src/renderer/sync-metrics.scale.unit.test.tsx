import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import { Fragment, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import type { NotionCache } from '../cache/types.ts'
import { Paragraph } from '../components/blocks.ts'
import { createFakeNotion, type FakeNotion } from '../test/mock-client.ts'
import { MAX_CHILDREN_PER_APPEND } from './render-to-notion.ts'
import type { SyncMetrics } from './sync-metrics.ts'
import { sync } from './sync.ts'

/**
 * Scale-dimension scenarios. Pixeltrail routinely ships daily pages with
 * hundreds of blocks (activity rows, bookmarks, transcripts). These tests
 * verify the cold/warm envelopes at 100/500/1000/2000 flat paragraphs:
 *   - cold append HTTP call count == ceil(n / MAX_CHILDREN_PER_APPEND)
 *   - warm no-change is zero mutations regardless of n
 *   - wall-time soft bounds: warm runs stay well under 5 s for 2000 blocks
 *
 * Soft-assert: perf bounds are logged via `expect.soft` so a slow CI box
 * emits a warning but doesn't fail the matrix. Hard-assert: op counts.
 */
const ROOT = '00000000-0000-4000-8000-000000000001'

interface Item {
  readonly id: string
  readonly text: string
}

const Tree = ({ items }: { readonly items: readonly Item[] }): ReactNode => (
  <>
    {items.map((i) => (
      <Fragment key={i.id}>
        <Paragraph blockKey={i.id}>{i.text}</Paragraph>
      </Fragment>
    ))}
  </>
)

const mkItems = (n: number): readonly Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: `item ${i}` }))

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

/** Soft perf bound: warn without failing. Hard fail > 10x budget. */
const softPerf = (label: string, actualMs: number, budgetMs: number): void => {
  if (actualMs > budgetMs * 10) {
    throw new Error(`[perf-hard] ${label}: ${actualMs.toFixed(0)}ms > ${budgetMs * 10}ms`)
  }
  if (actualMs > budgetMs) {
    // eslint-disable-next-line no-console
    console.warn(`[perf-soft] ${label}: ${actualMs.toFixed(0)}ms > ${budgetMs}ms budget`)
  }
}

describe('SyncMetrics — scale matrix (flat paragraphs)', () => {
  const sizes = [100, 500, 1000, 2000] as const

  for (const n of sizes) {
    it(`[scale-cold-${n}] cold sync issues ceil(n/${MAX_CHILDREN_PER_APPEND}) append HTTP calls`, async () => {
      const fake = createFakeNotion()
      const cache = InMemoryCache.make()
      const t0 = performance.now()
      const m = await collect(fake, <Tree items={mkItems(n)} />, cache)
      const dt = performance.now() - t0
      const expectedBatches = Math.ceil(n / MAX_CHILDREN_PER_APPEND)
      expect(m.actualOps.append).toBe(expectedBatches)
      expect(m.actualOps.update).toBe(0)
      expect(m.actualOps.delete).toBe(0)
      expect(m.theoreticalMinOps.append).toBe(n)
      // OER.append = batches / n. Batching is always a win; tighter is better.
      expect(m.oer.append).toBeCloseTo(expectedBatches / n, 5)
      expect(m.cacheOutcome).toBe('miss')
      expect(m.fallbackReason).toBe('cold-cache')
      expect(m.updateNoopCount).toBe(0)
      expect(m.ok).toBe(true)
      // Soft perf: cold at n=2000 should land in <5 s on a dev box.
      softPerf(`cold n=${n}`, dt, 5_000)
    })

    it(`[scale-warm-${n}] warm no-change on ${n}-block tree emits 0 mutations`, async () => {
      const fake = createFakeNotion()
      const cache = InMemoryCache.make()
      const items = mkItems(n)
      await collect(fake, <Tree items={items} />, cache)
      const t0 = performance.now()
      const m = await collect(fake, <Tree items={items} />, cache)
      const dt = performance.now() - t0
      expect(m.actualOps.append).toBe(0)
      expect(m.actualOps.update).toBe(0)
      expect(m.actualOps.delete).toBe(0)
      expect(m.actualOps.retrieve).toBe(1) // drift-probe only
      expect(m.theoreticalMinOps.append).toBe(0)
      expect(m.theoreticalMinOps.update).toBe(0)
      expect(m.theoreticalMinOps.delete).toBe(0)
      expect(m.cacheOutcome).toBe('hit')
      expect(m.updateNoopCount).toBe(0)
      // Soft perf: warm at n=2000 should land well under 5 s.
      softPerf(`warm n=${n}`, dt, 5_000)
    })
  }

  it('[scale-append-one-at-2000] warm append 1 to 2000-block tree issues exactly 1 batch', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const base = mkItems(2000)
    await collect(fake, <Tree items={base} />, cache)
    const plus1: Item[] = [...base, { id: 'p2000', text: 'new tail' }]
    const m = await collect(fake, <Tree items={plus1} />, cache)
    expect(m.actualOps.append).toBe(1)
    expect(m.actualOps.update).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.theoreticalMinOps.append).toBe(1)
    expect(m.oer.append).toBe(1)
  })
})
