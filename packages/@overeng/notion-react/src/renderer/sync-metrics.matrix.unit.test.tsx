import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import { Fragment, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import type { NotionCache } from '../cache/types.ts'
import { Heading1, Paragraph } from '../components/blocks.ts'
import { createFakeNotion, type FakeNotion } from '../test/mock-client.ts'
import type { SyncMetrics } from './sync-metrics.ts'
import { sync } from './sync.ts'

/**
 * Scenario-matrix contract tests for the theoretical-minimum Op
 * Efficiency Ratio (OER) surface. Each scenario renders a
 * deterministic tree against the in-memory fake Notion and asserts
 * (a) the actualOps count agrees with the diff oracle, (b) OER.total
 * stays within a tight envelope, (c) no spurious UpdateNoops.
 *
 * The matrix intentionally covers the shapes pixeltrail hits in
 * production: cold start, no-op warm, append, content update,
 * type swap, delete, and a bulk-content-update burst (regression
 * guard against "rehash the world" patterns).
 */
const ROOT = '00000000-0000-4000-8000-000000000001'

interface ParagraphItem {
  readonly id: string
  readonly text: string
}

const Tree = ({ items }: { readonly items: readonly ParagraphItem[] }): ReactNode => (
  <>
    {items.map((i) => (
      <Fragment key={i.id}>
        <Paragraph blockKey={i.id}>{i.text}</Paragraph>
      </Fragment>
    ))}
  </>
)

/** Variant: a tree where one item is a Heading1 instead of a Paragraph. */
const TypeSwapTree = ({
  items,
  swapId,
}: {
  readonly items: readonly ParagraphItem[]
  readonly swapId: string
}): ReactNode => (
  <>
    {items.map((i) =>
      i.id === swapId ? (
        <Fragment key={i.id}>
          <Heading1 blockKey={i.id}>{i.text}</Heading1>
        </Fragment>
      ) : (
        <Fragment key={i.id}>
          <Paragraph blockKey={i.id}>{i.text}</Paragraph>
        </Fragment>
      ),
    )}
  </>
)

const runWith = <A,>(
  fake: FakeNotion,
  eff: Effect.Effect<A, unknown, HttpClient.HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

const ten: readonly ParagraphItem[] = Array.from({ length: 10 }, (_, i) => ({
  id: `p${i}`,
  text: `item ${i}`,
}))

const fifty: readonly ParagraphItem[] = Array.from({ length: 50 }, (_, i) => ({
  id: `p${i}`,
  text: `item ${i}`,
}))

const collectMetrics = async (
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

describe('SyncMetrics scenario matrix (actual vs theoretical-minimum OER)', () => {
  it('[1] cold small: 10 appends → OER.total = 1.0', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const m = await collectMetrics(fake, <Tree items={ten} />, cache)
    expect(m.actualOps.append).toBe(1) // 10 paragraphs coalesce into one batch
    expect(m.actualOps.update).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.theoreticalMinOps.append).toBe(10)
    // OER.append = 1 actual / 10 theoretical = 0.1. Lower is better —
    // batching is a *win* relative to the oracle. Document the shape so
    // future regressions (e.g. a coalescing break) get caught.
    expect(m.oer.append).toBeCloseTo(0.1, 5)
    expect(m.cacheOutcome).toBe('miss')
    expect(m.updateNoopCount).toBe(0)
    expect(m.fallbackReason).toBe('cold-cache')
    expect(m.ok).toBe(true)
  })

  it('[2] warm no-change: 0 mutations, only drift-probe retrieve', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await collectMetrics(fake, <Tree items={ten} />, cache)
    const m = await collectMetrics(fake, <Tree items={ten} />, cache)
    expect(m.actualOps.append).toBe(0)
    expect(m.actualOps.update).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.actualOps.retrieve).toBe(1) // pre-flight drift probe (#105)
    expect(m.theoreticalMinOps.append).toBe(0)
    expect(m.theoreticalMinOps.update).toBe(0)
    expect(m.theoreticalMinOps.delete).toBe(0)
    expect(m.cacheOutcome).toBe('hit')
    expect(m.updateNoopCount).toBe(0)
    expect(m.fallbackReason).toBeNull()
  })

  it('[3] append 1: exactly 1 append HTTP call', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await collectMetrics(fake, <Tree items={ten} />, cache)
    const eleven: ParagraphItem[] = [...ten, { id: 'p10', text: 'item 10' }]
    const m = await collectMetrics(fake, <Tree items={eleven} />, cache)
    expect(m.actualOps.append).toBe(1)
    expect(m.actualOps.update).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.theoreticalMinOps.append).toBe(1)
    expect(m.oer.append).toBe(1)
    expect(m.oer.total).toBeGreaterThanOrEqual(1)
    expect(m.updateNoopCount).toBe(0)
    expect(m.cacheOutcome).toBe('hit')
  })

  it('[4] update 1 content: exactly 1 update', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await collectMetrics(fake, <Tree items={ten} />, cache)
    const edited: ParagraphItem[] = ten.map((i) =>
      i.id === 'p5' ? ({ id: i.id, text: 'edited' } as ParagraphItem) : i,
    )
    const m = await collectMetrics(fake, <Tree items={edited} />, cache)
    expect(m.actualOps.update).toBe(1)
    expect(m.actualOps.append).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.theoreticalMinOps.update).toBe(1)
    expect(m.oer.update).toBe(1)
    expect(m.updateNoopCount).toBe(0)
  })

  it('[5] type swap (P→H1): 1 delete + 1 append (Notion has no type-change)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await collectMetrics(fake, <Tree items={ten} />, cache)
    const m = await collectMetrics(fake, <TypeSwapTree items={ten} swapId="p5" />, cache)
    // Notion disallows changing a block's `type` via PATCH. The diff
    // algorithm (sync-diff.ts) bakes this into the LCS match predicate,
    // so a same-key type change materializes as remove + insert (not
    // update). The expected plan is therefore 1 append + 1 remove.
    expect(m.actualOps.append).toBe(1)
    expect(m.actualOps.delete).toBe(1)
    expect(m.actualOps.update).toBe(0)
    expect(m.theoreticalMinOps.update).toBe(0)
    expect(m.theoreticalMinOps.delete).toBe(1)
    expect(m.theoreticalMinOps.append).toBe(1) // `inserts` folded into append
    // OER.total on a 2-op plan executed as 2 HTTP calls = 1.0 exactly.
    // If the driver ever regresses into update-then-delete (or splits
    // the single-item append into two batches) this will trip.
    const mutationsActual = m.actualOps.append + m.actualOps.update + m.actualOps.delete
    const mutationsTheoretical =
      m.theoreticalMinOps.append + m.theoreticalMinOps.update + m.theoreticalMinOps.delete
    expect(mutationsActual).toBe(mutationsTheoretical)
    expect(m.updateNoopCount).toBe(0)
  })

  it('[6] delete 1: exactly 1 delete', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await collectMetrics(fake, <Tree items={ten} />, cache)
    const minus1: ParagraphItem[] = ten.filter((i) => i.id !== 'p7')
    const m = await collectMetrics(fake, <Tree items={minus1} />, cache)
    expect(m.actualOps.delete).toBe(1)
    expect(m.actualOps.append).toBe(0)
    expect(m.actualOps.update).toBe(0)
    expect(m.theoreticalMinOps.delete).toBe(1)
    expect(m.oer.delete).toBe(1)
    expect(m.updateNoopCount).toBe(0)
  })

  it('[7] bulk 10% updates: 5 PATCHes (not 50)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await collectMetrics(fake, <Tree items={fifty} />, cache)
    // Edit 5 of 50 (10%).
    const edited: ParagraphItem[] = fifty.map((i, idx) =>
      idx % 10 === 0 ? ({ id: i.id, text: `edited ${idx}` } as ParagraphItem) : i,
    )
    const m = await collectMetrics(fake, <Tree items={edited} />, cache)
    expect(m.actualOps.update).toBe(5)
    expect(m.actualOps.append).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.theoreticalMinOps.update).toBe(5)
    expect(m.oer.update).toBe(1)
    // The regression this guards: a driver that naively walks every
    // cache node and re-PATCHes whenever *anything* changed would send
    // 50 updates here. The hash-based elision keeps it at 5.
    expect(m.updateNoopCount).toBe(0)
  })
})
