import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import { Fragment, type ReactNode } from 'react'
import { afterAll, describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../../cache/in-memory-cache.ts'
import type { NotionCache } from '../../cache/types.ts'
import { BulletedListItem, Heading2, Paragraph, Toggle } from '../../components/blocks.ts'
import type { SyncMetrics } from '../../renderer/sync-metrics.ts'
import { sync } from '../../renderer/sync.ts'
import { createFakeNotion, type FakeNotion } from '../mock-client.ts'

/**
 * CI-enforced regression guards for sync OER (Op Efficiency Ratio) and
 * wall-time across a canonical scenario set. Uses the in-memory fake Notion
 * so the suite runs offline and deterministically in every CI lane.
 *
 * OER bounds are hard asserts — any regression fails CI. Wall-time is
 * soft-asserted (warn-only unless >2x the budget) to absorb CI jitter
 * without masking real regressions.
 *
 * Each run writes `tmp/sync-perf-regression-baseline.json` for future
 * dashboard ingestion; file is gitignored.
 */

const ROOT = '00000000-0000-4000-8000-000000000001'

interface Scenario {
  readonly name: string
  readonly oerLower: number
  readonly oerUpper: number
  /** Soft target in ms. Warn above, hard-fail above 2x. */
  readonly wallBudgetMs: number
}

interface Item {
  readonly id: string
  readonly text: string
}

const mkItems = (n: number, prefix = 'p'): readonly Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, text: `item ${i}` }))

const FlatTree = ({ items }: { readonly items: readonly Item[] }): ReactNode => (
  <>
    {items.map((i) => (
      <Fragment key={i.id}>
        <Paragraph blockKey={i.id}>{i.text}</Paragraph>
      </Fragment>
    ))}
  </>
)

/**
 * Shape inspired by a pixeltrail daily page: a mix of headings, bullets,
 * paragraphs, and one toggle with nested paragraphs. ~200 blocks total.
 */
const RealisticDaily = (): ReactNode => {
  const sections = 4
  const bulletsPerSection = 10
  const paragraphsPerSection = 30
  const parts: ReactNode[] = []
  for (let s = 0; s < sections; s++) {
    parts.push(<Heading2 key={`h${s}`} blockKey={`h${s}`}>{`Section ${s}`}</Heading2>)
    for (let b = 0; b < bulletsPerSection; b++) {
      parts.push(
        <BulletedListItem key={`b${s}-${b}`} blockKey={`b${s}-${b}`}>
          {`Bullet ${s}.${b}`}
        </BulletedListItem>,
      )
    }
    for (let p = 0; p < paragraphsPerSection; p++) {
      parts.push(
        <Paragraph key={`p${s}-${p}`} blockKey={`p${s}-${p}`}>
          {`Para ${s}.${p}`}
        </Paragraph>,
      )
    }
    parts.push(
      <Toggle key={`t${s}`} blockKey={`t${s}`} title={`Details ${s}`}>
        <Paragraph blockKey={`t${s}-c0`}>child 0</Paragraph>
        <Paragraph blockKey={`t${s}-c1`}>child 1</Paragraph>
        <Paragraph blockKey={`t${s}-c2`}>child 2</Paragraph>
      </Toggle>,
    )
  }
  return <>{parts}</>
}

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

interface Sample {
  readonly scenario: string
  readonly oer_total: number
  readonly wall_ms: number
  readonly passed: boolean
}

const samples: Sample[] = []

const runOnce = async (
  build: () => Promise<{ fake: FakeNotion; cache: NotionCache; element: ReactNode }>,
): Promise<{ metrics: SyncMetrics; wallMs: number }> => {
  const { fake, cache, element } = await build()
  const t0 = performance.now()
  const metrics = await collect(fake, element, cache)
  const wallMs = performance.now() - t0
  return { metrics, wallMs }
}

/** Median wall-time across N runs to dampen jitter; metrics from last run. */
const medianRun = async (
  n: number,
  build: () => Promise<{ fake: FakeNotion; cache: NotionCache; element: ReactNode }>,
): Promise<{ metrics: SyncMetrics; wallMs: number }> => {
  const wallMsArr: number[] = []
  let last!: SyncMetrics
  for (let i = 0; i < n; i++) {
    const r = await runOnce(build)
    wallMsArr.push(r.wallMs)
    last = r.metrics
  }
  wallMsArr.sort((a, b) => a - b)
  const mid = Math.floor(wallMsArr.length / 2)
  return { metrics: last, wallMs: wallMsArr[mid]! }
}

