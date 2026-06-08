/**
 * A Virtual Object: a keyed construct with typed, durable State and the
 * exclusive-vs-shared handler distinction.
 *
 * - `add` is EXCLUSIVE (the default): it gets `StateWrite + StateRead + ObjectKey`
 *   and Restate serializes exclusive handlers per key.
 * - `get` is `shared: true` (read-only): it gets `StateRead + ObjectKey` only, so
 *   a `Counter.set(...)` inside it does NOT type-check (illegal-is-unrepresentable).
 *
 * Verified end-to-end by `src/examples.integration.test.ts`.
 */
import { Effect, Schema } from 'effect'

import { RestateObject, State } from '../src/mod.ts'

/* ── The typed State block: the single source of truth for State keys/values ── */

export const CounterState = { count: Schema.Number } as const

/** The typed, capability-gated State combinators bound to `CounterState`. */
const Counter = State.for(CounterState)

export const CounterObj = RestateObject.contract('counter', {
  state: CounterState,
  handlers: {
    add: { input: Schema.Number, success: Schema.Number }, // exclusive (default)
    get: { input: Schema.Void, success: Schema.Number, shared: true }, // read-only
  },
})

export const CounterLive = RestateObject.implement<typeof CounterObj>(CounterObj, {
  /* Exclusive: a read-modify-write of the typed `count`. `State.get` returns
   * `number | undefined` (undefined = unset), so default it. */
  add: (amount) =>
    Effect.gen(function* () {
      /* `State.get`/`set` have a CLEAN `E` (#1) — no `orDie` needed (a State infra
       * or corrupt-journal failure is a defect at the boundary). */
      const current = (yield* Counter.get('count')) ?? 0
      const next = current + amount
      yield* Counter.set('count', next) // requires StateWrite — only legal here
      return next
    }),
  /* Shared (read-only): a `Counter.set('count', …)` here would be a COMPILE error
   * — `State.set` requires `StateWrite`, which a shared handler is not given. */
  get: () => Counter.get('count').pipe(Effect.map((c) => c ?? 0)),
})
