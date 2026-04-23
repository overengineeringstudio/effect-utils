import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import { Fragment, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import type { NotionCache } from '../cache/types.ts'
import { Paragraph } from '../components/blocks.ts'
import { createFakeNotion, type FakeNotion } from '../test/mock-client.ts'
import type { SyncMetrics } from './sync-metrics.ts'
import { sync } from './sync.ts'

/**
 * Churn-pattern scenarios: how the driver holds up over many syncs with
 * realistic mutation shapes.
 *
 *   - steady-append: simulate 60 syncs each adding 5 blocks (journaling
 *     cadence); warm syncs with no change in between are no-ops.
 *   - bulk-content-update: 200-block page with 20 edited paragraphs → 20
 *     update PATCHes (hash-elided otherwise).
 *   - reorder-top-5: [A,B,C,D,E,...] → [E,D,C,B,A,...]; Notion has no move,
 *     so this materializes as 5 removes + 5 inserts (documented).
 *   - shuffle: randomly permute a 100-block page; worst-case op count
 *     bounded by 2N.
 */
const ROOT = '00000000-0000-4000-8000-000000000020'

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

const mkItems = (n: number, prefix = 'p', textSuffix = ''): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, text: `item ${i}${textSuffix}` }))

/** Deterministic Fisher–Yates permutation seeded for repeatable shuffles. */
const seededShuffle = <T,>(arr: readonly T[], seed: number): T[] => {
  const out = [...arr]
  let s = seed
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe('SyncMetrics — churn patterns', () => {
  it('[churn-steady-append] 60 syncs × +5 blocks ≈ cumulative theoretical', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // Seed empty page with nothing — then grow 5 at a time.
    let items: Item[] = []
    let cumulativeActualMutations = 0
    let cumulativeTheoretical = 0
    const syncs = 60
    const batch = 5
    for (let s = 0; s < syncs; s++) {
      const next = [
        ...items,
        ...Array.from({ length: batch }, (_, k) => ({
          id: `p${s * batch + k}`,
          text: `item ${s * batch + k}`,
        })),
      ]
      const m = await collect(fake, <Tree items={next} />, cache)
      items = next
      const mut = m.actualOps.append + m.actualOps.update + m.actualOps.delete
      cumulativeActualMutations += mut
      cumulativeTheoretical +=
        m.theoreticalMinOps.append + m.theoreticalMinOps.update + m.theoreticalMinOps.delete
      // Each incremental sync lands in a single append batch (5 blocks ≤ 100).
      // First sync is cold (miss); subsequent are warm hits.
      if (s === 0) {
        expect(m.cacheOutcome).toBe('miss')
      } else {
        expect(m.cacheOutcome).toBe('hit')
      }
      expect(m.actualOps.append).toBe(1)
      expect(m.actualOps.update).toBe(0)
      expect(m.actualOps.delete).toBe(0)
    }
    // Theoretical = 60 × 5 = 300 appends cumulative.
    expect(cumulativeTheoretical).toBe(syncs * batch)
    // Actual mutations = 60 batches (1 append per sync).
    expect(cumulativeActualMutations).toBe(syncs)
    // And a warm no-change pass after all that grows nothing further.
    const m = await collect(fake, <Tree items={items} />, cache)
    expect(m.actualOps.append).toBe(0)
    expect(m.actualOps.update).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.actualOps.retrieve).toBe(1)
  })

  it('[churn-bulk-update] 200-block page, edit 20 → exactly 20 updates', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const base = mkItems(200)
    await collect(fake, <Tree items={base} />, cache)
    const edited = base.map((i, idx) => (idx % 10 === 0 ? { id: i.id, text: `edited ${idx}` } : i))
    const m = await collect(fake, <Tree items={edited} />, cache)
    expect(m.actualOps.update).toBe(20)
    expect(m.actualOps.append).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.theoreticalMinOps.update).toBe(20)
    expect(m.oer.update).toBe(1)
    expect(m.updateNoopCount).toBe(0)
  })

  it('[churn-reorder-top-5] reversing top 5 of 20 → 5 inserts + 5 removes (no move op)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const base = mkItems(20)
    await collect(fake, <Tree items={base} />, cache)
    const reordered: Item[] = [...base.slice(0, 5).toReversed(), ...base.slice(5)]
    const m = await collect(fake, <Tree items={reordered} />, cache)
    // Notion has no move-block op. LCS keeps the longest in-order chain
    // (p0 OR p4 plus tail) and remove+re-inserts the rest. Exact counts:
    // 4 reorders become (remove, insert) pairs; one of the five stays in
    // the LCS as the anchor.
    expect(m.actualOps.delete).toBe(4)
    // Inserts coalesce into HTTP batches with the same parent. 4 inserts
    // at different afterIds may not all chain, so they land in 1–4 batches.
    expect(m.actualOps.append).toBeGreaterThanOrEqual(1)
    expect(m.actualOps.append).toBeLessThanOrEqual(4)
    expect(m.actualOps.update).toBe(0)
    expect(
      m.theoreticalMinOps.append + m.theoreticalMinOps.delete + m.theoreticalMinOps.update,
    ).toBe(8)
    expect(m.ok).toBe(true)
  })

  it('[churn-shuffle] random permutation of 100 blocks ≤ 2N ops', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const base = mkItems(100)
    await collect(fake, <Tree items={base} />, cache)
    const shuffled = seededShuffle(base, 42)
    const m = await collect(fake, <Tree items={shuffled} />, cache)
    const totalMutations = m.actualOps.append + m.actualOps.update + m.actualOps.delete
    // Worst-case bound: 2N (N removes + N inserts). Batching collapses
    // append-side into HTTP calls; removes stay 1-per-op.
    expect(totalMutations).toBeLessThanOrEqual(2 * 100)
    // Theoretical plan equals removes + inserts; also ≤ 2N.
    const theoretical =
      m.theoreticalMinOps.append + m.theoreticalMinOps.update + m.theoreticalMinOps.delete
    expect(theoretical).toBeLessThanOrEqual(2 * 100)
    expect(m.ok).toBe(true)
  })
})
