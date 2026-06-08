/**
 * Server-free unit tests for the FAITHFUL in-memory `RestateContext` (decision
 * 0013, spec §11.5). These prove the in-memory context drives the REAL handler
 * combinators verbatim — no native server, no Docker — for fast logic + State
 * transition tests. The real-server harness (`testing.ts`) is tested separately
 * against an actual `restate-server`.
 */
import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { CounterLive } from '../examples/02-virtual-object.ts'
import { Restate, RestateObject } from './mod.ts'
import { makeTestContext, makeTestContextLayer } from './TestContext.ts'

describe('in-memory TestContext', () => {
  it('unit-tests an Object handler State transition server-free', () =>
    Effect.gen(function* () {
      /* Seed a pre-condition, run the REAL `add` handler against the in-memory
       * context, then assert the State Map transition — no server. */
      const state = new Map<string, unknown>([['count', 40]])
      const next = yield* CounterLive.impl
        .add(3)
        .pipe(Effect.provide(makeTestContextLayer({ state, key: 'cart-1' })))
      expect(next).toBe(43)
      /* The State Map reflects the read-modify-write (the same serde the real
       * handler uses round-trips the value). */
      expect(state.get('count')).toBe(43)

      /* The shared read-only `get` sees the written State (provided with the
       * read-only marker subset). */
      const read = yield* CounterLive.impl
        .get(undefined)
        .pipe(
          Effect.provide(
            makeTestContextLayer({ state, key: 'cart-1', handlerKind: 'objectShared' }),
          ),
        )
      expect(read).toBe(43)
    }).pipe(Effect.runPromise))

  it('an unset State key reads back as undefined (then defaults)', () =>
    Effect.gen(function* () {
      const state = new Map<string, unknown>()
      const next = yield* CounterLive.impl
        .add(5)
        .pipe(Effect.provide(makeTestContextLayer({ state })))
      expect(next).toBe(5) // (undefined ?? 0) + 5
      expect(state.get('count')).toBe(5)
    }).pipe(Effect.runPromise))

  it('Restate.run executes once and is replay-stable through the handler', () =>
    Effect.gen(function* () {
      /* A handler whose `Restate.run` step is observable: it records its result in
       * State. Running it once produces one execution + one journaled value. */
      let executions = 0
      const StepObj = RestateObject.contract('step-probe', {
        state: { last: Schema.Number },
        handlers: { go: { input: Schema.Void, success: Schema.Number } },
      })
      const StepLive = RestateObject.implement<typeof StepObj>(StepObj, {
        go: () =>
          Effect.gen(function* () {
            const value = yield* Restate.run(
              'gen',
              Effect.sync(() => ++executions),
            )
            yield* Effect.succeed(value)
            return value
          }),
      })
      const result = yield* StepLive.impl
        .go(undefined)
        .pipe(Effect.provide(makeTestContextLayer({ handlerKind: 'objectExclusive' })))
      expect(result).toBe(1)
      expect(executions).toBe(1)
    }).pipe(Effect.runPromise))

  it('Restate.run (via ctx.run) memoizes by name across re-runs (journaled-once)', () =>
    Effect.gen(function* () {
      const handle = makeTestContext()
      let executions = 0
      /* A second `ctx.run` of the SAME name returns the journaled value without
       * re-executing — the in-memory analogue of Restate replaying a journaled
       * step. */
      const a = yield* Effect.promise(() => handle.context.run('gen', () => ++executions))
      const b = yield* Effect.promise(() => handle.context.run('gen', () => ++executions))
      expect(a).toBe(1)
      expect(b).toBe(1) // memoized — not re-executed
      expect(executions).toBe(1)
      expect(handle.journal.get('gen')).toBe(1)
    }).pipe(Effect.runPromise))

  it('durable sleep no-op + objectKey resolve in-memory', () =>
    Effect.gen(function* () {
      const KeyObj = RestateObject.contract('key-probe', {
        state: { n: Schema.Number },
        handlers: {
          go: { input: Schema.Void, success: Schema.Struct({ key: Schema.String }) },
        },
      })
      const KeyLive = RestateObject.implement<typeof KeyObj>(KeyObj, {
        go: () =>
          Effect.gen(function* () {
            /* A durable timer resolves immediately in-memory (controllable). */
            yield* Restate.sleep(10_000)
            const key = yield* Restate.key
            return { key }
          }),
      })
      const out = yield* KeyLive.impl
        .go(undefined)
        .pipe(Effect.provide(makeTestContextLayer({ key: 'probe-1' })))
      expect(out.key).toBe('probe-1')
    }).pipe(Effect.runPromise))
})
