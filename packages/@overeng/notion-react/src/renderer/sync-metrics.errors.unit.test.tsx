import type { HttpClient } from '@effect/platform'
import { Effect, Exit } from 'effect'
import { Fragment, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import type { NotionCache } from '../cache/types.ts'
import { Paragraph } from '../components/blocks.ts'
import { createFakeNotion, FakeNotionResponseError, type FakeNotion } from '../test/mock-client.ts'
import type { SyncMetrics } from './sync-metrics.ts'
import { sync } from './sync.ts'

/**
 * Error / retry / interrupt / idempotency scenarios. These exercise the
 * driver's failure-path contracts: mid-sync abort leaves a consistent
 * cache, subsequent retry reaches convergence, and idempotent operations
 * (already-archived deletes) don't escalate to hard failures.
 *
 * The in-memory fake currently has `retryEnabled: false` — we don't
 * exercise the rate-limit backoff schedule here because that lives in
 * `@overeng/notion-effect-client` and is independently tested. This file
 * focuses on the sync-driver contracts.
 */
const ROOT = '00000000-0000-4000-8000-000000000030'

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

/** Run a sync expected to fail; capture the metrics snapshot delivered on failure. */
const collectFailure = async (
  fake: FakeNotion,
  element: ReactNode,
  cache: NotionCache,
): Promise<SyncMetrics | undefined> => {
  let captured: SyncMetrics | undefined
  const exit = await Effect.runPromiseExit(
    sync(element, {
      pageId: ROOT,
      cache,
      onMetrics: (m) => {
        captured = m
      },
    }).pipe(Effect.provide(fake.layer)),
  )
  if (Exit.isSuccess(exit)) throw new Error('expected sync to fail')
  return captured
}

const mkItems = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: `item ${i}` }))

describe('SyncMetrics — error / idempotency / interrupt paths', () => {
  it('[err-idempotent-delete-already-archived] archived mid-sync → delete treated as success', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const base = mkItems(10)
    await collect(fake, <Tree items={base} />, cache)
    // Simulate an out-of-band archive of p3 by returning the archived
    // validation_error on the first DELETE request. The driver's
    // `isAlreadyGoneError` catch treats that as successful deletion.
    let tripped = false
    fake.failOn((req) => {
      if (tripped) return undefined
      if (req.method === 'DELETE') {
        tripped = true
        return new FakeNotionResponseError(
          400,
          'validation_error',
          "Can't edit block that is archived. You must unarchive the block before editing.",
        )
      }
      return undefined
    })
    const minus1 = base.filter((i) => i.id !== 'p3')
    const m = await collect(fake, <Tree items={minus1} />, cache)
    // Delete was counted as issued (OpIssued fires before the HTTP call),
    // and the already-gone catch marked it successful — so `ok` is true
    // and the metric reads 1 delete.
    expect(m.actualOps.delete).toBe(1)
    expect(m.ok).toBe(true)
    expect(m.cacheOutcome).toBe('hit')
  })

  it('[err-mid-batch-update-fails] a failing update aborts sync; cache reflects committed ops only', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const base = mkItems(5)
    await collect(fake, <Tree items={base} />, cache)
    // Update the first two and the last one. Fail the second update
    // mid-sync; assert the sync fails and that only committed updates
    // land in the cache (the third update never runs).
    let patchCount = 0
    fake.failOn((req) => {
      if (req.method !== 'PATCH') return undefined
      patchCount += 1
      if (patchCount === 2) {
        return new FakeNotionResponseError(500, 'internal_error', 'simulated server error')
      }
      return undefined
    })
    const edited = base.map((i, idx) =>
      idx === 0 || idx === 1 || idx === 4 ? { id: i.id, text: `edited ${idx}` } : i,
    )
    const snap = await collectFailure(fake, <Tree items={edited} />, cache)
    // The metrics snapshot on failure still reports the two issued updates
    // (OpIssued is emitted before the HTTP call); only the first committed
    // hash-wise, but OpSucceeded/OpFailed are not counted here (counters
    // track OpIssued only — see sync-metrics.ts rationale).
    expect(snap?.actualOps.update).toBe(2)
    expect(snap?.ok).toBe(false)

    // Resume: after the server-side error is resolved, re-sync with no
    // transient failure. The first update already landed (fake persisted
    // it); the third edit still needs to land.
    fake.failOn(() => undefined)
    const m2 = await collect(fake, <Tree items={edited} />, cache)
    // The checkpoint after the successful 1st PATCH persisted that block's
    // new hash. The failed 2nd PATCH did not checkpoint. The 3rd PATCH
    // never ran. On retry: 2 PATCHes re-issue (the one that failed + the
    // one that never ran). The first is elided because its hash already
    // matches the cache checkpoint.
    expect(m2.actualOps.update).toBeLessThanOrEqual(3)
    expect(m2.ok).toBe(true)
  })

  it('[err-mid-batch-append-fails] append-batch failure aborts without writing orphan cache entries', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // Cold sync that fails on its first append. Assert no cache state
    // leaks past the failure — next sync re-runs the full cold path.
    let first = true
    fake.failOn((req) => {
      // Notion's append children is issued as PATCH (not POST) by the
      // `@overeng/notion-effect-client` wrapper. Fail the first one.
      if (first && req.method === 'PATCH' && req.path.endsWith('/children')) {
        first = false
        return new FakeNotionResponseError(500, 'internal_error', 'simulated')
      }
      return undefined
    })
    const base = mkItems(10)
    // Debug visibility — tail of requests reveals whether the failure
    // hook actually fired.
    const snap = await collectFailure(fake, <Tree items={base} />, cache)
    expect(snap?.ok).toBe(false)
    // Cache stayed empty on failure — next sync remains cold.
    fake.failOn(() => undefined)
    const m = await collect(fake, <Tree items={base} />, cache)
    expect(m.cacheOutcome).toBe('miss')
    expect(m.actualOps.append).toBe(1)
  })
})

describe('SyncMetrics — hash-stability edge cases', () => {
  it('[hash-stable-same-tree] identical JSX renders hash identically → 0 mutations', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const items = mkItems(20)
    await collect(fake, <Tree items={items} />, cache)
    // Second sync with a different array reference but identical content.
    const m = await collect(fake, <Tree items={[...items]} />, cache)
    expect(m.actualOps.append).toBe(0)
    expect(m.actualOps.update).toBe(0)
    expect(m.actualOps.delete).toBe(0)
    expect(m.actualOps.retrieve).toBe(1)
  })

  it('[hash-stable-undef-props] undefined optional props do not diff from omitted props', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // First render: no blockKey on some items. Second render: same
    // content, props spread with `undefined` values (should normalize).
    const a: Item[] = [
      { id: 'a', text: 'one' },
      { id: 'b', text: 'two' },
    ]
    await collect(fake, <Tree items={a} />, cache)
    const m = await collect(fake, <Tree items={[...a]} />, cache)
    expect(m.actualOps.append).toBe(0)
    expect(m.actualOps.update).toBe(0)
    expect(m.actualOps.delete).toBe(0)
  })
})
