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

import { call, callTyped, objectCall, workflowSubmit } from './Client.ts'
import { DurablePromise, Restate, RestateObject, RestateWorkflow, State } from './mod.ts'
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

/* ── Phase 2: Object exclusive vs shared capability discharge (DQ3) ────────── */

const CounterObj = RestateObject.contract('counter', {
  state: { count: Schema.Number },
  handlers: {
    add: { input: Schema.Number, success: Schema.Number }, // exclusive (default)
    get: { input: Schema.Void, success: Schema.Number, shared: true }, // read-only
  },
})
const CounterState2 = State.for({ count: Schema.Number })

/* POSITIVE: an exclusive handler may write State; a shared handler may read it.
 * Both kinds live in one heterogeneous `implement` record and discharge per-kind.
 * Wrapper `RestateError`s are infra → `orDie` (the handler declares no domain error,
 * so its `E` is `never`; decision 0003). */
const _CounterObjOk = RestateObject.implement<typeof CounterObj>(CounterObj, {
  add: (n) =>
    Effect.gen(function* () {
      const cur = (yield* CounterState2.get('count')) ?? 0
      yield* CounterState2.set('count', cur + n)
      return cur + n
    }).pipe(Effect.orDie),
  get: () =>
    CounterState2.get('count').pipe(
      Effect.map((c) => c ?? 0),
      Effect.orDie,
    ),
})

/* NEGATIVE: `State.set` in the SHARED `get` handler is a handler-LOCAL compile error
 * (no `StateWrite` provided to a shared handler). This is the key R04/R05 gate. */
const _CounterObjBad = RestateObject.implement<typeof CounterObj>(CounterObj, {
  add: (n) => CounterState2.set('count', n).pipe(Effect.as(n), Effect.orDie),
  // @ts-expect-error — State.set requires StateWrite, not provided to a shared handler
  get: () => CounterState2.set('count', 0).pipe(Effect.as(0), Effect.orDie),
})

/* The object ingress client infers exact input/success from the contract + key. */
const _objCall = objectCall(CounterObj, 'key-1', 'add', 1)
type _O1 = Assert<Equals<Effect.Effect.Success<typeof _objCall>, number>>
// @ts-expect-error — `add` takes a number, not a string
const _objCallBad = objectCall(CounterObj, 'key-1', 'add', 'x')

/* ── Phase 2: Workflow run vs signal/query capability discharge ────────────── */

class Decision extends Schema.Class<Decision>('test/Decision')({ ok: Schema.Boolean }) {}
const Approval = DurablePromise.for(Decision)

const Approve = RestateWorkflow.contract('approve', {
  state: { status: Schema.Literal('pending', 'approved', 'rejected') },
  payload: { input: Schema.String, success: Schema.Boolean },
  signals: { approve: { input: Decision, success: Schema.Void } },
  queries: { status: { input: Schema.Void, success: Schema.String } },
})
const ApproveState = State.for({
  status: Schema.Literal('pending', 'approved', 'rejected'),
})

/* POSITIVE: `run` writes State + awaits a durable promise; the signal resolves it
 * (read-only State + durable promise); the query reads State. Wrapper errors `orDie`. */
const _ApproveOk = RestateWorkflow.implement<typeof Approve>(Approve, {
  run: () =>
    Effect.gen(function* () {
      yield* ApproveState.set('status', 'pending')
      const decision = yield* Approval.get('decision')
      yield* ApproveState.set('status', decision.ok ? 'approved' : 'rejected')
      return decision.ok
    }).pipe(Effect.orDie),
  approve: (d) => Approval.resolve('decision', d).pipe(Effect.orDie),
  status: () =>
    ApproveState.get('status').pipe(
      Effect.map((s) => s ?? 'pending'),
      Effect.orDie,
    ),
})

/* NEGATIVE: `State.set` in a query (shared, read-only) is a compile error. */
const _ApproveBad = RestateWorkflow.implement<typeof Approve>(Approve, {
  run: () => Effect.succeed(true),
  approve: (d) => Approval.resolve('decision', d).pipe(Effect.orDie),
  // @ts-expect-error — State.set requires StateWrite, not provided to a query (shared) handler
  status: () => ApproveState.set('status', 'approved').pipe(Effect.as('approved'), Effect.orDie),
})

/* NEGATIVE: a durable promise in a SERVICE handler is a compile error (no DurablePromise). */
const _ServiceNoPromise = RestateService.implement<typeof Counter>(Counter, {
  // @ts-expect-error — DurablePromise.resolve requires DurablePromise, not provided to a Service handler
  bump: () => Approval.resolve('decision', new Decision({ ok: true })),
})

/* The workflow submit client omits the `run` handler from the direct call surface
 * but submit/attach derive from `run`'s I/O. */
const _wfSubmit = workflowSubmit(Approve, 'wf-1', 'payload')
type _W1 = Assert<Equals<Effect.Effect.Error<typeof _wfSubmit>, RestateError>>

/* eslint-enable @typescript-eslint/no-unused-vars */