const checkGuards = (scenario: Scenario, metrics: SyncMetrics, wallMs: number): void => {
  expect(metrics.ok).toBe(true)
  // Hard: OER must be within range.
  expect(metrics.oer.total).toBeGreaterThanOrEqual(scenario.oerLower)
  expect(metrics.oer.total).toBeLessThanOrEqual(scenario.oerUpper)
  // Hard: wall time must be below 2x the soft budget. Soft: warn above budget.
  const hardCeil = scenario.wallBudgetMs * 2
  if (wallMs > hardCeil) {
    throw new Error(
      `[perf-hard] ${scenario.name}: ${wallMs.toFixed(0)}ms > ${hardCeil}ms (2x of ${scenario.wallBudgetMs}ms budget)`,
    )
  }
  if (wallMs > scenario.wallBudgetMs) {
    // eslint-disable-next-line no-console
    console.warn(
      `[perf-soft] ${scenario.name}: ${wallMs.toFixed(0)}ms > ${scenario.wallBudgetMs}ms budget`,
    )
  }
  samples.push({
    scenario: scenario.name,
    oer_total: metrics.oer.total,
    wall_ms: wallMs,
    passed: true,
  })
}

describe('sync-perf regression guards (OER + wall time)', () => {
  afterAll(() => {
    // Emit JSON artifact for dashboards/tracking. Best-effort.
    try {
      const gitSha = process.env['GITHUB_SHA'] ?? process.env['GIT_COMMIT'] ?? 'unknown'
      const payload = {
        timestamp: new Date().toISOString(),
        commit: gitSha,
        scenarios: samples,
      }
      const outPath = join(process.cwd(), 'tmp', 'sync-perf-regression-baseline.json')
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8')
      // Pretty-print a compact table for eyeballing.
      // eslint-disable-next-line no-console
      console.log(
        '\n[sync-perf-regression baseline]\n' +
          samples
            .map(
              (s) =>
                `  ${s.scenario.padEnd(36)} OER=${s.oer_total.toFixed(4).padStart(8)}  wall=${s.wall_ms.toFixed(0).padStart(6)}ms`,
            )
            .join('\n'),
      )
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[sync-perf-regression] failed to write artifact', err)
    }
  })

  it('cold 100 paragraphs', async () => {
    const scenario: Scenario = {
      name: 'cold-100-paragraphs',
      oerLower: 0.01,
      oerUpper: 1.0,
      wallBudgetMs: 1_000,
    }
    const items = mkItems(100)
    const { metrics, wallMs } = await medianRun(3, async () => ({
      fake: createFakeNotion(),
      cache: InMemoryCache.make(),
      element: <FlatTree items={items} />,
    }))
    checkGuards(scenario, metrics, wallMs)
  })

  it('cold 500 paragraphs', async () => {
    const scenario: Scenario = {
      name: 'cold-500-paragraphs',
      oerLower: 0.01,
      oerUpper: 1.0,
      wallBudgetMs: 5_000,
    }
    const items = mkItems(500)
    const { metrics, wallMs } = await medianRun(3, async () => ({
      fake: createFakeNotion(),
      cache: InMemoryCache.make(),
      element: <FlatTree items={items} />,
    }))
    checkGuards(scenario, metrics, wallMs)
  })

  it('warm no-change 500', async () => {
    const scenario: Scenario = {
      name: 'warm-nochange-500',
      // No theoretical ops → safeRatio(0, 0) = 1.0, plus drift-probe retrieve.
      // total = (0+0+0+1) / (0+0+0+0) → guarded as 0 in safeRatio when actual>0.
      // Empirically: mutations 0, retrieves 1, so total = 0 (actualTotal>0, denom 0).
      // Accept broad range since retrieve counts against 0 denominator.
      oerLower: 0,
      oerUpper: 1.5,
      wallBudgetMs: 1_000,
    }
    const items = mkItems(500)
    // Seed a fresh (fake, cache) pair per iteration so the drift probe sees
    // matching server state. Measured run is a warm re-sync against the
    // same pair.
    const { metrics, wallMs } = await medianRun(3, async () => {
      const cache = InMemoryCache.make()
      const fake = createFakeNotion()
      await collect(fake, <FlatTree items={items} />, cache)
      return { fake, cache, element: <FlatTree items={items} /> }
    })
    expect(metrics.actualOps.append).toBe(0)
    expect(metrics.actualOps.update).toBe(0)
    expect(metrics.actualOps.delete).toBe(0)
    expect(metrics.cacheOutcome).toBe('hit')
    checkGuards(scenario, metrics, wallMs)
  })

  it('append 1 block on 500-block page', async () => {
    const scenario: Scenario = {
      name: 'append-1-on-500',
      // Single-op scenarios: drift-probe retrieve counts in the numerator
      // but not the denominator (see SyncMetrics docstring), so a minimum
      // 1-op mutation scores OER.total = 2.0 (1 mutation + 1 retrieve).
      oerLower: 0.5,
      oerUpper: 2.5,
      wallBudgetMs: 1_000,
    }
    const base = mkItems(500)
    const plus1 = [...base, { id: 'p500', text: 'new tail' }]
    // Re-seed (fake+cache) per run so each iteration observes the 1-op mutation.
    const { metrics, wallMs } = await medianRun(3, async () => {
      const cache = InMemoryCache.make()
      const fake = createFakeNotion()
      await collect(fake, <FlatTree items={base} />, cache)
      return { fake, cache, element: <FlatTree items={plus1} /> }
    })
    expect(metrics.actualOps.append).toBe(1)
    expect(metrics.theoreticalMinOps.append).toBe(1)
    checkGuards(scenario, metrics, wallMs)
  })

  it('update 1 block on 500-block page', async () => {
    const scenario: Scenario = {
      name: 'update-1-on-500',
      // Single-op scenarios: drift-probe retrieve counts in the numerator
      // but not the denominator (see SyncMetrics docstring), so a minimum
      // 1-op mutation scores OER.total = 2.0 (1 mutation + 1 retrieve).
      oerLower: 0.5,
      oerUpper: 2.5,
      wallBudgetMs: 1_000,
    }
    const base = mkItems(500)
    const mutated = base.map((item, i) => (i === 250 ? { ...item, text: 'mutated' } : item))
    const { metrics, wallMs } = await medianRun(3, async () => {
      const cache = InMemoryCache.make()
      const fake = createFakeNotion()
      await collect(fake, <FlatTree items={base} />, cache)
      return { fake, cache, element: <FlatTree items={mutated} /> }
    })
    expect(metrics.actualOps.update).toBe(1)
    expect(metrics.theoreticalMinOps.update).toBe(1)
    checkGuards(scenario, metrics, wallMs)
  })

  it('delete 1 block on 500-block page', async () => {
    const scenario: Scenario = {
      name: 'delete-1-on-500',
      // Single-op scenarios: drift-probe retrieve counts in the numerator
      // but not the denominator (see SyncMetrics docstring), so a minimum
      // 1-op mutation scores OER.total = 2.0 (1 mutation + 1 retrieve).
      oerLower: 0.5,
      oerUpper: 2.5,
      wallBudgetMs: 1_000,
    }
    const base = mkItems(500)
    const minus1 = base.slice(0, 250).concat(base.slice(251))
    const { metrics, wallMs } = await medianRun(3, async () => {
      const cache = InMemoryCache.make()
      const fake = createFakeNotion()
      await collect(fake, <FlatTree items={base} />, cache)
      return { fake, cache, element: <FlatTree items={minus1} /> }
    })
    expect(metrics.actualOps.delete).toBe(1)
    expect(metrics.theoreticalMinOps.delete).toBe(1)
    checkGuards(scenario, metrics, wallMs)
  })

  it('bulk 10% update (50 of 500)', async () => {
    const scenario: Scenario = {
      name: 'bulk-10pct-update-500',
      oerLower: 0.5,
      oerUpper: 1.5,
      wallBudgetMs: 2_000,
    }
    const base = mkItems(500)
    const mutated = base.map((item, i) => (i % 10 === 0 ? { ...item, text: `mutated ${i}` } : item))
    const { metrics, wallMs } = await medianRun(3, async () => {
      const cache = InMemoryCache.make()
      const fake = createFakeNotion()
      await collect(fake, <FlatTree items={base} />, cache)
      return { fake, cache, element: <FlatTree items={mutated} /> }
    })
    expect(metrics.actualOps.update).toBe(50)
    expect(metrics.theoreticalMinOps.update).toBe(50)
    checkGuards(scenario, metrics, wallMs)
  })

  it('realistic daily page (cold)', async () => {
    const scenario: Scenario = {
      name: 'realistic-daily-cold',
      // Toggle container forces nested append chunking; allow some headroom.
      oerLower: 0.01,
      oerUpper: 1.2,
      wallBudgetMs: 2_000,
    }
    const { metrics, wallMs } = await medianRun(3, async () => ({
      fake: createFakeNotion(),
      cache: InMemoryCache.make(),
      element: <RealisticDaily />,
    }))
    checkGuards(scenario, metrics, wallMs)
  })

  it('realistic daily page (warm no-change)', async () => {
    const scenario: Scenario = {
      name: 'realistic-daily-warm',
      oerLower: 0,
      oerUpper: 1.5,
      wallBudgetMs: 1_000,
    }
    const { metrics, wallMs } = await medianRun(3, async () => {
      const cache = InMemoryCache.make()
      const fake = createFakeNotion()
      await collect(fake, <RealisticDaily />, cache)
      return { fake, cache, element: <RealisticDaily /> }
    })
    expect(metrics.actualOps.append).toBe(0)
    expect(metrics.actualOps.update).toBe(0)
    expect(metrics.actualOps.delete).toBe(0)
    expect(metrics.cacheOutcome).toBe('hit')
    checkGuards(scenario, metrics, wallMs)
  })
})
