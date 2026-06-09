/**
 * Integration gap (HIGH): deterministic durable concurrency `Restate.all` / `race`
 * over descriptors against a real native server (decision 0005). The combinators
 * issue every descriptor SYNCHRONOUSLY in SOURCE order to fix the journal order —
 * NOT `Effect.all` over opaque thunks (whose scheduling would decide order). Only
 * the real server can falsify this: it journals each durable op and replays it, so
 * the result tuple MUST follow source order even when a later descriptor resolves
 * sooner.
 *
 * - `Restate.all([A, B])` → the result tuple is `[A, B]` (source order), even though
 *   `B`'s `ctx.run` resolves before `A`'s.
 * - `Restate.race([A, B])` → the first to RESOLVE wins (a real race, not source order).
 */
import { it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { Restate, RestateService } from '../mod.ts'
import { RestateTestHarness, serverAvailable } from '../testing/testing.ts'

/* A handler that issues two durable `run` descriptors via `Restate.all`. `B`
 * resolves SOONER than `A` (a longer artificial delay on `A`), so a source-order
 * tuple (`['A', 'B']`) proves the journal order is the source order, not the
 * resolution order. */
const Concurrent = RestateService.contract('concurrency-demo', {
  all: { input: Schema.Void, success: Schema.Tuple(Schema.String, Schema.String) },
  race: { input: Schema.Void, success: Schema.String },
})

const slowResolve = (value: string, delayMillis: number): Promise<string> =>
  new Promise((resolve) => setTimeout(() => resolve(value), delayMillis))

const ConcurrentLive = RestateService.implement<typeof Concurrent>(Concurrent, {
  /* `A` is issued FIRST but resolves LAST (40ms vs 5ms). The tuple must still be
   * `['A', 'B']` — source order, fixed by the synchronous in-order issue. */
  all: () =>
    Restate.all([
      Restate.runDescriptor('op-a', () => slowResolve('A', 40)),
      Restate.runDescriptor('op-b', () => slowResolve('B', 5)),
    ]),
  /* The faster descriptor wins the race regardless of source position. */
  race: () =>
    Restate.race([
      Restate.runDescriptor('slow', () => slowResolve('slow', 50)),
      Restate.runDescriptor('fast', () => slowResolve('fast', 5)),
    ]),
})

const HarnessLayer = RestateTestHarness.layer({
  services: [ConcurrentLive],
  appLayer: Layer.empty,
  disableRetries: true,
})

describe.skipIf(!serverAvailable)('deterministic durable concurrency (real server)', () => {
  it.layer(HarnessLayer, { timeout: 90_000 })('all / race', (it) => {
    it.effect('Restate.all preserves SOURCE order despite resolution order', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const tuple = yield* harness.ingress.call(Concurrent, 'all', undefined)
        /* Source order, NOT resolution order — `B` resolved first but is second. */
        expect(tuple).toEqual(['A', 'B'])
      }),
    )

    it.effect('Restate.race resolves to the first descriptor to COMPLETE', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const winner = yield* harness.ingress.call(Concurrent, 'race', undefined)
        expect(winner).toBe('fast')
      }),
    )
  })
})
