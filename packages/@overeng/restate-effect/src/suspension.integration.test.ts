/**
 * Falsifying regression for the durable-await classification bug (PR #760, Codex P1).
 *
 * The standalone blocking awaits — the awakeable `promise` and the durable-promise
 * `get`/`peek` — previously wrapped EVERY rejection into a `RestateError` defect via
 * `tryPromise + orDie`, NOT routing through `awaitDurable` (the seam `run`/`sleep`
 * use to classify cancellation/suspension/terminal/infra). The fix routes them
 * through `awaitDurable`, so a `reject`'s `TerminalError` terminalizes verbatim (R34)
 * and a cancellation interrupts — instead of degrading to a retried infra defect.
 *
 * - TERMINAL `reject` (the decisive falsifier; default RETRYING harness + an
 *   in-process attempt counter): a `DurablePromise.reject` must make the awaiting
 *   `get` fail TERMINALLY — the `run` ends and is NOT retried (the counter stays at
 *   one). Under the BUG the reject became a `RestateError` DEFECT, which Restate
 *   RETRIES forever — the counter climbs and the run never terminalizes (the test
 *   times out). This case FAILS on the buggy code and PASSES on the fix.
 * - SUSPEND + RESUME (`alwaysReplay` + `disableRetries`): a handler awaiting an
 *   awakeable — and SEPARATELY a durable promise — resolved AFTER a forced
 *   suspension must still PARK and RESUME to success. These pin the suspend/resume
 *   contract for the standalone awaits (previously only `run`/`sleep` had explicit
 *   suspend coverage), guarding against a regression that breaks it. NOTE: in SDK
 *   ≥1.14 the runtime suspends an unresolved await BELOW the JS-promise layer (the
 *   awaited promise is never settled in the suspending attempt, so the `tryPromise`
 *   catch is not reached on suspension) — so suspend/resume already held even on the
 *   buggy code; the terminal-`reject` case is what the bug actually broke.
 */
import { it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect } from 'vitest'

import {
  type AwakeableId,
  Awakeable,
  DurablePromise,
  ingressResolveAwakeable,
  Restate,
  RestateIngress,
  RestateObject,
  RestateWorkflow,
  result as ingressResult,
  State,
} from './mod.ts'
import { liveSleep, RestateTestHarness, serverAvailable } from './testing.ts'

/* ── awakeable suspension: create, store id, await; resolved from ingress ──── */

const AwPayload = Schema.Struct({ token: Schema.String })

const AwWaiterState = { awakeableId: Schema.String } as const
const AwWaiter = State.for(AwWaiterState)
/* `runId` is the idempotency key (decision 0011), so the send's output is retained
 * and attachable via `result` after the parked handler resumes. */
const AwStartInput = Schema.Struct({ runId: Restate.idempotencyKey(Schema.String) })

const AwObj = RestateObject.contract('suspend-awakeable', {
  state: AwWaiterState,
  handlers: {
    start: { input: AwStartInput, success: AwPayload },
    awakeableId: { input: Schema.Void, success: Schema.String, shared: true },
  },
})

const AwLive = RestateObject.implement<typeof AwObj>(AwObj, {
  start: () =>
    Effect.gen(function* () {
      const { id, promise } = yield* Awakeable.make(AwPayload)
      yield* AwWaiter.set('awakeableId', id)
      /* PARKS here (the runtime forces suspension under `alwaysReplay`) until ingress
       * resolves the awakeable, then RESUMES with the payload. */
      return yield* promise
    }).pipe(Effect.orDie),
  awakeableId: () =>
    AwWaiter.get('awakeableId').pipe(
      Effect.map((id) => id ?? ''),
      Effect.orDie,
    ),
})

/* ── durable-promise suspension + terminal reject: run awaits `get` ───────── */

const PromiseValue = DurablePromise.for(Schema.String)

/* Module-level attempt counter (the endpoint runs in-process); survives the
 * per-attempt State rollback a failed/retried attempt incurs — mirrors
 * `retry-policy.integration.test.ts`. */
const attempts = { run: 0 }

const RunState = { done: Schema.Boolean } as const
const RunS = State.for(RunState)

const PromiseWf = RestateWorkflow.contract('suspend-promise', {
  state: RunState,
  payload: { input: Schema.Void, success: Schema.String },
  signals: {
    resolveIt: { input: Schema.String, success: Schema.Void },
    rejectIt: { input: Schema.String, success: Schema.Void },
  },
  queries: {},
})

const PromiseWfLive = RestateWorkflow.implement<typeof PromiseWf>(PromiseWf, {
  /* `run`: await the durable `signal` promise. A `resolve` resumes it; a `reject`
   * makes the `get` fail TERMINALLY (so the `run` ends, NOT retried). The counter
   * climbs on each REAL (non-replay) entry — a retried defect bumps it past one. */
  run: () =>
    Effect.gen(function* () {
      attempts.run += 1
      const value = yield* PromiseValue.get('signal')
      yield* RunS.set('done', true)
      return value
    }).pipe(Effect.orDie),
  resolveIt: (value: string) => PromiseValue.resolve('signal', value).pipe(Effect.orDie),
  rejectIt: (reason: string) => PromiseValue.reject('signal', reason).pipe(Effect.orDie),
})

