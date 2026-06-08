/**
 * End-to-end integration test against a real native `restate-server`.
 *
 * Proves the POC architecture pillars through one service vertical slice:
 * Schema I/O, app-service injection via a Layer, a per-invocation Effect
 * runtime boundary, a durable `ctx.run` step, the endpoint as a scoped
 * (graceful-shutdown) Layer, and tagged-error → TerminalError mapping.
 */
import { execFileSync } from 'node:child_process'

import type * as restate from '@restatedev/restate-sdk'
import * as clients from '@restatedev/restate-sdk-clients'
import { Context, Effect, Exit, Layer, Schema, Scope } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { serverBin, startRestateServer, type RestateServerHandle } from '../test/restate-server.ts'
import { layer, RestateContext, RestateService } from './mod.ts'

/* ── demo app: an injected Effect service + a greeter Restate service ── */

class Greeting extends Context.Tag('test/Greeting')<Greeting, { readonly prefix: string }>() {
  static readonly Default = Layer.succeed(Greeting, { prefix: 'Hello' })
}

class EmptyName extends Schema.TaggedError<EmptyName>('test/EmptyName')('EmptyName', {}) {}

const GreetInput = Schema.Struct({ name: Schema.String })
const GreetSuccess = Schema.Struct({ message: Schema.String, id: Schema.String })

const greeter = RestateService.make('greeter', {
  greet: RestateService.handler({
    input: GreetInput,
    success: GreetSuccess,
    error: EmptyName,
    run: ({ name }) =>
      Effect.gen(function* () {
        if (name === '') return yield* new EmptyName({})
        const prefix = (yield* Greeting).prefix
        /* A failed durable step is infrastructure-transient → turn the wrapper
         * `RestateError` into a defect so it leaves the domain `E` channel
         * (which is only `EmptyName`) and the SDK retries it. */
        const id = yield* RestateContext.run(
          'gen-id',
          Effect.sync(() => crypto.randomUUID()),
        ).pipe(Effect.orDie)
        return { message: `${prefix} ${name}`, id }
      }),
  }),
})

/* Client-side phantom service definition for the typed ingress client. The
 * SDK derives client args from the handler shape `(ctx, input) => Promise<O>`. */
type GreeterApi = {
  greet: (ctx: restate.Context, input: typeof GreetInput.Type) => Promise<typeof GreetSuccess.Type>
}
const greeterDefinition: restate.ServiceDefinition<'greeter', GreeterApi> = { name: 'greeter' }

/* ── harness ── */

const SDK_PORT = 9080

const serverAvailable = (() => {
  try {
    execFileSync(serverBin(), ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('restate-effect end-to-end', () => {
  let server: RestateServerHandle
  let endpointScope: Scope.CloseableScope
  let ingress: clients.Ingress

  beforeAll(async () => {
    if (!serverAvailable) return
    server = await startRestateServer()

    /* Launch the endpoint layer in a scope we hold open; the finalizer closes
     * the HTTP/2 server in afterAll. */
    endpointScope = await Effect.runPromise(Scope.make())
    await Effect.runPromise(
      Layer.buildWithScope(layer({ services: [greeter], port: SDK_PORT }), endpointScope).pipe(
        Effect.provide(Greeting.Default),
      ),
    )

    await server.register(`http://localhost:${SDK_PORT}`)
    ingress = clients.connect({ url: server.ingressUrl })
  }, 60_000)

  afterAll(async () => {
    if (!serverAvailable) return
    if (endpointScope !== undefined) {
      await Effect.runPromise(Scope.close(endpointScope, Exit.void))
    }
    if (server !== undefined) await server.shutdown()
  }, 60_000)

  it.skipIf(!serverAvailable)('greet returns the prefixed message + a uuid', async () => {
    const result = await ingress.serviceClient(greeterDefinition).greet({ name: 'Sarah' })
    expect(result.message).toBe('Hello Sarah')
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it.skipIf(!serverAvailable)(
    'greet with empty name surfaces a terminal EmptyName error',
    async () => {
      let error: unknown
      try {
        await ingress.serviceClient(greeterDefinition).greet({ name: '' })
        expect.unreachable('expected the empty-name call to reject')
      } catch (e) {
        error = e
      }

      expect(error).toBeInstanceOf(clients.HttpCallError)
      const httpErr = error as clients.HttpCallError
      /* Domain failure mapped to a non-retryable terminal error (errorCode 500),
       * the encoded body carrying the EmptyName tag. */
      expect(httpErr.status).toBe(500)
      expect(httpErr.responseText).toContain('EmptyName')
    },
  )
})
