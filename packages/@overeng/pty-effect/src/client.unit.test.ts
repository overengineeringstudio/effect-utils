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
})
