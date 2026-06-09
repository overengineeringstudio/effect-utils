/**
 * Verifies the README / `examples/` snippets end-to-end against a real native
 * `restate-server` via the `./testing` harness. Every example construct
 * (Service + typed error boundary, Virtual Object + typed State, Workflow + durable
 * promise, idempotency-keyed send + awakeable round-trip, `alwaysReplay`
 * determinism) is driven through the SAME contracts/impls the docs show, so a
 * documented snippet that stopped working would fail CI here — the docs cannot
 * silently rot.
 *
 * Gracefully skips when no native `restate-server` binary is available
 * (`serverAvailable`) — e.g. outside the dedicated integration job.
 */
import { it } from '@effect/vitest'
import { Clock, Effect, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { Greeter } from '../examples/01-service.ts'
import { CounterObj } from '../examples/02-virtual-object.ts'
import { ApprovalWf } from '../examples/03-workflow.ts'
import { WaiterObj } from '../examples/07-clients-idempotency-awakeables.ts'
import {
  GreeterHarness,
  ReplayHarness,
  serverAvailable,
  StatefulHarness,
} from '../examples/11-testing.ts'
import {
  type AwakeableId,
  ingressResolveAwakeable,
  RestateIngress,
  result as ingressResult,
} from './mod.ts'
import { RestateTestHarness } from './testing.ts'

/** The harness service value (for the `pollForId` helper's parameter type). */
type Harness = Effect.Effect.Success<typeof RestateTestHarness>

const AwakeablePayload = Schema.Struct({ token: Schema.String })

/* A REAL-time sleep, ignoring `@effect/vitest`'s `it.effect` TestClock (under
 * which `Effect.sleep` is virtual and never advances). We coordinate with a real
 * native server across suspend/resume, so wall-clock waits must actually elapse. */
const liveSleep = (millis: number): Effect.Effect<void> =>
  Effect.sleep(millis).pipe(Effect.withClock(Clock.make()))

describe.skipIf(!serverAvailable)('examples (verified end-to-end)', () => {
  it.layer(GreeterHarness, { timeout: 90_000 })('01-service', (it) => {
    it.effect('typed success + the typed error boundary', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness

        /* Typed success: `{ message, id }`, validated through the success serde. */
        const ok = yield* harness.ingress.callTyped(Greeter, 'greet', { name: 'Sarah' })
        expect(ok.message).toBe('Hello Sarah')
        expect(ok.id).toMatch(/^[0-9a-f-]{36}$/)

        /* The typed error boundary: `EmptyName` crosses the wire as a terminal error
         * and decodes back into the tagged error for `catchTag`. The harness
         * `ingress.callTyped` now carries the precise `RestateError | EmptyName`
         * channel (the bound surface mirrors each `Client` function's generic
         * signature, so the per-call typed error survives — no escape to the
         * standalone `callTyped` needed). */
        const recovered = yield* harness.ingress.callTyped(Greeter, 'greet', { name: '' }).pipe(
          Effect.map(() => 'unexpected' as const),
          Effect.catchTag('EmptyName', () => Effect.succeed('recovered' as const)),
        )
        expect(recovered).toBe('recovered')
      }),
    )
  })

  it.layer(StatefulHarness, { timeout: 90_000 })('objects, workflows, awakeables', (it) => {
    it.effect('02-virtual-object: exclusive write + shared read, per-key isolated', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness

        const afterFirst = yield* harness.ingress.objectCall(CounterObj, 'cart-a', 'add', 3)
        const afterSecond = yield* harness.ingress.objectCall(CounterObj, 'cart-a', 'add', 4)
        const read = yield* harness.ingress.objectCall(CounterObj, 'cart-a', 'get', undefined)
        expect(afterFirst).toBe(3)
        expect(afterSecond).toBe(7)
        expect(read).toBe(7)

        /* Per-key isolation + typed `stateOf` inspection. */
        yield* harness.ingress.objectCall(CounterObj, 'cart-b', 'add', 100)
        expect(yield* harness.stateOf(CounterObj, 'cart-a').get('count')).toBe(7)
        expect(yield* harness.stateOf(CounterObj, 'cart-b').get('count')).toBe(100)
      }),
    )

    it.effect('03-workflow: submit → signal → attach (durable promise)', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness

        yield* harness.ingress.workflowSubmit(ApprovalWf, 'wf-approve', 'please review')
        /* Let `run` register the durable promise, then signal it. */
        yield* liveSleep(200)
        yield* harness.ingress.workflowCall(ApprovalWf, 'wf-approve', 'approve', undefined)

        const result = yield* harness.ingress.workflowAttach(ApprovalWf, 'wf-approve')
        const status = yield* harness.ingress.workflowCall(
          ApprovalWf,
          'wf-approve',
          'status',
          undefined,
        )
        expect(result).toBe(true)
        expect(status).toBe('approved')
      }),
    )

    it.effect('07-awakeable: idempotency-keyed send → ingress resolve → result', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness

        /* Start the suspending handler one-way. The `runId` field is the
         * idempotency key (decision 0011), so the send's output is retained. */
        const send = yield* harness.ingress.objectSend(WaiterObj, 'job-1', 'start', {
          runId: 'job-1',
        })

        /* Poll the shared query until the awakeable id is registered. */
        const awakeableId = yield* pollForId(harness, 'job-1')
        expect(awakeableId).not.toBe('')

        /* Resolve the awakeable from ingress with the typed payload (this standalone
         * function still needs `RestateIngress`, provided from the harness URL). */
        yield* ingressResolveAwakeable(
          AwakeablePayload,
          awakeableId as AwakeableId<Schema.Schema.Type<typeof AwakeablePayload>>,
          { token: 'resumed-ok' },
        ).pipe(Effect.provide(RestateIngress.layer({ url: harness.ingressUrl })))

        /* The handler resumes and returns the payload (attach to the send output).
         * The standalone `result` keeps the precise success type; provide the
         * harness ingress URL. */
        const resumed = yield* ingressResult(send, AwakeablePayload).pipe(
          Effect.provide(RestateIngress.layer({ url: harness.ingressUrl })),
        )
        expect(resumed).toEqual({ token: 'resumed-ok' })
      }),
    )
  })

  it.layer(ReplayHarness, { timeout: 90_000 })('alwaysReplay determinism', (it) => {
    it.effect('a journaled Object handler is replay-stable', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        yield* harness.stateOf(CounterObj, 'replay-1').set('count', 0)
        const first = yield* harness.ingress.objectCall(CounterObj, 'replay-1', 'add', 1)
        const second = yield* harness.ingress.objectCall(CounterObj, 'replay-1', 'add', 1)
        expect(first).toBe(1)
        expect(second).toBe(2)
      }),
    )
  })
})

/** Poll typed `stateOf` until the suspended handler has stored its awakeable id. */
const pollForId = (harness: Harness, key: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const state = harness.stateOf(WaiterObj, key)
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = yield* state
        .get('awakeableId')
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      if (id !== undefined && id !== '') return id
      yield* liveSleep(100)
    }
    return ''
  })
