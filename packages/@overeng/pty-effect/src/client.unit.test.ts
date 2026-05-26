import { EventEmitter } from 'node:events'

import { Effect, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const makeClientMock = (overrides: Record<string, unknown> = {}) => ({
  EventFollower: class {
    readonly start = vi.fn()
    readonly stop = vi.fn()
  },
  SessionConnection: class extends EventEmitter {},
  gc: vi.fn(async () => []),
  getSession: vi.fn(async () => null),
  listSessions: vi.fn(async () => []),
  peekScreen: vi.fn(async () => ''),
  queryStats: vi.fn(async () => ({
    clients: { attached: 0, readOnly: 0, total: 0 },
    createdAt: null,
    daemon: { pid: 1, resources: null },
    modes: { cursorHidden: false, kittyKeyboard: false, kittyKeyboardFlags: [], sgrMouse: false },
    name: 'unit',
    process: { alive: true, exitCode: null, pid: 1, resources: null },
    terminal: {
      cols: 80,
      cursorX: 0,
      cursorY: 0,
      rows: 24,
      scrollbackCapacity: 1_000,
      scrollbackUsed: 0,
    },
    uptimeSeconds: 1,
  })),
  readRecentEvents: vi.fn(() => []),
  waitForSocket: vi.fn(async () => undefined),
  sendData: vi.fn(async () => undefined),
  spawnDaemon: vi.fn(async () => undefined),
  updateTags: vi.fn(() => undefined),
  validateName: vi.fn(),
  ...overrides,
})

describe('PtyClient client wrapper', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unmock('@myobie/pty/client')
  })

  it('passes env overrides through upstream spawnDaemon and restores process.env on success', async () => {
    let envInsideSpawn: string | undefined
    const spawnDaemon = vi.fn(async () => {
      envInsideSpawn = process.env.PTY_EFFECT_TEST_VALUE
    })

    vi.doMock('@myobie/pty/client', () => makeClientMock({ spawnDaemon }))

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
            args: ['-c', 'true'],
            env: { PTY_EFFECT_TEST_VALUE: 'from-test' },
          })
        }).pipe(Effect.provide(layer)),
      )

      expect(exit).toBeUndefined()
      expect(spawnDaemon).toHaveBeenCalledTimes(1)
      expect(envInsideSpawn).toBe('from-test')
      expect(process.env.PTY_EFFECT_TEST_VALUE).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.PTY_EFFECT_TEST_VALUE
      else process.env.PTY_EFFECT_TEST_VALUE = previous
    }
  })

  it('restores process.env when upstream spawnDaemon fails', async () => {
    let envInsideSpawn: string | undefined
    const spawnDaemon = vi.fn(async () => {
      envInsideSpawn = process.env.PTY_EFFECT_TEST_VALUE
      throw new Error('boom')
    })

    vi.doMock('@myobie/pty/client', () => makeClientMock({ spawnDaemon }))

    const { PtyClient, layer } = await import('./client.ts')
    const previous = process.env.PTY_EFFECT_TEST_VALUE

    try {
      delete process.env.PTY_EFFECT_TEST_VALUE

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* PtyClient
          return yield* client.spawnDaemon({
            name: 'unit-spawn-failure' as never,
            command: 'sh',
            args: ['-c', 'false'],
            env: { PTY_EFFECT_TEST_VALUE: 'from-test' },
          })
        }).pipe(Effect.provide(layer), Effect.either),
      )

      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left.reason).toBe('SpawnFailed')
        expect(result.left.message).toContain('boom')
      }
      expect(spawnDaemon).toHaveBeenCalledTimes(1)
      expect(envInsideSpawn).toBe('from-test')
      expect(process.env.PTY_EFFECT_TEST_VALUE).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.PTY_EFFECT_TEST_VALUE
      else process.env.PTY_EFFECT_TEST_VALUE = previous
    }
  })

  it('starts and stops EventFollower within followEvents', async () => {
    const start = vi.fn()
    const stop = vi.fn()

    vi.doMock('@myobie/pty/client', () =>
      makeClientMock({
        EventFollower: class {
          constructor(options: { readonly onEvent: (event: unknown) => void }) {
            this.options = options
          }

          readonly options
          readonly start = () => {
            start()
            this.options.onEvent({
              session: 'unit-follow',
              ts: new Date().toISOString(),
              type: 'session_exit',
              exitCode: 0,
            })
          }
          readonly stop = stop
        },
      }),
    )

    const { PtyClient, layer } = await import('./client.ts')

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* PtyClient
        return yield* client.followEvents({}).pipe(Stream.take(1), Stream.runCollect)
      }).pipe(Effect.provide(layer)),
    )

    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(Array.from(result)).toEqual([
      {
        session: 'unit-follow',
        ts: expect.any(String),
        type: 'session_exit',
        exitCode: 0,
      },
    ])
  })

  it('passes a Node launcher to upstream spawnDaemon when running inside Bun', async () => {
    const originalBun = process.versions.bun
    const originalNodeBin = process.env.NODE_BIN
    const spawnDaemon = vi.fn(async () => undefined)
    const getSession = vi.fn(async () => ({
      metadata: { tags: { owner: 'forge' } },
      name: 'unit-bun',
      pid: 1,
      socketPath: '/tmp/unit-bun.sock',
      status: 'running',
    }))

    vi.doMock('@myobie/pty/client', () => makeClientMock({ getSession, spawnDaemon }))

    Object.defineProperty(process.versions, 'bun', {
      configurable: true,
      value: '1.2.0',
    })
    process.env.NODE_BIN = 'node-from-test'

    try {
      const { PtyClient, layer } = await import('./client.ts')

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* PtyClient
          return yield* client.spawnDaemon({
            name: 'unit-bun' as never,
            command: 'sh',
            args: ['-c', 'true'],
            cwd: '/tmp',
            displayCommand: 'shell test',
            tags: { owner: 'forge' },
            size: { rows: 40, cols: 120 },
          })
        }).pipe(Effect.provide(layer)),
      )

      expect(result).toBeUndefined()
      expect(spawnDaemon).toHaveBeenCalledTimes(1)
      expect(spawnDaemon).toHaveBeenCalledWith({
        name: 'unit-bun',
        command: 'sh',
        args: ['-c', 'true'],
        displayCommand: 'shell test',
        cwd: '/tmp',
        rows: 40,
        cols: 120,
        tags: { owner: 'forge' },
        launcher: {
          command: 'node-from-test',
          args: ['--preserve-symlinks', '--preserve-symlinks-main'],
        },
      })
      expect(getSession).toHaveBeenCalledWith('unit-bun')
    } finally {
      if (originalBun === undefined) {
        delete process.versions.bun
      } else {
        Object.defineProperty(process.versions, 'bun', {
          configurable: true,
          value: originalBun,
        })
      }
      if (originalNodeBin === undefined) delete process.env.NODE_BIN
      else process.env.NODE_BIN = originalNodeBin
    }
  })
})
