/**
 * Integration gap: `Restate.runExit` saga-compensation against a real native server
 * (decision 0003). A failing durable step is OBSERVED as an `Exit` VALUE (instead of
 * failing the invocation), letting the handler branch and run a COMPENSATING durable
 * step. This proves the durable-step infra failure surfaces as a `Cause.Die`
 * carrying a `RestateError` defect (read via `Cause.dieOption`) — the saga seam — on
 * the real server, not just in a unit test.
 *
 * The `charge.run` handler: a `reserve` step succeeds, a `pay` step FAILS (a flaky
 * dependency that gives up after `ctx.run`'s own retries → a terminal infra defect);
 * the handler observes the failed `Exit`, runs a `refund` compensating step, and
 * returns a `'compensated'` outcome — the failure never escapes.
 */
import { it } from '@effect/vitest'
import { Cause, Effect, Exit, Layer, Result, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { Restate, RestateService } from '../mod.ts'
import { RestateError } from '../schema/RestateError.ts'
import { RestateTestHarness, serverAvailable } from '../testing/testing.ts'

const Charge = RestateService.contract({
  name: 'saga-charge',
  handlers: {
    run: { input: Schema.Void, success: Schema.String },
  },
})

const ChargeLive = RestateService.implement<typeof Charge>({
  contractValue: Charge,
  impl: {
    run: () =>
      Effect.gen(function* () {
        /* Step 1: reserve (succeeds, journaled once). */
        yield* Restate.run({ name: 'reserve', effect: Effect.succeed('reserved') }).pipe(
          Effect.orDie,
        )

        /* Step 2: pay — a flaky dependency that gives up (the inner step DIES, so the
         * step rejects; `ctx.run` exhausts its bounded retries → a terminal infra
         * defect). A durable step carries no catchable typed failure (#1), so forcing a
         * retry is a DIE, not a typed `Effect.fail`. OBSERVE the outcome as an `Exit`
         * instead of failing the invocation. The bounded `maxRetryAttempts` keeps the
         * test fast (no long backoff). */
        const payExit = yield* Restate.runExit({
          name: 'pay',
          effect: Effect.die(new Error('payment gateway down')),
          options: {
            maxRetryAttempts: 1,
          },
        })

        if (Exit.isFailure(payExit) === true) {
          /* The failure rode as a `Cause.Die` carrying the wrapper `RestateError`
           * (a durable-op infra defect, not a domain `E`). The saga seam: read it.
           * (v4: `findDie` yields a `Result<Die, Cause>` whose success is the `Die`
           * reason — the raw defect rides on `.defect`.) */
          const die = Cause.findDie(payExit.cause)
          const isRestateDefect =
            Result.isSuccess(die) === true && die.success.defect instanceof RestateError

          /* Compensate with a durable `refund` step, then report. */
          yield* Restate.run({ name: 'refund', effect: Effect.succeed('refunded') }).pipe(
            Effect.orDie,
          )
          return isRestateDefect === true ? 'compensated' : 'compensated-other'
        }
        return 'charged'
      }),
  },
})

const HarnessLayer = RestateTestHarness.layer({
  services: [ChargeLive],
  appLayer: Layer.empty,
  disableRetries: true,
})

describe.skipIf(!serverAvailable)('runExit saga-compensation (real server)', () => {
  it.layer(HarnessLayer, { timeout: 90_000 })('failing step → compensating step', (it) => {
    it.effect('a failed durable step is observed and compensated', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const outcome = yield* harness.ingress.call({
          contract: Charge,
          method: 'run',
          input: undefined,
        })
        /* The pay step failed as a `RestateError` defect, was observed via `runExit`,
         * and the `refund` compensating step ran — the failure never escaped. */
        expect(outcome).toBe('compensated')
      }),
    )
  })
})
