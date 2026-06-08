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
import { createServer } from 'node:net'

import { Context, Effect, Exit, Layer, Schema, Scope } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startRestateServer, type RestateServerHandle } from '../test/restate-server.ts'
import { callTyped, layer, Restate, RestateIngress, RestateService } from './mod.ts'

/* ── demo app: an injected Effect service + a greeter Restate service ── */

class Greeting extends Context.Tag('test/Greeting')<Greeting, { readonly prefix: string }>() {
  static readonly Default = Layer.succeed(Greeting, { prefix: 'Hello' })
}

class EmptyName extends Schema.TaggedError<EmptyName>('test/EmptyName')('EmptyName', {}) {}

const GreetInput = Schema.Struct({ name: Schema.String })
const GreetSuccess = Schema.Struct({ message: Schema.String, id: Schema.String })

const Greeter = RestateService.contract('greeter', {
  greet: { input: GreetInput, success: GreetSuccess, error: EmptyName },
})

const GreeterLive = RestateService.implement<typeof Greeter, Greeting>(Greeter, {
  greet: ({ name }) =>
    Effect.gen(function* () {
      if (name === '') return yield* new EmptyName()
      const prefix = (yield* Greeting).prefix
      /* A failed durable step is infrastructure-transient → `orDie` so the
       * wrapper `RestateError` leaves the domain `E` channel (only `EmptyName`)
       * and the SDK retries it. */
      const id = yield* Restate.run(
        'gen-id',
        Effect.sync(() => crypto.randomUUID()),
      ).pipe(Effect.orDie)
      return { message: `${prefix} ${name}`, id }
    }),
})

/* ── harness ── */

const serverAvailable = (() => {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    execFileSync(process.env['RESTATE_SERVER_BIN'] ?? 'restate-server', ['--version'], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
})()

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('no free port')))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })

describe('restate-effect end-to-end (contract/implement)', () => {
  let server: RestateServerHandle
  let endpointScope: Scope.CloseableScope
  let ingressLayer: Layer.Layer<RestateIngress>

  beforeAll(async () => {
    if (!serverAvailable) return
    server = await startRestateServer()
    const sdkPort = await freePort()

    /* Launch the endpoint layer in a scope we hold open; the finalizer closes
     * the HTTP/2 server in afterAll. */
    endpointScope = await Effect.runPromise(Scope.make())
    await Effect.runPromise(
      Layer.buildWithScope(layer({ services: [GreeterLive], port: sdkPort }), endpointScope).pipe(
        Effect.provide(Greeting.Default),
      ),
    )

    await server.register(`http://localhost:${sdkPort}`)
    ingressLayer = RestateIngress.layer({ url: server.ingressUrl })
  }, 60_000)

  afterAll(async () => {
    if (!serverAvailable) return
    if (endpointScope !== undefined) {
      await Effect.runPromise(Scope.close(endpointScope, Exit.void))
    }
    if (server !== undefined) await server.shutdown()
  }, 60_000)

  it.skipIf(!serverAvailable)('greet returns the prefixed message + a uuid', async () => {
    const result = await Effect.runPromise(
      callTyped(Greeter, 'greet', { name: 'Sarah' }).pipe(Effect.provide(ingressLayer)),
    )
    expect(result.message).toBe('Hello Sarah')
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it.skipIf(!serverAvailable)(
    'greet with empty name recovers the typed EmptyName via the decode helper',
    async () => {
      const recovered = await Effect.runPromise(
        callTyped(Greeter, 'greet', { name: '' }).pipe(
          Effect.map(() => 'unexpected-success' as const),
          Effect.catchTag('EmptyName', () => Effect.succeed('recovered-EmptyName' as const)),
          Effect.provide(ingressLayer),
        ),
      )
      expect(recovered).toBe('recovered-EmptyName')
    },
  )
})
