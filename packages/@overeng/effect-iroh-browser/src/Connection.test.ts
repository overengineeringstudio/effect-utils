import { describe, expect, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'

import { fromFramed } from './Connection.ts'
import { ConnectionError } from './errors.ts'
import { connPair } from './testing.ts'

describe('Connection', () => {
  it.effect('preserves the authenticated remote and framed payload until remote close', () =>
    Effect.gen(function* () {
      const [local, remote] = connPair({ a: 'aaaa', b: 'bbbb' })
      const conn = fromFramed(local)
      expect(conn.remoteId).toBe('bbbb')
      const payload = new Uint8Array([1, 2, 3])
      yield* Effect.promise(() => remote.send(payload))
      remote.close()
      const frames = yield* Stream.runCollect(conn.frames)
      expect(Array.from(frames)).toEqual([payload])
      yield* conn.close
      expect(local.closed).toBe(true)
    }),
  )

  it.effect('reports failed sends as ConnectionError', () =>
    Effect.gen(function* () {
      const [local] = connPair({ a: 'aaaa', b: 'bbbb' })
      const conn = fromFramed(local)
      yield* conn.close
      expect(yield* Effect.flip(conn.send(new Uint8Array()))).toBeInstanceOf(ConnectionError)
    }),
  )
})
