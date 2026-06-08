/**
 * Service-to-service calls + idempotency + awakeables.
 *
 * - In-handler clients (`Restate.call` / `send` / `objectClient` / …) invoke
 *   another construct from inside a handler, typed from the TARGET contract.
 *   `call` is request/response (durably journaled — a caller crash recovers the
 *   result rather than re-issuing); `send` is one-way (optionally delayed, a
 *   durable fault-tolerant cron).
 * - Idempotency is declared ONCE on the input field via `Restate.idempotencyKey`
 *   — the single source. The client reads the key off that field; there is no
 *   call-site `{ idempotencyKey }` option to keep in sync.
 * - An awakeable is a typed external-completion token: a handler creates one,
 *   hands its `id` to an external system, and SUSPENDS on its `promise` until the
 *   external system resolves it (in-handler or via ingress).
 *
 * The awakeable round-trip is verified end-to-end by
 * `src/examples.integration.test.ts`.
 */
import { Effect, Schema } from 'effect'

import { Awakeable, Restate, RestateObject, RestateService, State } from '../src/mod.ts'
import { Greeter } from './01-service.ts'

/* ── Idempotency: the key lives on the annotated input FIELD (the only source) ── */

export const NotifyInput = Schema.Struct({
  /* The value of THIS field becomes the call/send idempotency key. */
  requestId: Restate.idempotencyKey(Schema.String),
  body: Schema.String,
})

export const Notifier = RestateService.contract('notifier', {
  notify: { input: NotifyInput, success: Schema.Void },
})

/* ── In-handler service-to-service calls (require `RestateContext`) ────────── */

export const Orchestrator = RestateService.define(
  'orchestrator',
  {
    start: { input: Schema.String, success: Schema.String },
  },
  {
    start: (name) =>
      Effect.gen(function* () {
        /* Request/response to another Service, typed from `Greeter`'s contract.
         * Durably journaled, so a crash recovers the result from the journal. */
        const greeting = yield* Restate.call(Greeter, 'greet', { name }).pipe(Effect.orDie)
        /* One-way send; the idempotency key is read off `requestId` automatically. */
        yield* Restate.send(Notifier, 'notify', {
          requestId: `welcome-${name}`,
          body: greeting.message,
        }).pipe(Effect.orDie)
        /* A delayed one-way send — a durable, fault-tolerant timer. */
        yield* Restate.send(
          Notifier,
          'notify',
          { requestId: `reminder-${name}`, body: 'still there?' },
          { delayMillis: 60_000 },
        ).pipe(Effect.orDie)
        return greeting.message
      }),
  },
)

/* ── Awakeables: a typed external-completion token ─────────────────────────── */

const Payload = Schema.Struct({ token: Schema.String })

/* The input carries the idempotency key (so the one-way send's output is retained
 * and attachable via `result` once the awakeable resolves). */
export const StartInput = Schema.Struct({ runId: Restate.idempotencyKey(Schema.String) })

const WaiterState = { awakeableId: Schema.String } as const
const Waiter = State.for(WaiterState)

export const WaiterObj = RestateObject.contract('waiter', {
  state: WaiterState,
  handlers: {
    /* Create the awakeable, store its id (so an external system can read it back
     * via the shared query), then SUSPEND on the promise until resolved. */
    start: { input: StartInput, success: Payload },
    awakeableId: { input: Schema.Void, success: Schema.String, shared: true },
  },
})

export const WaiterLive = RestateObject.implement<typeof WaiterObj>(WaiterObj, {
  start: () =>
    Effect.gen(function* () {
      const { id, promise } = yield* Awakeable.make(Payload)
      yield* Waiter.set('awakeableId', id)
      return yield* promise // suspends until the awakeable is resolved
    }).pipe(Effect.orDie),
  awakeableId: () =>
    Waiter.get('awakeableId').pipe(
      Effect.map((id) => id ?? ''),
      Effect.orDie,
    ),
})

/* Resolution comes from ingress (`ingressResolveAwakeable(Payload, id, payload)`)
 * or from another handler (`Awakeable.resolve(Payload, id, payload)`); see
 * `src/examples.integration.test.ts` for the full round-trip. */
