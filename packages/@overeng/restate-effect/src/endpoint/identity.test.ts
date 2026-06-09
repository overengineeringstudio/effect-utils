/**
 * Server-free assertion that the request-identity public keys (decision 0016,
 * spec §8) reach the SDK endpoint builder. The endpoint `layer` is a thin
 * pass-through: it threads `EndpointOptions.identityKeys` into
 * `createEndpointHandler({ identityKeys })`, which the SDK forwards to
 * `endpoint.withIdentityV1(...)` — limiting inbound requests to a Restate cluster
 * holding the matching private key. We mock `createEndpointHandler` to capture the
 * options it receives (a real verification handshake belongs to the integration
 * lane), then build the layer into a closed scope.
 */
import * as restateNode from '@restatedev/restate-sdk/node'
import { Effect, Layer, Schema } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RestateService } from '../authoring/Service.ts'
import { layer } from './Endpoint.ts'

/* Capture the options each `createEndpointHandler` call receives, then return a
 * no-op handler so the http2 server can be created/listened/closed in the scope. */
const captured: Array<{ identityKeys?: ReadonlyArray<string> }> = []
vi.mock('@restatedev/restate-sdk/node', async (importOriginal) => {
  const actual = await importOriginal<typeof restateNode>()
  return {
    ...actual,
    createEndpointHandler: (options: { identityKeys?: ReadonlyArray<string> }) => {
      captured.push(options)
      return (() => {}) as ReturnType<typeof actual.createEndpointHandler>
    },
  }
})

const Greet = Schema.Struct({ name: Schema.String })
const GreeterLive = RestateService.define(
  'Greeter',
  { greet: { input: Greet, success: Schema.String } },
  { greet: () => Effect.succeed('hi') },
)

/* A public key in the SDK's documented `publickeyv1_…` format (value irrelevant —
 * we only assert it is threaded, not that it verifies). */
const IDENTITY_KEY = 'publickeyv1_2G8dCQhArfvGpzPw5Vx2ALciR4xCLHfS5YaT93XjNxX9'

/* Build an endpoint layer into a scope and release it immediately (acquire listens
 * on port 0; the finalizer closes the server). The captured options are the
 * assertion. */
const buildAndRelease = (built: Layer.Layer<never, unknown, never>): Promise<void> =>
  Effect.runPromise(Effect.scoped(Layer.build(built)).pipe(Effect.asVoid) as Effect.Effect<void>)

describe('request-identity keys (decision 0016)', () => {
  beforeEach(() => {
    captured.length = 0
  })

  it('threads EndpointOptions.identityKeys into createEndpointHandler', async () => {
    await buildAndRelease(layer({ services: [GreeterLive], port: 0, identityKeys: [IDENTITY_KEY] }))
    expect(captured).toHaveLength(1)
    expect(captured[0]!.identityKeys).toStrictEqual([IDENTITY_KEY])
  })

  it('omits identityKeys when none are configured', async () => {
    await buildAndRelease(layer({ services: [GreeterLive], port: 0 }))
    expect(captured).toHaveLength(1)
    expect(captured[0]!.identityKeys).toBeUndefined()
  })
})
