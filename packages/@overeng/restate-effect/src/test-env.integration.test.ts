/**
 * The swappable `RestateTestEnv` façade (decision 0017, spec §11): ONE test body,
 * authored ONLY against the contract-addressed `RestateTestEnv` surface
 * (`invokeService` / `invokeObject` / `stateOf` / `resolveAwakeable`), run on BOTH
 * backends via `describe.each(['mock', 'real'])`:
 *
 * - `mock` — in-process, no server, in ms: proves handler logic, typed success +
 *   typed error (`catchTag` recovers the SAME tagged value as the real wire),
 *   typed State + per-key isolation, and awakeable resolve/await.
 * - `real` — the native-server harness: the SAME assertions over a full
 *   invoke/serde/single-writer round-trip. Skipped when no `restate-server` binary
 *   is present (the `kind === 'real' && !serverAvailable` gate).
 *
 * This is the proof the two backends are interchangeable at the harness's
 * contract-addressed level: the body NEVER touches `impl.method(...)`, only
 * `RestateTestEnv`.
 */
import { it } from '@effect/vitest'
import { Context, Effect, Layer, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { Awakeable, type AwakeableId, RestateObject, RestateService, State } from './mod.ts'
import { RestateTestEnv, serverAvailable } from './testing.ts'

/* ── demo app: a greeter Service (typed error) + a counter Object (typed State) ── */

class Greeting extends Context.Tag('test-env/Greeting')<Greeting, { readonly prefix: string }>() {
  static readonly Default = Layer.succeed(Greeting, { prefix: 'Hello' })
}

class EmptyName extends Schema.TaggedError<EmptyName>('test-env/EmptyName')('EmptyName', {}) {}

const Greeter = RestateService.contract('test-env-greeter', {
  greet: {
    input: Schema.Struct({ name: Schema.String }),
    success: Schema.Struct({ message: Schema.String }),
    error: EmptyName,
  },
})

const GreeterLive = RestateService.implement<typeof Greeter, Greeting>(Greeter, {
  greet: ({ name }) =>
    Effect.gen(function* () {
      if (name === '') return yield* new EmptyName()
      const prefix = (yield* Greeting).prefix
      return { message: `${prefix} ${name}` }
    }),
})

const CounterState = { count: Schema.Number } as const
const Counter = State.for(CounterState)

const CounterObj = RestateObject.contract('test-env-counter', {
  state: CounterState,
  handlers: {
    add: { input: Schema.Number, success: Schema.Number },
    get: { input: Schema.Void, success: Schema.Number, shared: true },
  },
})

const CounterLive = RestateObject.implement<typeof CounterObj>(CounterObj, {
  add: (amount) =>
    Effect.gen(function* () {
      const current = (yield* Counter.get('count')) ?? 0
      const next = current + amount
      yield* Counter.set('count', next)
      return next
    }),
  get: () => Counter.get('count').pipe(Effect.map((c) => c ?? 0)),
})

const services = [GreeterLive, CounterLive] as const
const appLayer = Greeting.Default

/* ── the SAME body, parametrized over the two backends ── */

const backends = [
  { kind: 'mock' as const, layer: () => RestateTestEnv.mock({ services, appLayer }) },
  { kind: 'real' as const, layer: () => RestateTestEnv.real({ services, appLayer }) },
]

describe.each(backends)('RestateTestEnv ($kind)', ({ kind, layer }) => {
  /* The real backend needs a native server; the mock is always available. */
  const describeBackend = kind === 'real' && !serverAvailable ? describe.skip : describe
  describeBackend(kind, () => {
    it.layer(layer(), { timeout: 90_000 })(`same body on the ${kind} backend`, (it) => {
      it.effect('typed success crosses the contract-addressed surface', () =>
        Effect.gen(function* () {
          const env = yield* RestateTestEnv
          expect(env.kind).toBe(kind)
          const ok = yield* env.invokeService(Greeter, 'greet', { name: 'Sarah' })
          expect(ok.message).toBe('Hello Sarah')
        }),
      )

      it.effect('typed error is catchTag-recoverable IDENTICALLY on both backends', () =>
        Effect.gen(function* () {
          const env = yield* RestateTestEnv
          /* `catchTag('EmptyName', …)` compiles + recovers identically — the env's
           * `invokeService` carries `RestateError | EmptyName` on mock AND real. */
          const recovered = yield* env.invokeService(Greeter, 'greet', { name: '' }).pipe(
            Effect.map(() => 'unexpected' as const),
            Effect.catchTag('EmptyName', () => Effect.succeed('recovered' as const)),
          )
          expect(recovered).toBe('recovered')
        }),
      )

      it.effect('stateOf seeds + asserts typed State; per-key isolation holds', () =>
        Effect.gen(function* () {
          const env = yield* RestateTestEnv
          /* SEED a pre-condition via stateOf (typed against `count`). */
          yield* env.stateOf(CounterObj, `${kind}-a`).set('count', 40)
          const bumped = yield* env.invokeObject(CounterObj, `${kind}-a`, 'add', 2)
          expect(bumped).toBe(42)
          /* ASSERT the post-condition via the shared read AND via stateOf. */
          expect(yield* env.invokeObject(CounterObj, `${kind}-a`, 'get', undefined)).toBe(42)
          expect(yield* env.stateOf(CounterObj, `${kind}-a`).get('count')).toBe(42)

          /* Per-key isolation: a second key is independent. */
          yield* env.invokeObject(CounterObj, `${kind}-b`, 'add', 5)
          expect(yield* env.stateOf(CounterObj, `${kind}-a`).get('count')).toBe(42)
          expect(yield* env.stateOf(CounterObj, `${kind}-b`).get('count')).toBe(5)
        }),
      )
    })
  })
})

/* ── mock-only: awakeable resolve from "outside" completes a suspended handler ── */

const Payload = Schema.Struct({ token: Schema.String })
const WaiterState = { awakeableId: Schema.String } as const
const Waiter = State.for(WaiterState)

const WaiterObj = RestateObject.contract('test-env-waiter', {
  state: WaiterState,
  handlers: {
    start: { input: Schema.Void, success: Payload },
    awakeableId: { input: Schema.Void, success: Schema.String, shared: true },
  },
})

const WaiterLive = RestateObject.implement<typeof WaiterObj>(WaiterObj, {
  start: () =>
    Effect.gen(function* () {
      const { id, promise } = yield* Awakeable.make(Payload)
      yield* Waiter.set('awakeableId', id)
      return yield* promise
    }),
  awakeableId: () => Waiter.get('awakeableId').pipe(Effect.map((id) => id ?? '')),
})

describe('RestateTestEnv (mock) awakeable resolve from outside', () => {
  it.layer(RestateTestEnv.mock({ services: [WaiterLive], appLayer: Layer.empty }))(
    'a resolveAwakeable completes a suspended handler via the env-scoped registry',
    (it) => {
      it.effect('start suspends; resolveAwakeable resumes with the payload', () =>
        Effect.gen(function* () {
          const env = yield* RestateTestEnv
          /* Fork the suspending `start` (it parks on the awakeable promise). */
          const fiber = yield* Effect.fork(env.invokeObject(WaiterObj, 'job-1', 'start', undefined))
          /* Poll the shared query until `start` has registered the awakeable id in
           * State (the forked handler runs up to its suspension first). */
          const id = yield* Effect.gen(function* () {
            for (let attempt = 0; attempt < 50; attempt++) {
              const read = yield* env.invokeObject(WaiterObj, 'job-1', 'awakeableId', undefined)
              if (read !== '') return read
              yield* Effect.yieldNow()
            }
            return ''
          })
          expect(id).not.toBe('')
          /* Resolve it from "outside" — the env-scoped shared registry completes the
           * promise the suspended handler is awaiting. */
          yield* env.resolveAwakeable(
            Payload,
            id as AwakeableId<Schema.Schema.Type<typeof Payload>>,
            { token: 'resumed-ok' },
          )
          const resumed = yield* fiber.await
          expect(resumed._tag).toBe('Success')
        }),
      )
    },
  )
})
