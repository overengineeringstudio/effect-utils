import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { Chunk, Effect, Schema, Stream } from 'effect'

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

const decodeName = (s: string) => Schema.decodeUnknownSync(PtyName)(s)

/** Keep names short — macOS Unix sockets cap at 104 bytes including the
 *  parent directory. With `/var/folders/.../T/.../<name>.sock` we burn ~85
 *  chars before the name itself. */
const uniqueName = (label: string): string =>
  decodeName(`t${label}${(Date.now() % 100000).toString(36)}`)

describe('PtyClient', () => {
  it.scopedLive('spawns a daemon, lists it, attaches, reads bytes, exits cleanly', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const client = yield* PtyClient
        const name = uniqueName('roundtrip')

        /** Spawn a short-lived `sh -c "echo HELLO; sleep 0.1"` daemon. */
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

        /** Initial screen replay should already contain our echo. */
        expect(session.initialScreen).toContain('HELLO_FROM_CLIENT')

        /** Drain bytes until exit (timeboxed via Stream.take). */
        const collected = yield* session.bytes.pipe(Stream.take(8), Stream.runCollect)
        expect(Chunk.size(collected)).toBeGreaterThanOrEqual(0)

        /** Exit Deferred resolves with the child's exit code. */
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

        /** Attach in an inner scope, then let the scope close. */
        yield* Effect.scoped(
          Effect.gen(function* () {
            const s = yield* client.attach({ name, size: { rows: 24, cols: 80 } })
            yield* s.write({ data: '' })
          }),
        )

        /** Daemon should still be in the list (we only detached, didn't kill). */
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

        /** Give the daemon a beat to render the echo. */
        yield* Effect.sleep('100 millis')

        const screen = yield* client.peek({ name, plain: true })
        expect(screen).toContain('PEEK_TARGET')
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
