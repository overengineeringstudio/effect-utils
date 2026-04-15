import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { Chunk, Effect, Fiber, Schema, Stream } from 'effect'

import { PtyClient, layer as ptyClientLayer } from './client.ts'
import { PtyName } from './PtySpec.ts'

/** Per-test isolated `PTY_SESSION_DIR` so daemons can't collide. */
const withIsolatedDir = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-effect-client-test-'))
    const prev = process.env.PTY_SESSION_DIR
    process.env.PTY_SESSION_DIR = dir
    try {
      return yield* eff
    } finally {
      if (prev === undefined) delete process.env.PTY_SESSION_DIR
      else process.env.PTY_SESSION_DIR = prev
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  })

const withTempDir = <A>(prefix: string, f: (dir: string) => A) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  try {
    return f(dir)
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}

const decodeName = (s: string) => Schema.decodeUnknownSync(PtyName)(s) as PtyName

/** Keep names short — macOS Unix sockets cap at 104 bytes including the
 *  parent directory. With `/var/folders/.../T/.../<name>.sock` we burn ~85
 *  chars before the name itself. */
const uniqueName = (label: string): PtyName =>
  decodeName(`t${label}${(Date.now() % 100000).toString(36)}`)

describe('PtyClient', () => {
  it('keeps @overeng/pty-effect/client compile-safe for Bun-built CLIs', () => {
    withTempDir('pty-effect-bun-compile-', (dir) => {
      const entryPath = path.join(dir, 'main.ts')
      const outPath = path.join(dir, 'main')
      const clientModulePath = new URL('./client.ts', import.meta.url).pathname

      fs.writeFileSync(
        entryPath,
        [`import ${JSON.stringify(clientModulePath)}`, `console.log('client-module-ok')`, ''].join(
          '\n',
        ),
      )

      execFileSync('bun', ['build', entryPath, '--compile', '--outfile', outPath], {
        cwd: dir,
        stdio: 'pipe',
      })

      const stdout = execFileSync(outPath, [], { encoding: 'utf8' })
      expect(stdout.trim()).toBe('client-module-ok')
    })
  })

  it.scopedLive('spawns a daemon, lists it, attaches, reads bytes, exits cleanly', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('roundtrip')

        yield* client.spawnDaemon({
          name: decodeName(name),
          command: 'sh',
          args: ['-c', 'echo HELLO_FROM_CLIENT && sleep 0.05'],
        })

        const sessions = yield* client.list
        expect(sessions.some((s) => s.name === name)).toBe(true)
        expect(yield* client.exists({ name })).toBe(true)

        const session = yield* client.attach({
          name,
          size: { rows: 24, cols: 80 },
        })

        expect(session.initialScreen).toContain('HELLO_FROM_CLIENT')

        const collected = yield* session.bytes.pipe(Stream.take(8), Stream.runCollect)
        expect(Chunk.size(collected)).toBeGreaterThanOrEqual(0)

        const exit = yield* session.exit.pipe(Effect.timeout('2 seconds'))
        expect(exit.code).toBe(0)
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )

  it.scopedLive('attach is scope-bound: closing scope detaches but daemon survives', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('detach')

        yield* client.spawnDaemon({
          name: decodeName(name),
          command: 'sh',
          args: ['-c', 'sleep 1'],
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            const s = yield* client.attach({ name, size: { rows: 24, cols: 80 } })
            yield* s.write({ data: '' })
          }),
        )

        const stillThere = yield* client.exists({ name })
        expect(stillThere).toBe(true)
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )

  it.scopedLive('peek returns current screen without side effects', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('peek')

        yield* client.spawnDaemon({
          name: decodeName(name),
          command: 'sh',
          args: ['-c', 'echo PEEK_TARGET && sleep 0.5'],
        })

        yield* Effect.sleep('100 millis')

        const screen = yield* client.peek({ name, plain: true })
        expect(screen).toContain('PEEK_TARGET')
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )

  it.scopedLive('passes env overrides to the daemon without mutating the parent env', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('env')
        const marker = `marker-${Date.now().toString(36)}`
        const previous = process.env.PTY_EFFECT_TEST_VALUE

        try {
          delete process.env.PTY_EFFECT_TEST_VALUE

          yield* client.spawnDaemon({
            name,
            command: 'sh',
            args: ['-c', 'echo "ENV:$PTY_EFFECT_TEST_VALUE" && sleep 0.05'],
            env: { PTY_EFFECT_TEST_VALUE: marker },
          })

          expect(process.env.PTY_EFFECT_TEST_VALUE).toBeUndefined()

          const session = yield* client.attach({
            name,
            size: { rows: 24, cols: 80 },
          })

          expect(session.initialScreen).toContain(`ENV:${marker}`)
        } finally {
          if (previous === undefined) delete process.env.PTY_EFFECT_TEST_VALUE
          else process.env.PTY_EFFECT_TEST_VALUE = previous
        }
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )

  it.scopedLive('exposes get, tag mutation, gc, and live event following', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('tags')

        const startEvents = yield* Effect.forkScoped(
          client.followEvents({}).pipe(
            Stream.filter((event) => event.session === name),
            Stream.take(1),
            Stream.runCollect,
          ),
        )

        yield* client.spawnDaemon({
          name,
          command: 'sh',
          args: ['-c', 'sleep 0.2'],
          tags: {
            'forge.tab': 'tab-1',
            'forge.workspace': 'ws-1',
          },
        })

        const initial = yield* client.get({ name })
        expect(initial?.name).toBe(name)
        expect(initial?.metadata?.tags).toEqual({
          'forge.tab': 'tab-1',
          'forge.workspace': 'ws-1',
        })

        yield* client.updateTags({
          name,
          tags: {
            'forge.extra': '1',
            'forge.tab': 'tab-2',
          },
          removals: ['forge.workspace'],
        })

        const updated = yield* client.get({ name })
        expect(updated?.metadata?.tags).toEqual({
          'forge.extra': '1',
          'forge.tab': 'tab-2',
        })

        const seenStartEvents = yield* Fiber.join(startEvents)
        const [startEvent] = Array.from(seenStartEvents)
        expect(startEvent?.type).toBe('session_start')
        if (startEvent?.type === 'session_start') {
          expect(startEvent.tags).toEqual({
            'forge.tab': 'tab-1',
            'forge.workspace': 'ws-1',
          })
        }

        const session = yield* client.attach({
          name,
          size: { rows: 24, cols: 80 },
        })
        const exit = yield* session.exit.pipe(Effect.timeout('2 seconds'))
        expect(exit.code).toBe(0)

        yield* Effect.sleep('100 millis')
        const recent = yield* client.readRecentEvents({ name, count: 10 })
        expect(recent.some((event) => event.type === 'session_start')).toBe(true)
        expect(recent.some((event) => event.type === 'session_exit')).toBe(true)

        const removed = yield* client.gc
        expect(removed).toContain(name)
        expect(yield* client.exists({ name })).toBe(false)
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )

  it.scopedLive('supports sendData, queryStats, and recent event reads', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('send')

        yield* client.spawnDaemon({
          name,
          command: 'sh',
          args: [],
        })

        const session = yield* client.attach({
          name,
          size: { rows: 24, cols: 80 },
        })

        const stats = yield* client.queryStats({ name, timeoutMs: 1_000 })
        expect(stats.name).toBe(name)
        expect(stats.process.alive).toBe(true)
        expect(stats.process.pid).not.toBeNull()

        yield* client.sendData({
          name,
          data: ['printf "SEND_OK\\n"\r', 'exit\r'],
          delayMs: 5,
        })

        const echoed = yield* session
          .waitForText({ needle: 'SEND_OK' })
          .pipe(Effect.timeout('2 seconds'))
        expect(echoed.text).toContain('SEND_OK')

        const exit = yield* session.exit.pipe(Effect.timeout('2 seconds'))
        expect(exit.code).toBe(0)

        yield* Effect.sleep('100 millis')
        const recent = yield* client.readRecentEvents({ name, count: 10 })
        const eventTypes = Array.from(recent, (event) => event.type)
        expect(eventTypes).toContain('session_start')
        expect(eventTypes).toContain('session_exit')
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )

  it.scopedLive('rejects invalid session names with BadName', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const result = yield* client
          .spawnDaemon({
            // @ts-expect-error — bypass branded type to test runtime validation
            name: 'has spaces',
            command: 'sh',
            args: ['-c', 'true'],
          })
          .pipe(Effect.either)
        expect(result._tag).toBe('Left')
        if (result._tag === 'Left') expect(result.left.reason).toBe('BadName')
      }).pipe(Effect.provide(ptyClientLayer)),
    ),
  )
})
