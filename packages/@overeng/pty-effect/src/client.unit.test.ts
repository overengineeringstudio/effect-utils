import { EventEmitter } from 'node:events'

import { Effect } from 'effect'
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

  it('uses the PTY server module under node when running inside Bun', async () => {
    const originalBun = process.versions.bun
    const originalNodeBin = process.env.NODE_BIN
    const waitForSocket = vi.fn(async (_name: string, _timeoutMs: number, earlyCheck?: () => void) => {
      earlyCheck?.()
    })
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stderr: Object.assign(new EventEmitter(), { unref: vi.fn() }),
      unref: vi.fn(),
    })
    const spawn = vi.fn(() => child)

    vi.doMock('@myobie/pty/client', () => makeClientMock({ waitForSocket }))
    vi.doMock('node:child_process', () => ({ spawn }))

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
            env: { PTY_EFFECT_TEST_VALUE: 'from-bun-test' },
            tags: { owner: 'forge' },
            size: { rows: 40, cols: 120 },
          })
        }).pipe(Effect.provide(layer)),
      )

      expect(result).toBeUndefined()
      expect(spawn).toHaveBeenCalledTimes(1)
      const firstCall = spawn.mock.calls.at(0) as ReadonlyArray<unknown> | undefined
      expect(firstCall).toBeDefined()
      if (firstCall === undefined) throw new Error('missing spawn call')
      const command = firstCall[0]
      const args = firstCall[1]
      const options = firstCall[2]
      if (typeof command !== 'string') throw new Error('expected spawn command')
      if (!Array.isArray(args)) throw new Error('expected spawn args')
      if (options === null || typeof options !== 'object') throw new Error('expected spawn options')
      expect(command).toBe('node-from-test')
      expect(args).toHaveLength(1)
      const serverArg = args[0]
      expect(serverArg).toBeDefined()
      if (typeof serverArg !== 'string') throw new Error('expected server module path')
      expect(serverArg).toContain('@myobie/pty')
      const spawnOptions = options as {
        readonly detached: boolean
        readonly stdio: ReadonlyArray<string>
        readonly env: Record<string, string>
      }
      expect(spawnOptions.detached).toBe(true)
      expect(spawnOptions.stdio).toEqual(['ignore', 'ignore', 'pipe'])
      expect(spawnOptions.env.PTY_EFFECT_TEST_VALUE).toBe('from-bun-test')
      const rawConfig = spawnOptions.env.PTY_SERVER_CONFIG
      expect(rawConfig).toBeDefined()
      if (rawConfig === undefined) throw new Error('expected PTY_SERVER_CONFIG')
      const config = JSON.parse(rawConfig)
      expect(config).toEqual({
        name: 'unit-bun',
        command: 'sh',
        args: ['-c', 'true'],
        displayCommand: 'shell test',
        cwd: '/tmp',
        rows: 40,
        cols: 120,
        ephemeral: false,
        tags: { owner: 'forge' },
      })
      expect(waitForSocket).toHaveBeenCalledWith('unit-bun', 3_000, expect.any(Function))
    } finally {
      vi.unmock('node:child_process')
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
