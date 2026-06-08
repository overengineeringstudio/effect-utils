/**
 * Integration test for awakeables against a real native `restate-server`.
 *
 * Proves the awakeable round-trip (R33): a handler creates an awakeable, stores
 * its id in State, then SUSPENDS on the awakeable promise; the test reads the id
 * via a shared query, resolves the awakeable from INGRESS, and asserts the
 * handler resumes with the typed payload (recovered via `result`).
 */
import { Effect, Exit, Layer, Schema, Scope } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startRestateServer, type RestateServerHandle } from '../test/restate-server.ts'
import { freePort, serverAvailable } from '../test/test-utils.ts'
import {
  Awakeable,
  type AwakeableId,
  ingressResolveAwakeable,
  layer,
  objectCall,
  objectSend,
  Restate,
  RestateIngress,
  RestateObject,
  result,
  State,
} from './mod.ts'

/* ── object that creates an awakeable, stores its id, suspends, returns payload ── */

const Payload = Schema.Struct({ token: Schema.String })

const WaiterState = { awakeableId: Schema.String } as const
const Waiter = State.for(WaiterState)

/* The input carries the idempotency key (decision 0011) so the send's output is
 * retained and attachable via `result`. */
const StartInput = Schema.Struct({ runId: Restate.idempotencyKey(Schema.String) })

const WaiterObj = RestateObject.contract('waiter', {
  state: WaiterState,
  handlers: {
    /* Exclusive: create the awakeable, store its id, suspend until resolved. */
    start: { input: StartInput, success: Payload },
    /* Shared read-only: read the stored awakeable id (so ingress can resolve it). */
    awakeableId: { input: Schema.Void, success: Schema.String, shared: true },
  },
})

const WaiterLive = RestateObject.implement<typeof WaiterObj>(WaiterObj, {
  start: () =>
    Effect.gen(function* () {
      const { id, promise } = yield* Awakeable.make(Payload)
      yield* Waiter.set('awakeableId', id)
      /* Suspends here until ingress resolves the awakeable; returns the payload. */
      return yield* promise
    }).pipe(Effect.orDie),
  awakeableId: () =>
    Waiter.get('awakeableId').pipe(
      Effect.map((id) => id ?? ''),
      Effect.orDie,
    ),
})

describe('restate-effect awakeable round-trip', () => {
  let server: RestateServerHandle
  let endpointScope: Scope.CloseableScope
  let ingressLayer: Layer.Layer<RestateIngress>

  beforeAll(async () => {
    if (!serverAvailable) return
    server = await startRestateServer()
    const sdkPort = await freePort()
    endpointScope = await Effect.runPromise(Scope.make())
    await Effect.runPromise(
      Layer.buildWithScope(layer({ services: [WaiterLive], port: sdkPort }), endpointScope),
    )
    await server.register(`http://localhost:${sdkPort}`)
    ingressLayer = RestateIngress.layer({ url: server.ingressUrl })
  }, 60_000)

  afterAll(async () => {
    if (!serverAvailable) return
    if (endpointScope !== undefined) await Effect.runPromise(Scope.close(endpointScope, Exit.void))
    if (server !== undefined) await server.shutdown()
  }, 60_000)

  it.skipIf(!serverAvailable)(
    'handler suspends on awakeable, resumes with ingress payload',
    async () => {
      const resumed = await Effect.runPromise(
        Effect.gen(function* () {
          /* Start the suspending handler one-way (idempotency-keyed → output retained). */
          const send = yield* objectSend(WaiterObj, 'job-1', 'start', { runId: 'job-1' })

          /* Poll the shared query until the awakeable id is registered in State. */
          const awakeableId = yield* pollForId('job-1')

          /* Resolve the awakeable from ingress with the typed payload. */
          yield* ingressResolveAwakeable(
            Payload,
            awakeableId as AwakeableId<Schema.Schema.Type<typeof Payload>>,
            { token: 'resumed-ok' },
          )

          /* Attach to the original send's output — the resumed handler return value. */
          return yield* result(send, Payload)
        }).pipe(Effect.provide(ingressLayer)),
      )
      expect(resumed).toEqual({ token: 'resumed-ok' })
    },
  )
})

/** Poll the shared `awakeableId` query until the suspended handler has stored it. */
const pollForId = (key: string): Effect.Effect<string, never, RestateIngress> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = yield* objectCall(WaiterObj, key, 'awakeableId', undefined).pipe(
        Effect.catchAll(() => Effect.succeed('')),
      )
      if (id !== '') return id
      yield* Effect.sleep('100 millis')
    }
    return ''
  })
