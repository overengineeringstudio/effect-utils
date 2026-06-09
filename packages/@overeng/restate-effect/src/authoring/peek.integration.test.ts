/**
 * Integration gap: `DurablePromise.peek` (the NON-blocking durable-promise read)
 * against a real native server. Only the blocking `get` was integration-tested;
 * `peek` returns `undefined` while the promise is unresolved and the value once it
 * resolves — without suspending the reader.
 *
 * An `peeker` workflow whose `run` peeks the `decision` promise (records the
 * unresolved `peek` → `false`), waits a beat, then a `resolve` signal sets it; a
 * `peeked` query reports whether a later `peek` saw the resolved value.
 */
import { it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { DurablePromise, RestateWorkflow, State } from '../mod.ts'
import { liveSleep, RestateTestHarness, serverAvailable } from '../testing/testing.ts'

const Decision = DurablePromise.for(Schema.Boolean)

const PeekState = {
  peekBeforeResolve: Schema.Boolean,
  peekAfterResolve: Schema.Boolean,
} as const
const PeekS = State.for(PeekState)

const Peeker = RestateWorkflow.contract('peek-wf', {
  state: PeekState,
  payload: { input: Schema.Void, success: Schema.Boolean },
  signals: {
    resolveIt: { input: Schema.Void, success: Schema.Void },
  },
  queries: {
    peeked: { input: Schema.Void, success: Schema.Boolean },
  },
})

const PeekerLive = RestateWorkflow.implement<typeof Peeker>(Peeker, {
  /* `run`: peek BEFORE resolution (undefined → false), wait for the signal to
   * resolve the durable `decision`, then peek AFTER (sees the value → true). */
  run: () =>
    Effect.gen(function* () {
      const before = yield* Decision.peek('decision')
      yield* PeekS.set('peekBeforeResolve', before !== undefined)
      /* Block until the durable promise is resolved by the signal. */
      const value = yield* Decision.get('decision')
      const after = yield* Decision.peek('decision')
      yield* PeekS.set('peekAfterResolve', after !== undefined)
      return value
    }).pipe(Effect.orDie),
  /* Signal (shared): resolve the durable promise. */
  resolveIt: () => Decision.resolve('decision', true).pipe(Effect.orDie),
  /* Query (shared, read-only): report whether the post-resolve peek saw the value. */
  peeked: () =>
    PeekS.get('peekAfterResolve').pipe(
      Effect.map((v) => v ?? false),
      Effect.orDie,
    ),
})

const HarnessLayer = RestateTestHarness.layer({
  services: [PeekerLive],
  appLayer: Layer.empty,
  disableRetries: true,
})

describe.skipIf(!serverAvailable)('DurablePromise.peek (real server)', () => {
  it.layer(HarnessLayer, { timeout: 90_000 })('non-blocking peek', (it) => {
    it.effect('peek is undefined before resolution, the value after', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        yield* harness.ingress.workflowSubmit(Peeker, 'peek-1', undefined)
        /* Let `run` register + peek the unresolved promise. */
        yield* liveSleep(200)
        /* The pre-resolve State proves the early peek was UNRESOLVED (false). */
        expect(yield* harness.stateOf(Peeker, 'peek-1').get('peekBeforeResolve')).toBe(false)

        /* Resolve via the signal, attach for the run result, then read the post-peek. */
        yield* harness.ingress.workflowCall(Peeker, 'peek-1', 'resolveIt', undefined)
        const result = yield* harness.ingress.workflowAttach(Peeker, 'peek-1')
        const peekedAfter = yield* harness.ingress.workflowCall(
          Peeker,
          'peek-1',
          'peeked',
          undefined,
        )
        expect(result).toBe(true)
        /* The post-resolve peek saw the resolved value (non-blocking read). */
        expect(peekedAfter).toBe(true)
      }),
    )
  })
})
