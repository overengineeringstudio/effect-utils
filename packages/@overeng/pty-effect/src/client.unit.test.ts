import { EventEmitter } from 'node:events'

import { Effect, Exit, Fiber } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('PtyClient interruption', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unmock('@myobie/pty/client')
    vi.unmock('node:child_process')
  })

  it('kills a pending daemon spawn on interruption without mutating process.env', async () => {
    const stderr = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const child = Object.assign(new EventEmitter(), {
      stderr,
      kill: vi.fn(),
      unref: vi.fn(),
      pid: 123,
    })
    const spawn = vi.fn(() => child)

    vi.doMock('node:child_process', () => ({ spawn }))
    vi.doMock('@myobie/pty/client', () => ({
      SessionConnection: class extends EventEmitter {},
      getSocketPath: vi.fn(() => '/definitely-missing-socket'),
      listSessions: vi.fn(async () => []),
      peekScreen: vi.fn(),
      validateName: vi.fn(),
    }))

    const { PtyClient, layer } = await import('./client.ts')
    const previous = process.env.PTY_EFFECT_TEST_VALUE

    try {
      delete process.env.PTY_EFFECT_TEST_VALUE

      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* PtyClient
          return yield* client.spawnDaemon({
            name: 'unit-spawn' as never,
            command: 'sh',
            args: ['-c', 'sleep 30'],
            env: { PTY_EFFECT_TEST_VALUE: 'from-test' },
          })
        }).pipe(Effect.provide(layer), Effect.timeout('50 millis'), Effect.exit),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(spawn).toHaveBeenCalledTimes(1)
      const spawnCalls = spawn.mock.calls as unknown as Array<
        readonly [string, ReadonlyArray<string>, { readonly env?: Record<string, string> }]
      >
      expect(spawnCalls[0]?.[2].env?.PTY_EFFECT_TEST_VALUE).toBe('from-test')
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(process.env.PTY_EFFECT_TEST_VALUE).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.PTY_EFFECT_TEST_VALUE
      else process.env.PTY_EFFECT_TEST_VALUE = previous
    }
  })

  it('disconnects a pending attach when interrupted', async () => {
    const disconnect = vi.fn()

    class MockSessionConnection extends EventEmitter {
      readonly connect = vi.fn(() => new Promise<string>(() => {}))
      readonly disconnect = disconnect
      readonly write = vi.fn()
      readonly press = vi.fn()
      readonly resize = vi.fn()

      constructor(_: unknown) {
        super()
      }
    }

    vi.doMock('@myobie/pty/client', () => ({
      SessionConnection: MockSessionConnection,
      getSocketPath: vi.fn(),
      listSessions: vi.fn(async () => []),
      peekScreen: vi.fn(),
      validateName: vi.fn(),
    }))

    const { PtyClient, layer } = await import('./client.ts')

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* PtyClient
              return yield* client.attach({
                name: 'unit-attach' as never,
                size: { rows: 24, cols: 80 },
              })
            }).pipe(Effect.provide(layer)),
          ),
        )

        yield* Effect.sleep('50 millis')
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(disconnect).toHaveBeenCalled()
  })
})
