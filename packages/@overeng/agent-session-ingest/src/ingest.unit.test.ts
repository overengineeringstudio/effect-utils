import * as nodePath from 'node:path'

import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { readAppendOnlyTextFileSince } from './files/append-only.ts'
import { readMutableTextFileIfChanged } from './files/mutable.ts'

const TestLayer = NodeContext.layer

Vitest.describe('agent-session-ingest file readers', () => {
  Vitest.it.effect('resets append-only offsets after truncation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempDir = yield* fs.makeTempDirectoryScoped()
      const path = nodePath.join(tempDir, 'session.jsonl')

      yield* fs.writeFileString(path, 'one\ntwo\n')
      const first = yield* readAppendOnlyTextFileSince({ path, offsetBytes: 0 })
      expect(first.text).toBe('one\ntwo\n')

      yield* fs.writeFileString(path, 'three\n')
      const second = yield* readAppendOnlyTextFileSince({
        path,
        offsetBytes: first.nextOffsetBytes,
      })

      expect(second.resetToStart).toBe(true)
      expect(second.text).toBe('three\n')
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )

  Vitest.it.effect('can seed an append-only read from the tail on the first pass', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempDir = yield* fs.makeTempDirectoryScoped()
      const path = nodePath.join(tempDir, 'session.jsonl')

      yield* fs.writeFileString(path, 'old-line\nrecent-line\n')
      const result = yield* readAppendOnlyTextFileSince({
        path,
        offsetBytes: 0,
        initialReadMaxBytes: 12,
      })

      expect(result.text).toBe('recent-line\n')
      expect(result.nextOffsetBytes).toBeGreaterThan(0)
      expect(result.resetToStart).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )

  Vitest.it.effect('does not checkpoint past an incomplete trailing append-only fragment', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempDir = yield* fs.makeTempDirectoryScoped()
      const path = nodePath.join(tempDir, 'session.jsonl')

      yield* fs.writeFileString(path, '{"line":1}\n{"line":2')
      const first = yield* readAppendOnlyTextFileSince({ path, offsetBytes: 0 })
      expect(first.text).toBe('{"line":1}\n')
      expect(first.nextOffsetBytes).toBe(Buffer.byteLength('{"line":1}\n'))

      yield* fs.writeFileString(path, '{"line":1}\n{"line":2}\n')
      const second = yield* readAppendOnlyTextFileSince({
        path,
        offsetBytes: first.nextOffsetBytes,
        previousContentVersion: first.contentVersion,
      })
      expect(second.text).toBe('{"line":2}\n')
      expect(second.resetToStart).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )

  Vitest.it.effect('detects mutable file changes from content version', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempDir = yield* fs.makeTempDirectoryScoped()
      const path = nodePath.join(tempDir, 'state.json')

      yield* fs.writeFileString(path, '{"value":1}')
      const first = yield* readMutableTextFileIfChanged({ path, previous: undefined })
      expect(first.changed).toBe(true)

      const second = yield* readMutableTextFileIfChanged({
        path,
        previous: { _tag: 'ContentVersionCursor', contentVersion: first.contentVersion },
      })
      expect(second.changed).toBe(false)

      yield* fs.writeFileString(path, '{"value":2}')
      const third = yield* readMutableTextFileIfChanged({
        path,
        previous: { _tag: 'ContentVersionCursor', contentVersion: first.contentVersion },
      })
      expect(third.changed).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )

  Vitest.it.effect('resets append-only offsets after a non-truncating rewrite', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempDir = yield* fs.makeTempDirectoryScoped()
      const path = nodePath.join(tempDir, 'session.jsonl')
      const firstPrefix = 'a'.repeat(640)
      const secondPrefix = 'b'.repeat(640)

      yield* fs.writeFileString(path, `${firstPrefix}\nalpha\nbeta\n`)
      const first = yield* readAppendOnlyTextFileSince({ path, offsetBytes: 0 })

      yield* fs.writeFileString(path, `${secondPrefix}\ngamma\ndelta\n`)
      const second = yield* readAppendOnlyTextFileSince({
        path,
        offsetBytes: first.nextOffsetBytes,
        previousContentVersion: first.contentVersion,
      })

      expect(second.resetToStart).toBe(true)
      expect(second.text).toBe(`${secondPrefix}\ngamma\ndelta\n`)
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )
})
