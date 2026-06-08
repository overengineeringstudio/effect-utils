/**
 * Determinism inside a handler: journaled time/random, durable steps, and the
 * explicit durable-wait combinators.
 *
 * Restate replays a handler to recover its state, so every source of
 * nondeterminism must be journaled or the replay diverges. This binding makes the
 * common cases correct by construction:
 *
 * - Effect's `Clock` and `Random` are backed by the journaled context, so
 *   idiomatic `Clock.currentTimeMillis` / `Random.next` reads are replay-safe.
 * - A side effect or a raw nondeterministic call goes inside `Restate.run`, whose
 *   result is journaled once and replayed verbatim.
 * - Durable waits are EXPLICIT, named combinators — NOT a remap of `Effect.sleep`.
 *   `Restate.sleep` / `timeout` / `race` / `all` / `any` become Restate-durable
 *   timers/races that survive suspension and restarts.
 *
 * (The `overeng/no-raw-nondeterminism` lint flags a raw `Date.now()` /
 * `Math.random()` in a handler body OUTSIDE `Restate.run` as an advisory backstop.)
 */
import { Clock, Effect, Random, Schema } from 'effect'

import { Restate, type RestateContext, RestateService } from '../src/mod.ts'

export const DemoInput = Schema.Struct({ label: Schema.String })
export const DemoSuccess = Schema.Struct({
  at: Schema.Number,
  roll: Schema.Number,
  token: Schema.String,
})

export const Demo = RestateService.contract('determinism-demo', {
  run: { input: DemoInput, success: DemoSuccess },
})

export const DemoLive = RestateService.implement<typeof Demo>(Demo, {
  run: () =>
    Effect.gen(function* () {
      /* Journaled time: backed by `ctx.date`, so a replay reads the SAME instant. */
      const at = yield* Clock.currentTimeMillis
      /* Journaled randomness: backed by `ctx.rand`, seeded + replay-stable. */
      const roll = yield* Random.nextIntBetween(1, 7)

      /* A durable step: the closure runs once on real execution; its result is
       * journaled and replayed verbatim. Put raw nondeterminism / external I/O
       * HERE. Inside a `run` closure a nested `ctx.*` / `State.*` would be a
       * COMPILE error (the durable capabilities are scrubbed). */
      const token = yield* Restate.run(
        'mint-token',
        Effect.sync(() => crypto.randomUUID()),
      ).pipe(Effect.orDie)

      /* A durable timer (lower bound; survives suspension + restarts). A bare
       * `Effect.sleep` stays non-durable — use it only for in-handler timing. */
      yield* Restate.sleep(10, 'settle').pipe(Effect.orDie)

      return { at, roll, token }
    }),
})

/* ── Durable concurrency: combinators take DESCRIPTORS, issued in source order ── */
/*
 * `Restate.all` / `race` / `any` take durable-op descriptors (not opaque Effects)
 * so the journal order is the source order. Each descriptor is one durable op:
 * `Restate.runDescriptor(name, action)` or `Restate.sleepDescriptor(millis)`.
 * The combinator awaits the single combined promise ONCE; map the RESULT after.
 */
export const raceExample: Effect.Effect<number | undefined, never, RestateContext> = Restate.race([
  Restate.runDescriptor('fetch-a', () => Promise.resolve(1)),
  Restate.runDescriptor('fetch-b', () => Promise.resolve(2)),
]).pipe(Effect.orDie)

/* `Restate.timeout` bounds a single durable-op descriptor by a deadline:
 * `Some(value)` if it resolved first, `undefined` on timeout. */
export const timeoutExample: Effect.Effect<number | undefined, never, RestateContext> =
  Restate.timeout(
    Restate.runDescriptor('slow-op', () => Promise.resolve(42)),
    1_000,
  ).pipe(Effect.orDie)
