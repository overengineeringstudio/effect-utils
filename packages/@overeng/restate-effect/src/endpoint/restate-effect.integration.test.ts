/**
 * End-to-end integration test against a real native `restate-server`, on the
 * Phase 1 contract/implement architecture.
 *
 * Proves one Service vertical slice: a `contract` + `implement` with an injected
 * application Layer (`Greeting`) and a durable `Restate.run`, served via the
 * scoped endpoint `layer`, registered against the native server, driven through
 * the typed `RestateIngress` client — asserting BOTH the success path and the
 * typed terminal-error path (`EmptyName` recovered via the decode helper).
 */
import { Context, Effect, Layer, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { callTyped, Restate, RestateIngress, RestateService } from '../mod.ts'
import { serverAvailable, withRestateServer } from '../testing/testing.ts'

/* ── demo app: an injected Effect service + a greeter Restate service ── */

class Greeting extends Context.Service<Greeting, { readonly prefix: string }>()('test/Greeting') {
  static readonly Default = Layer.succeed(Greeting, { prefix: 'Hello' })
}

class EmptyName extends Schema.TaggedErrorClass<EmptyName>('test/EmptyName')('EmptyName', {}) {}

const GreetInput = Schema.Struct({ name: Schema.String })
const GreetSuccess = Schema.Struct({ message: Schema.String, id: Schema.String })

const Greeter = RestateService.contract({
  name: 'greeter',
  handlers: {
    greet: { input: GreetInput, success: GreetSuccess, error: EmptyName },
  },
})

const GreeterLive = RestateService.implement<typeof Greeter, Greeting>({
  contractValue: Greeter,
  impl: {
    greet: ({ name }) =>
      Effect.gen(function* () {
        if (name === '') return yield* new EmptyName()
        const prefix = (yield* Greeting).prefix
        /* A failed durable step is infrastructure-transient → `orDie` so the
         * wrapper `RestateError` leaves the domain `E` channel (only `EmptyName`)
         * and the SDK retries it. */
        const id = yield* Restate.run({
          name: 'gen-id',
          effect: Effect.sync(() => crypto.randomUUID()),
        }).pipe(Effect.orDie)
        return { message: `${prefix} ${name}`, id }
      }),
  },
})

/* ── harness ── */

/* One held native server for the suite (collapses the copy-pasted scope/ingress
 * `beforeAll`); the consumer `Greeting` Layer is threaded into the served runtime.
 * The standalone `callTyped` needs a `RestateIngress` layer built from the booted
 * ingress URL. */
const held = withRestateServer({ services: [GreeterLive], appLayer: Greeting.Default })
const ingressLayer = (): Layer.Layer<RestateIngress> =>
  RestateIngress.layer({ url: held.harness().ingressUrl })

const terminalErrorParam = (value: unknown): value is { readonly name: 'TerminalError' } =>
  typeof value === 'object' && value !== null && 'name' in value && value.name === 'TerminalError'

describe('restate-effect end-to-end (contract/implement)', () => {
  beforeAll(held.setup, 60_000)
  afterAll(held.teardown, 60_000)

  it.skipIf(!serverAvailable)('greet returns the prefixed message + a uuid', async () => {
    const result = await Effect.runPromise(
      callTyped({ contract: Greeter, method: 'greet', input: { name: 'Sarah' } }).pipe(
        Effect.provide(ingressLayer()),
      ),
    )
    expect(result.message).toBe('Hello Sarah')
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it.skipIf(!serverAvailable)(
    'greet with empty name recovers the typed EmptyName via the decode helper',
    async () => {
      const recovered = await Effect.runPromise(
        callTyped({ contract: Greeter, method: 'greet', input: { name: '' } }).pipe(
          Effect.map(() => 'unexpected-success' as const),
          Effect.catchTag('EmptyName', () => Effect.succeed('recovered-EmptyName' as const)),
          Effect.provide(ingressLayer()),
        ),
      )
      expect(recovered).toBe('recovered-EmptyName')

      const sdkLogs = held.harness().sdkLogs.records()
      expect(
        sdkLogs.some(
          (record) =>
            typeof record.message === 'string' &&
            record.message.includes('Accepting requests without validating request signatures'),
        ),
      ).toBe(false)
      expect(
        sdkLogs.some((record) => record.optionalParams.some((param) => terminalErrorParam(param))),
      ).toBe(true)
    },
  )
})
