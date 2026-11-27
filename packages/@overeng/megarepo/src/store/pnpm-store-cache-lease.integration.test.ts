import { link, stat, symlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'
import { expect } from 'vitest'

import { withPnpmStoreCacheReadLease } from './git-writer-lock.ts'

const controlName = '.effect-utils-pnpm-store-cache-maintenance.lock'
const helper = fileURLToPath(new URL('../../../../../nix/devenv-modules/tasks/shared/pnpm-task-helpers.sh', import.meta.url))
const shell = `
set -euo pipefail
source "$1"
marker="$4"
: > "$marker.ready"
while [ ! -e "$marker.go" ]; do sleep 0.01; done
: > "$marker.attempted"
acquire_pnpm_store_cache_lease "$(command -v flock)" "$2" "$3" 30
: > "$marker.entered"
while [ ! -e "$marker.release" ]; do sleep 0.01; done
`

const awaitMarker = Effect.fn('test/store-cache-lease/awaitMarker')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  while ((yield* fs.exists(path)) === false) yield* Effect.sleep('10 millis')
}, Effect.timeout('60 seconds'))

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  const storeCacheRoot = `${root}/store`
  yield* fs.makeDirectory(storeCacheRoot)
  return { fs, root, storeCacheRoot, control: `${storeCacheRoot}/${controlName}` }
})

const startShell = Effect.fn('test/store-cache-lease/startShell')(function* ({
  storeCacheRoot, marker, mode,
}: { storeCacheRoot: string; marker: string; mode: 'shared' | 'exclusive' }) {
  const fs = yield* FileSystem.FileSystem
  yield* Effect.addFinalizer(() => Effect.all([
    fs.writeFileString(`${marker}.go`, ''),
    fs.writeFileString(`${marker}.release`, ''),
  ]).pipe(Effect.orDie))
  return yield* ChildProcess.make('bash', ['-c', shell, 'store-cache-test', helper, mode, storeCacheRoot, marker], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'inherit',
  })
})

const expectBlocked = Effect.fn('test/store-cache-lease/expectBlocked')(function* (marker: string) {
  const fs = yield* FileSystem.FileSystem
  yield* awaitMarker(`${marker}.attempted`)
  // Positive handshakes before and after bound this negative observation.
  yield* Effect.sleep('250 millis')
  expect(yield* fs.exists(`${marker}.entered`)).toBe(false)
})

