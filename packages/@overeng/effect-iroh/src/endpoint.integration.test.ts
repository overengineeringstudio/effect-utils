import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber, Layer, Schema, Stream } from 'effect'

import { echoAlpn, roundTrip } from './echo.ts'
import { IrohEndpoint } from './mod.ts'
const nativeLibraryPath = process.env.IROH_NATIVE_LIBRARY_PATH
const nativeOptions = nativeLibraryPath === undefined ? {} : { nativeLibraryPath }

// Real sockets/native code: no mocked transport and no test-clock timing claims.
describe('iroh native QUIC', () => {
  it.live('exchanges versioned Schema messages over a bidirectional stream', () => Effect.gen(function* () {
    const result = yield* roundTrip(nativeOptions)
    expect(result.received).toEqual(result.requests)
    expect(result.responses).toEqual(result.requests.map((request) => ({
      ...request, payload: { ...request.payload, _tag: 'Pong' },
    })))
    expect(result.clientId).not.toBe(result.serverId)
    expect(result.selectedPath?.isIp).toBe(true)
    expect(result.selectedPath?.isRelay).toBe(false)
    yield* Effect.log('iroh e2e evidence', result)
  }).pipe(Effect.timeout('20 seconds')), 25_000)

  it.live('scoped Layer binds and interruption quiesces a pending native accept', () => Effect.gen(function* () {
    const context = yield* Layer.build(IrohEndpoint.layer({ ...nativeOptions, alpns: [echoAlpn], preset: 'minimal' }))
    const service = yield* IrohEndpoint.pipe(Effect.provideContext(context))
    expect((yield* service.address).id.length).toBeGreaterThan(0)
    const accepting = yield* service.accept.pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(accepting)
    expect(yield* service.accept).toBeUndefined()
  }).pipe(Effect.timeout('10 seconds')), 15_000)
  it.live('rejects an oversized frame before allocating or reading its payload', () => Effect.gen(function* () {
    const server = yield* IrohEndpoint.make({ ...nativeOptions, alpns: [echoAlpn], preset: 'minimal' })
    const client = yield* IrohEndpoint.make({ ...nativeOptions, alpns: [echoAlpn], preset: 'minimal' })
    const incoming = yield* server.accept.pipe(Effect.forkScoped)
    const connection = yield* client.connect(yield* server.address, echoAlpn)
    const send = yield* connection.openBi
    const accepted = yield* Fiber.join(incoming)
    if (accepted === undefined) return yield* Effect.die('Expected incoming connection')
    const receive = yield* accepted.acceptBi.pipe(Effect.forkScoped)
    yield* Stream.make(new Uint8Array([0, 0, 4, 0])).pipe(Stream.run(send.write))
    const bi = yield* Fiber.join(receive)
    const result = yield* Stream.runCollect(bi.messages(Schema.String, { maxFrameBytes: 32 }).read).pipe(Effect.result)
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure._tag).toBe('IrohProtocolError')
  }).pipe(Effect.timeout('10 seconds')), 15_000)
})
