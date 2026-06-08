/**
 * Type-level (typecheck-only, never executed) assertions mirroring the validated
 * prototype's `@ts-expect-error` cases against the REAL Phase 1 API:
 *
 * - `call` infers exact input/success/error from a contract (precise, not `any`).
 * - `State.set` in a Service handler is a TYPE error (no `StateWrite` provided).
 * - `Restate.run` SCRUBS durable caps from its inner effect (nested durable op
 *   inside `run` is a compile error).
 * - `Restate.all` rejects an arbitrary `Effect[]` (descriptors only).
 *
 * It is included by `tsconfig`'s `src/**` glob, so `tsc` checks it; it is not a
 * `*.test.ts`, so vitest never runs it.
 */
import { Effect, Schema } from 'effect'

import { call, callTyped } from './Client.ts'
import { Restate, State } from './mod.ts'
import type { RestateError } from './RestateError.ts'
import { RestateService } from './Service.ts'

/* eslint-disable @typescript-eslint/no-unused-vars -- type-level assertions */

type Assert<T extends true> = T
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/* ── contract → call inference ───────────────────────────────────────────── */

const GreetInput = Schema.Struct({ name: Schema.String })
const GreetSuccess = Schema.Struct({ message: Schema.String, id: Schema.String })
class EmptyName extends Schema.TaggedError<EmptyName>('test/EmptyName')('EmptyName', {}) {}

const Greeter = RestateService.contract('greeter', {
  greet: { input: GreetInput, success: GreetSuccess, error: EmptyName },
})

const greetCall = call(Greeter, 'greet', { name: 'Sarah' })
/* The success type is precise (not `any`). */
type _A1 = Assert<
  Equals<Effect.Effect.Success<typeof greetCall>, { readonly message: string; readonly id: string }>
>
/* `callTyped` lifts the contract's tagged error into the recoverable `E` channel
 * (alongside the wrapper `RestateError`). */
const greetTyped = callTyped(Greeter, 'greet', { name: '' })
type _A2 = Assert<Equals<Effect.Effect.Error<typeof greetTyped>, RestateError | EmptyName>>

/* NEGATIVE: wrong input type. */
// @ts-expect-error — `name` must be a string, not a number
const _wrongInput = call(Greeter, 'greet', { name: 123 })

/* NEGATIVE: unknown method. */
// @ts-expect-error — 'shout' is not a method of the greeter contract
const _unknownMethod = call(Greeter, 'shout', { name: 'x' })

/* ── State.set in a Service handler is a type error ───────────────────────── */

const CounterState = { count: Schema.Number }
const CounterStateApi = State.for(CounterState)

/* A Service handler is provided ONLY RestateContext — never StateWrite. So a
 * handler effect that requires StateWrite cannot satisfy `ServiceImpl`'s
 * `AppR | RestateContext` residual. */
const Counter = RestateService.contract('counter', {
  bump: { input: Schema.Void, success: Schema.Void },
})

const _CounterBad = RestateService.implement<typeof Counter>(Counter, {
  // @ts-expect-error — State.set requires StateWrite, not provided to a Service handler
  bump: () => CounterStateApi.set('count', 1),
})

/* POSITIVE: a pure Service handler typechecks. */
const _CounterOk = RestateService.implement<typeof Counter>(Counter, {
  bump: () => Effect.void,
})

/* ── Restate.run scrubs durable caps ──────────────────────────────────────── */

/* POSITIVE: a pure inner effect runs fine. */
const _runOk = Restate.run(
  'gen',
  Effect.sync(() => crypto.randomUUID()),
)

/* NEGATIVE: a nested durable State.get inside `run` — inner R has StateRead. */
// @ts-expect-error — durable capability (StateRead) is not allowed inside Restate.run
const _runNestedState = Restate.run('bad', CounterStateApi.get('count'))

/* NEGATIVE: a nested Restate.sleep inside `run` — inner R has RestateContext. */
// @ts-expect-error — durable capability (RestateContext) is not allowed inside Restate.run
const _runNestedSleep = Restate.run('bad', Restate.sleep(1000))

/* ── descriptor concurrency rejects opaque Effects ───────────────────────── */

/* POSITIVE: descriptor tuple → inferred result tuple. */
const _allOk: Effect.Effect<readonly [string, void], unknown, unknown> = Restate.all([
  Restate.runDescriptor('a', () => 'x'),
  Restate.sleepDescriptor(10),
])

/* NEGATIVE: passing arbitrary Effects (not descriptors) is rejected. */
// @ts-expect-error — Restate.all takes Descriptor[], not Effect[]
const _allRejectsEffects = Restate.all([Effect.succeed(1), Effect.succeed('x')])

/* eslint-enable @typescript-eslint/no-unused-vars */