/* The suspend-and-resume contract harness, combining:
 * - `alwaysReplay: true` (`INACTIVITY_TIMEOUT=0s`) — the server FORCES a real
 *   protocol-level suspension at EVERY yield (not a transparent same-attempt park a
 *   fast resolve would hide), so an unresolved await genuinely parks and replays.
 * - `disableRetries: true` (max-attempts=1 + kill-on-max) — there is NO retry to
 *   recover, so a resume-to-success here is true suspend/resume, not a masked retry. */
const FailFastHarness = RestateTestHarness.layer({
  services: [AwLive, PromiseWfLive],
  appLayer: Layer.empty,
  alwaysReplay: true,
  disableRetries: true,
})

/* Default RETRYING harness — for the terminal-`reject` falsifier (a defect would
 * RETRY here, climbing the counter; a terminalized reject does not). */
const RetryingHarness = RestateTestHarness.layer({
  services: [AwLive, PromiseWfLive],
  appLayer: Layer.empty,
})

type Harness = Effect.Effect.Success<typeof RestateTestHarness>

/** Poll the shared `awakeableId` query until the parked handler has stored it. */
const pollForAwakeableId = (harness: Harness, key: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = yield* harness.ingress
        .objectCall(AwObj, key, 'awakeableId', undefined)
        .pipe(Effect.catchAll(() => Effect.succeed('')))
      if (id !== '') return id
      yield* liveSleep(100)
    }
    return ''
  })

/** Observe a counter climb past one within a bounded window (a retry firing). */
const climbsPastOne = (read: () => number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (let i = 0; i < 50; i++) {
      if (read() >= 2) return true
      yield* liveSleep(100)
    }
    return read() > 1
  })

describe.skipIf(!serverAvailable)('durable-await classification (real server)', () => {
  it.layer(FailFastHarness, { timeout: 90_000 })('suspend + resume', (it) => {
    it.effect('awakeable: parks on an unresolved await, resumes on ingress resolve', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness

        /* Idempotency-keyed send → output retained for `result`. */
        const send = yield* harness.ingress.objectSend(AwObj, 'aw-1', 'start', { runId: 'aw-1' })

        /* Register + park (the await is unresolved when the first attempt reaches it;
         * `alwaysReplay` then forces a real suspension), then resolve after a delay. */
        const awakeableId = yield* pollForAwakeableId(harness, 'aw-1')
        expect(awakeableId).not.toBe('')
        yield* liveSleep(200)
        yield* ingressResolveAwakeable(
          AwPayload,
          awakeableId as AwakeableId<Schema.Schema.Type<typeof AwPayload>>,
          { token: 'resumed-ok' },
        ).pipe(Effect.provide(RestateIngress.layer({ url: harness.ingressUrl })))

        /* The handler RESUMED across the forced suspension (no retry available). */
        const resumed = yield* ingressResult(send, AwPayload).pipe(
          Effect.provide(RestateIngress.layer({ url: harness.ingressUrl })),
        )
        expect(resumed).toEqual({ token: 'resumed-ok' })
      }),
    )

    it.effect('durable promise: parks on an unresolved get, resumes on resolve signal', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness

        yield* harness.ingress.workflowSubmit(PromiseWf, 'dp-1', undefined)
        /* Let `run` reach the unresolved `get` (parks), THEN resolve after a delay. */
        yield* liveSleep(300)
        yield* harness.ingress.workflowCall(PromiseWf, 'dp-1', 'resolveIt', 'resumed-value')

        const result = yield* harness.ingress.workflowAttach(PromiseWf, 'dp-1')
        expect(result).toBe('resumed-value')
        expect(yield* harness.stateOf(PromiseWf, 'dp-1').get('done')).toBe(true)
      }),
    )
  })

  it.layer(RetryingHarness, { timeout: 90_000 })('terminal reject (retrying harness)', (it) => {
    it.effect('a DurablePromise.reject terminalizes the awaiting get (run NOT retried)', () =>
      Effect.gen(function* () {
        attempts.run = 0
        const harness = yield* RestateTestHarness

        yield* harness.ingress.workflowSubmit(PromiseWf, 'dp-reject', undefined)
        /* Let `run` reach the unresolved `get` (one real attempt = counter at 1). */
        yield* liveSleep(300)
        expect(attempts.run).toBe(1)

        /* Reject the durable promise → the `get` fails TERMINALLY: the `run` ends and
         * is NOT retried. Under the bug the reject was a `RestateError` DEFECT, which
         * Restate RETRIES — the counter would climb past one. */
        yield* harness.ingress.workflowCall(PromiseWf, 'dp-reject', 'rejectIt', 'denied')

        /* Attach observes the terminal failure (the `run` did not succeed). */
        const exit = yield* Effect.exit(harness.ingress.workflowAttach(PromiseWf, 'dp-reject'))
        expect(exit._tag).toBe('Failure')

        /* The decisive falsifier: NO retry fired (a terminal outcome, not a defect). */
        expect(yield* climbsPastOne(() => attempts.run)).toBe(false)
        expect(attempts.run).toBe(1)
      }),
    )
  })
})
