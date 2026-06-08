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
 * The durable combinators have a CLEAN `E` channel (no `RestateError`, #1): a
 * durable-op infra failure is classified at the boundary as a defect (transient →
 * the SDK retries; terminal → fail), so a handler with no declared domain error
 * keeps `E = never` and never needs a `catchTag('RestateError', die)`. Only the
 * INNER effect's own domain `E` flows through `Restate.run`.
 *
 * (The `overeng/no-raw-nondeterminism` lint flags a raw `Date.now()` /
 * `Math.random()` in a handler body OUTSIDE `Restate.run` as an advisory backstop.)
 */
import { Clock, Effect, Random, Schema } from 'effect'

import { Awakeable, Restate, type RestateContext, RestateService } from '../src/mod.ts'

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
       * COMPILE error (the durable capabilities are scrubbed). The `E` is CLEAN
       * (this closure declares no domain error, so no `catchTag`/`orDie` needed —
       * an infra failure is a defect classified at the boundary). */
      const token = yield* Restate.run(
        'mint-token',
        Effect.sync(() => crypto.randomUUID()),
      )

      /* A durable timer (lower bound; survives suspension + restarts). A bare
       * `Effect.sleep` stays non-durable — use it only for in-handler timing. */
      yield* Restate.sleep(10, 'settle')

      return { at, roll, token }
    }),
})

/* ── Durable concurrency: combinators take DESCRIPTORS, issued in source order ── */
/*
 * `Restate.all` / `race` / `any` take durable-op descriptors (not opaque Effects)
 * so the journal order is the source order. Each descriptor is one durable op:
 * `Restate.runDescriptor(name, action)` or `Restate.sleepDescriptor(millis)`.
 * The combinator awaits the single combined promise ONCE; map the RESULT after.
 * The `E` is CLEAN — no `orDie` needed (#1).
 */
export const raceExample: Effect.Effect<number, never, RestateContext> = Restate.race([
  Restate.runDescriptor('fetch-a', () => Promise.resolve(1)),
  Restate.runDescriptor('fetch-b', () => Promise.resolve(2)),
])

/* `Restate.timeout` bounds a single durable-op descriptor by a deadline:
 * the value if it resolved first, `undefined` on timeout. */
export const timeoutExample: Effect.Effect<number | undefined, never, RestateContext> =
  Restate.timeout(
    Restate.runDescriptor('slow-op', () => Promise.resolve(42)),
    1_000,
  )

/* ── Awakeable in a deterministic race (#2) ────────────────────────────────── */
/*
 * An awakeable's completion joins `Restate.race`/`all`/`any` via its `descriptor`,
 * like any other durable op — issued in journal-source order, awaited once. This
 * replaces the in-process `Effect.raceFirst` workaround (which loses journal-order
 * determinism). Here: race an external completion token against a durable timeout
 * sentinel, so the handler resumes on EITHER the awakeable resolving OR the
 * deadline — deterministically on replay.
 */
export const awakeableRaceExample: Effect.Effect<string, never, RestateContext> = Effect.gen(
  function* () {
    const { descriptor } = yield* Awakeable.make(Schema.String)
    /* Race the awakeable against a durable 30s sentinel: whichever lands first wins
     * (a `sleepDescriptor` resolves to `undefined`, mapped to a timeout marker). */
    const winner = yield* Restate.race([
      descriptor,
      Restate.runDescriptor('deadline', () => Promise.resolve<string>('__timeout__')),
    ])
    return winner
  },
)
