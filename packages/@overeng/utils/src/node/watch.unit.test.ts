import * as path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import type { Cause } from 'effect'
import { Duration, Effect, FileSystem, Fiber, Option, Queue, Stream } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import { systemError } from 'effect/PlatformError'
import { TestClock } from 'effect/testing'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import {
  takeWatchWindow,
  watchCauseMessage,
  watchScoped,
  type WatchGroup,
  type WatchPendingEntry,
} from './watch.ts'

const drainBatches = (batches: Queue.Queue<ReadonlyArray<WatchGroup>>) =>
  Effect.gen(function* () {
    const first = yield* Queue.take(batches)
    // Retain batch boundaries: native delivery can span several coalescing windows.
    yield* Effect.sleep(Duration.millis(200))
    const rest: Array<ReadonlyArray<WatchGroup>> = []
    let next = yield* Queue.poll(batches)
    while (Option.isSome(next) === true) {
      rest.push(next.value)
      next = yield* Queue.poll(batches)
    }
    yield* Queue.shutdown(batches)
    return [first, ...rest]
  })

Vitest.describe('watchScoped', () => {
  Vitest.it.effect(
    'dedupes every event within its window without suppressing a later window',
    Effect.fnUntraced(function* () {
      const pending = yield* Queue.unbounded<WatchPendingEntry>()
      const emitted = yield* Queue.unbounded<ReadonlyArray<WatchGroup>>()
      const collect = takeWatchWindow({ pending, debounce: Duration.millis(100) }).pipe(
        Effect.tap((batch) => Queue.offer(emitted, batch)),
      )
      const created: FileSystem.WatchEvent = { _tag: 'Create', path: 'sub/deep.txt' }
      const updated: FileSystem.WatchEvent = { _tag: 'Update', path: 'sub/deep.txt' }
      const other: FileSystem.WatchEvent = { _tag: 'Create', path: 'other.txt' }
      const nestedPath = '/watch/sub/deep.txt'
      const first = yield* collect.pipe(Effect.forkChild)

      // No clock-only flush: the first event, not collector startup, opens a window.
      yield* TestClock.adjust('1 second')
      expect(Option.isNone(yield* Queue.poll(emitted))).toBe(true)
      yield* Queue.offer(pending, { absolutePath: nestedPath, event: created })
      yield* TestClock.adjust('99 millis')
      expect(Option.isNone(yield* Queue.poll(emitted))).toBe(true)
      yield* Queue.offer(pending, { absolutePath: nestedPath, event: updated })
      yield* Queue.offer(pending, { absolutePath: '/watch/other.txt', event: other })
      yield* TestClock.adjust('1 millis')
      expect(yield* Queue.take(emitted)).toEqual([
        { path: nestedPath, events: [created, updated] },
        { path: '/watch/other.txt', events: [other] },
      ])
      yield* Fiber.join(first)

      const second = yield* collect.pipe(Effect.forkChild)
      yield* Queue.offer(pending, { absolutePath: nestedPath, event: updated })
      yield* TestClock.adjust('99 millis')
      expect(Option.isNone(yield* Queue.poll(emitted))).toBe(true)
      yield* TestClock.adjust('1 millis')
      expect(yield* Queue.take(emitted)).toEqual([{ path: nestedPath, events: [updated] }])
      yield* Fiber.join(second)
    }),
  )

  Vitest.it.live(
    'watches nested paths recursively, filters scope, and dedupes each native batch',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectory()
        yield* fs.makeDirectory(path.join(root, 'sub'))

        const batches = yield* Queue.unbounded<ReadonlyArray<WatchGroup>>()
        const watcher = yield* watchScoped({
          roots: [root],
          scope: (absolutePath) => absolutePath.endsWith('.txt'),
          debounce: Duration.millis(100),
        }).pipe(
          Stream.runForEach((batch) => Queue.offer(batches, batch)),
          Effect.forkChild,
        )

        // Let the watcher settle before writing (fs.watch registration is
        // asynchronous; events fired before it lands are not delivered).
        yield* Effect.sleep(Duration.millis(200))

        const nestedFile = path.join(root, 'sub', 'deep.txt')
        const ignoredFile = path.join(root, 'notes.log')
        yield* fs.writeFileString(nestedFile, 'one')
        yield* fs.writeFileString(nestedFile, 'two')
        yield* fs.writeFileString(ignoredFile, 'ignored')

        const observed = yield* drainBatches(batches).pipe(Effect.timeout(Duration.seconds(10)))
        yield* Fiber.interrupt(watcher)
        yield* fs.remove(root, { recursive: true })

        const paths = observed.flat().map((group) => group.path)
        // Recursive: a change two levels deep is observed (the rc.111 default
        // non-recursive watch would never fire for it).
        expect(paths).toContain(nestedFile)
        // Scope predicate rejects out-of-scope paths.
        expect(paths).not.toContain(ignoredFile)
        // Native delivery may span windows; every window still dedupes its path.
        for (const batch of observed) {
          expect(batch.filter((group) => group.path === nestedFile)).toHaveLength(1)
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  Vitest.it.live(
    'supports set-based scopes across multiple roots',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const rootA = yield* fs.makeTempDirectory()
        const rootB = yield* fs.makeTempDirectory()

        const watchedFile = path.join(rootB, 'target.txt')
        const batches = yield* Queue.unbounded<ReadonlyArray<WatchGroup>>()
        const watcher = yield* watchScoped({
          roots: [rootA, rootB],
          scope: new Set([watchedFile]),
          debounce: Duration.millis(100),
        }).pipe(
          Stream.runForEach((batch) => Queue.offer(batches, batch)),
          Effect.forkChild,
        )

        yield* Effect.sleep(Duration.millis(200))

        yield* fs.writeFileString(path.join(rootA, 'other.txt'), 'noise')
        yield* fs.writeFileString(watchedFile, 'change')

        const observed = yield* drainBatches(batches).pipe(Effect.timeout(Duration.seconds(10)))
        yield* Fiber.interrupt(watcher)
        yield* fs.remove(rootA, { recursive: true })
        yield* fs.remove(rootB, { recursive: true })

        for (const batch of observed) {
          expect(batch.map((group) => group.path)).toEqual([watchedFile])
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  Vitest.it.live(
    'propagates watcher failures through the stream',
    Effect.fnUntraced(
      function* () {
        const real = yield* FileSystem.FileSystem
        const root = yield* real.makeTempDirectory()

        // Named override (repo cast rule): swap `watch` for a permanently
        // failing stream to exercise error propagation deterministically — on
        // Linux, deleting a watched directory just silences the watcher.
        const watchError = systemError({
          _tag: 'NotFound',
          module: 'node',
          method: 'watch',
          description: 'synthetic watch failure',
        })
        const fsWithFailingWatch: FileSystem.FileSystem = {
          ...real,
          watch: () => Stream.fail(watchError),
        }

        const outcome = yield* watchScoped({
          roots: [root],
          scope: () => true,
          debounce: Duration.millis(50),
        }).pipe(
          Stream.runDrain,
          Effect.exit,
          Effect.provideService(FileSystem.FileSystem, fsWithFailingWatch),
        )

        expect(outcome._tag).toBe('Failure')
        if (outcome._tag === 'Failure') {
          expect(watchCauseMessage(outcome.cause as Cause.Cause<PlatformError>)).toContain(
            'synthetic watch failure',
          )
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
