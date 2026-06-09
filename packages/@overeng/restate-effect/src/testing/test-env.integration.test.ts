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

import { Awakeable, type AwakeableId, RestateObject, RestateService, State } from '../mod.ts'
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

/* ── a cursor Object with a NULLABLE `highWatermark` (optional State field) ── */

/* `highWatermark` is `Schema.optional` — an ABSENT key reads back as `undefined`,
 * and `set(key, undefined)`/`clear(key)` REMOVES it. This is the `notion-datasource-sync`
 * cursor shape that was previously unexpressible (optional/nullable State, #1). */
const CursorState = {
  highWatermark: Schema.optional(Schema.Number),
  name: Schema.String,
} as const
const Cursor = State.for(CursorState)

/* `peek` returns the watermark inside a STRUCT with an optional property (a valid
 * JSON schema), since a top-level `Schema.UndefinedOr` handler return breaks
 * `JSONSchema.make` at endpoint registration — State, not handler I/O, is the
 * nullable surface (#1). */
const PeekOutput = Schema.Struct({ highWatermark: Schema.optional(Schema.Number) })

const CursorObj = RestateObject.contract('test-env-cursor', {
  state: CursorState,
  handlers: {
    /** Set the nullable watermark to a present value. */
    advance: { input: Schema.Number, success: Schema.Void },
    /** Clear the watermark by writing `undefined` (≡ remove the key). */
    reset: { input: Schema.Void, success: Schema.Void },
    /** Read the watermark (`{ highWatermark }` omitted when unset). */
    peek: { input: Schema.Void, success: PeekOutput, shared: true },
  },
})

const CursorLive = RestateObject.implement<typeof CursorObj>(CursorObj, {
  advance: (value) => Cursor.set('highWatermark', value),
  /* `set(..., undefined)` removes the key (the symmetric write of the "absent →
   * undefined" read) — no separate clear API needed inside the handler. */
  reset: () => Cursor.set('highWatermark', undefined),
  peek: () =>
    Cursor.get('highWatermark').pipe(
      Effect.map((highWatermark) => (highWatermark !== undefined ? { highWatermark } : {})),
    ),
})

const services = [GreeterLive, CounterLive, CursorLive] as const
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

      it.effect(
        'nullable State: set / get (present + absent) / clear via stateOf + handler (#1)',
        () =>
          Effect.gen(function* () {
            const env = yield* RestateTestEnv
            const key = `${kind}-cursor`
            const proxy = env.stateOf(CursorObj, key)

            /* ABSENT key reads back as `undefined` (both via stateOf AND the handler). */
            expect(yield* proxy.get('highWatermark')).toBeUndefined()
            expect(
              (yield* env.invokeObject(CursorObj, key, 'peek', undefined)).highWatermark,
            ).toBeUndefined()

            /* SEED a present value via stateOf, observe it through the handler (serde
             * round-trip across the boundary), then advance via the handler. */
            yield* proxy.set('highWatermark', 100)
            expect(yield* proxy.get('highWatermark')).toBe(100)
            expect((yield* env.invokeObject(CursorObj, key, 'peek', undefined)).highWatermark).toBe(
              100,
            )
            yield* env.invokeObject(CursorObj, key, 'advance', 250)
            expect(yield* proxy.get('highWatermark')).toBe(250)

            /* CLEAR via the handler's `set(undefined)` → the key is removed (absent ⇒
             * undefined again), and a NON-optional sibling field is untouched. */
            yield* proxy.set('name', 'watcher')
            yield* env.invokeObject(CursorObj, key, 'reset', undefined)
            expect(yield* proxy.get('highWatermark')).toBeUndefined()
            expect(
              (yield* env.invokeObject(CursorObj, key, 'peek', undefined)).highWatermark,
            ).toBeUndefined()
            expect(yield* proxy.get('name')).toBe('watcher')

            /* CLEAR directly via the stateOf proxy (`set(undefined)` and `clear`). */
            yield* proxy.set('highWatermark', 7)
            yield* proxy.set('highWatermark', undefined)
            expect(yield* proxy.get('highWatermark')).toBeUndefined()
            yield* proxy.set('highWatermark', 9)
            yield* proxy.clear('highWatermark')
            expect(yield* proxy.get('highWatermark')).toBeUndefined()
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
