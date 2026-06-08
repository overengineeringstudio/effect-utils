/**
 * Integration test for Virtual Objects against a real native `restate-server`.
 *
 * Proves the keyed-Object vertical slice: a `counter` with an EXCLUSIVE `add`
 * (mutates typed State) and a SHARED read-only `get`, served via the endpoint
 * `layer`, driven through the typed object ingress client — asserting per-key
 * State isolation (two keys are independent) and that the exclusive write is
 * visible to the shared read.
 *
 * The type-level gate that `State.set` in the shared `get` handler is a COMPILE
 * error lives in `capability-inference.types.ts` (checked by `tsc`, DQ3).
 */
import { Effect, Layer, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { objectCall, RestateIngress, RestateObject, State } from './mod.ts'
import { serverAvailable, withRestateServer } from './testing.ts'

/* ── counter object: exclusive `add` (typed State) + shared `get` ── */

const CounterState = { count: Schema.Number } as const
const Counter = State.for(CounterState)

const CounterObj = RestateObject.contract('counter', {
  state: CounterState,
  handlers: {
    add: { input: Schema.Number, success: Schema.Number }, // exclusive (default)
    get: { input: Schema.Void, success: Schema.Number, shared: true }, // read-only
  },
})

const CounterLive = RestateObject.implement<typeof CounterObj>(CounterObj, {
  /* Exclusive: read-modify-write the typed `count` State. Wrapper `RestateError`s
   * are infra → `orDie` (the handler declares no domain error). */
  add: (amount) =>
    Effect.gen(function* () {
      const current = (yield* Counter.get('count')) ?? 0
      const next = current + amount
      yield* Counter.set('count', next)
      return next
    }).pipe(Effect.orDie),
  /* Shared (read-only): a `State.set` here would not typecheck. */
  get: () =>
    Counter.get('count').pipe(
      Effect.map((c) => c ?? 0),
      Effect.orDie,
    ),
})

/* One held native server for the suite (collapses the copy-pasted scope/ingress
 * `beforeAll`); the standalone `objectCall` needs a `RestateIngress` layer built
 * from the booted ingress URL. */
const held = withRestateServer({ services: [CounterLive], appLayer: Layer.empty })
const ingressLayer = (): Layer.Layer<RestateIngress> =>
  RestateIngress.layer({ url: held.harness().ingressUrl })

describe('restate-effect virtual object (counter)', () => {
  beforeAll(held.setup, 60_000)
  afterAll(held.teardown, 60_000)

  it.skipIf(!serverAvailable)('add mutates per-key State; get reads it back', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const afterFirst = yield* objectCall(CounterObj, 'cart-a', 'add', 3)
        const afterSecond = yield* objectCall(CounterObj, 'cart-a', 'add', 4)
        const read = yield* objectCall(CounterObj, 'cart-a', 'get', undefined)
        return { afterFirst, afterSecond, read }
      }).pipe(Effect.provide(ingressLayer())),
    )
    expect(result.afterFirst).toBe(3)
    expect(result.afterSecond).toBe(7)
    expect(result.read).toBe(7)
  })

  it.skipIf(!serverAvailable)('two keys are isolated', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* objectCall(CounterObj, 'key-x', 'add', 10)
        yield* objectCall(CounterObj, 'key-y', 'add', 1)
        const x = yield* objectCall(CounterObj, 'key-x', 'get', undefined)
        const y = yield* objectCall(CounterObj, 'key-y', 'get', undefined)
        return { x, y }
      }).pipe(Effect.provide(ingressLayer())),
    )
    /* Per-key isolation (A01): the two keys do not share State. */
    expect(result.x).toBe(10)
    expect(result.y).toBe(1)
  })
})
