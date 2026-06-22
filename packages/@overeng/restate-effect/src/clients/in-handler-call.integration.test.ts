/**
 * Integration gap (HIGH): in-handler service→service `Restate.call` / `Restate.send`
 * against a real native server. Only ingress→handler was proven before; this proves
 * the CROSS-INVOCATION construct — a handler calls a PEER handler (request/response,
 * durably journaled) and one-way SENDS to another, observing the side effect.
 *
 * An `orchestrator.start` handler:
 *   1. `Restate.call`s the `greeter.greet` Service (request/response) and uses the result;
 *   2. `Restate.send`s a one-way `recorder.record` (fire-and-forget) — the recorder is
 *      a keyed Object whose State we then read back via the shared query, proving the
 *      send was delivered cross-invocation.
 */
import { it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { Restate, RestateObject, RestateService, State } from '../mod.ts'
import { liveSleep, RestateTestHarness, serverAvailable } from '../testing/testing.ts'

/* ── a greeter Service (the request/response peer) ── */

const Greeter = RestateService.contract({
  name: 'ihc-greeter',
  handlers: {
    greet: {
      input: Schema.Struct({ name: Schema.String }),
      success: Schema.Struct({ message: Schema.String }),
    },
  },
})

const GreeterLive = RestateService.implement<typeof Greeter>({
  contractValue: Greeter,
  impl: {
    greet: ({ name }) => Effect.succeed({ message: `Hello ${name}` }),
  },
})

/* ── a recorder Object (the one-way `send` target — a keyed, stateful sink) ── */

const RecorderState = { last: Schema.String } as const
const Recorder = State.for(RecorderState)

const RecorderObj = RestateObject.contract({
  name: 'ihc-recorder',
  def: {
    state: RecorderState,
    handlers: {
      record: { input: Schema.String, success: Schema.Void },
      last: { input: Schema.Void, success: Schema.String, shared: true },
    },
  },
})

const RecorderLive = RestateObject.implement<typeof RecorderObj>({
  contractValue: RecorderObj,
  impl: {
    record: (value) => Recorder.set({ key: 'last', value: value }),
    last: () => Recorder.get('last').pipe(Effect.map((v) => v ?? '')),
  },
})

/* ── the orchestrator: in-handler `call` (req/resp) + `send` (one-way) ── */

const Orchestrator = RestateService.contract({
  name: 'ihc-orchestrator',
  handlers: {
    start: { input: Schema.String, success: Schema.String },
  },
})

const OrchestratorLive = RestateService.implement<typeof Orchestrator>({
  contractValue: Orchestrator,
  impl: {
    start: (name) =>
      Effect.gen(function* () {
        /* Request/response to a PEER Service, typed from its contract (durably
         * journaled — a crash recovers the result from the journal). */
        const greeting = yield* Restate.call({
          contract: Greeter,
          method: 'greet',
          input: { name },
        })
        /* One-way send to a keyed Object — fire-and-forget, delivered cross-invocation. */
        yield* Restate.objectSendClient({
          contract: RecorderObj,
          key: name,
          method: 'record',
          input: greeting.message,
        })
        return greeting.message
      }).pipe(Effect.orDie),
  },
})

const HarnessLayer = RestateTestHarness.layer({
  services: [GreeterLive, RecorderLive, OrchestratorLive],
  appLayer: Layer.empty,
  disableRetries: true,
})

describe.skipIf(!serverAvailable)('in-handler service→service call / send (real server)', () => {
  it.layer(HarnessLayer, { timeout: 90_000 })('cross-invocation', (it) => {
    it.effect('Restate.call returns the peer result; Restate.send is delivered', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        /* The orchestrator calls greeter (req/resp), then one-way-sends to recorder. */
        const message = yield* harness.ingress.call({
          contract: Orchestrator,
          method: 'start',
          input: 'Sarah',
        })
        expect(message).toBe('Hello Sarah')

        /* The one-way send is async; poll the recorder's shared query until the
         * cross-invocation `record` has landed (`liveSleep` elapses in real time under
         * the `it.effect` virtual TestClock). */
        const recorded = yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 50; attempt++) {
            const last = yield* harness.ingress.objectCall({
              contract: RecorderObj,
              key: 'Sarah',
              method: 'last',
              input: undefined,
            })
            if (last !== '') return last
            yield* liveSleep(100)
          }
          return ''
        })
        expect(recorded).toBe('Hello Sarah')
      }),
    )
  })
})