describe('native Store Cache reader and canonical shell maintenance lease', { timeout: 120_000 }, () => {
  it.live('coexists with shell readers, excludes the actual shell writer, and preserves its control inode', () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const shared = `${f.root}/shared`
      const exclusive = `${f.root}/exclusive`
      // Processes belong to this outer scope, not the shorter reader scope.
      const reader = yield* startShell({ storeCacheRoot: f.storeCacheRoot, marker: shared, mode: 'shared' })
      const writer = yield* startShell({ storeCacheRoot: f.storeCacheRoot, marker: exclusive, mode: 'exclusive' })
      yield* awaitMarker(`${shared}.ready`)
      yield* awaitMarker(`${exclusive}.ready`)
      const before = yield* withPnpmStoreCacheReadLease(f)(Effect.gen(function* () {
        const held = yield* Effect.promise(() => stat(f.control))
        yield* f.fs.writeFileString(`${shared}.go`, '')
        yield* awaitMarker(`${shared}.entered`)
        yield* f.fs.writeFileString(`${exclusive}.go`, '')
        yield* expectBlocked(exclusive)
        yield* f.fs.writeFileString(`${shared}.release`, '')
        expect(yield* reader.exitCode).toBe(0)
        yield* expectBlocked(exclusive)
        return held
      }))
      yield* awaitMarker(`${exclusive}.entered`)
      yield* f.fs.writeFileString(`${exclusive}.release`, '')
      expect(yield* writer.exitCode).toBe(0)
      const after = yield* Effect.promise(() => stat(f.control))
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
      expect(yield* f.fs.readDirectory(f.storeCacheRoot)).toEqual([controlName])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.live('waits for the canonical exclusive owner before entering its callback', () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const marker = `${f.root}/writer`
      const writer = yield* startShell({ storeCacheRoot: f.storeCacheRoot, marker, mode: 'exclusive' })
      yield* f.fs.writeFileString(`${marker}.go`, '')
      yield* awaitMarker(`${marker}.entered`)
      const readerMarker = `${f.root}/reader`
      const reader = yield* Effect.forkScoped(Effect.gen(function* () {
        yield* f.fs.writeFileString(`${readerMarker}.attempted`, '')
        yield* withPnpmStoreCacheReadLease(f)(f.fs.writeFileString(`${readerMarker}.entered`, ''))
      }))
      yield* expectBlocked(readerMarker)
      yield* f.fs.writeFileString(`${marker}.release`, '')
      expect(yield* writer.exitCode).toBe(0)
      yield* Fiber.join(reader)
      expect(yield* f.fs.exists(`${readerMarker}.entered`)).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.live('releases after callback failure and interruption without unlinking admission', () =>
    Effect.gen(function* () {
      const f = yield* fixture
      expect(yield* withPnpmStoreCacheReadLease(f)(Effect.fail('callback-failure')).pipe(Effect.flip)).toBe('callback-failure')
      const before = yield* Effect.promise(() => stat(f.control))
      const first = `${f.root}/after-failure`
      const firstWriter = yield* startShell({ storeCacheRoot: f.storeCacheRoot, marker: first, mode: 'exclusive' })
      yield* f.fs.writeFileString(`${first}.go`, '')
      yield* awaitMarker(`${first}.entered`)
      yield* f.fs.writeFileString(`${first}.release`, '')
      expect(yield* firstWriter.exitCode).toBe(0)
      const held = `${f.root}/held`
      const reader = yield* Effect.forkScoped(withPnpmStoreCacheReadLease(f)(Effect.gen(function* () {
        yield* f.fs.writeFileString(held, '')
        yield* Effect.never
      })))
      yield* awaitMarker(held)
      const second = `${f.root}/after-interruption`
      const secondWriter = yield* startShell({ storeCacheRoot: f.storeCacheRoot, marker: second, mode: 'exclusive' })
      yield* f.fs.writeFileString(`${second}.go`, '')
      yield* expectBlocked(second)
      yield* Fiber.interrupt(reader)
      yield* awaitMarker(`${second}.entered`)
      yield* f.fs.writeFileString(`${second}.release`, '')
      expect(yield* secondWriter.exitCode).toBe(0)
      const after = yield* Effect.promise(() => stat(f.control))
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  for (const kind of ['missing', 'relative', 'symlink', 'hardlink', 'directory'] as const) {
    it.live(`refuses ${kind} admission without running the use effect or changing external bytes`, () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const outside = `${f.root}/outside`
        yield* f.fs.writeFileString(outside, 'untouched')
        if (kind === 'symlink') yield* Effect.promise(() => symlink(outside, f.control))
        if (kind === 'hardlink') yield* Effect.promise(() => link(outside, f.control))
        if (kind === 'directory') yield* f.fs.makeDirectory(f.control)
        const storeCacheRoot = kind === 'missing' ? `${f.root}/missing`
          : kind === 'relative' ? 'relative-store' : f.storeCacheRoot
        let entered = false
        const result = yield* withPnpmStoreCacheReadLease({ storeCacheRoot })(Effect.sync(() => { entered = true })).pipe(Effect.exit)
        expect(result._tag).toBe('Failure')
        expect(entered).toBe(false)
        expect(yield* f.fs.readFileString(outside)).toBe('untouched')
        if (kind === 'missing') expect(yield* f.fs.exists(storeCacheRoot)).toBe(false)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    )
  }
})
