import { open, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { inspectPoolBuckReset } from './store-pool-buck.ts'
import { poolBytes } from './store-pool-install.ts'
import { type PoolSlot, reserveFreshPoolRoot } from './store-pool-state.ts'

const withTestCtx = Vitest.makeWithTestCtx({ makeLayer: () => NodeServices.layer })
const temp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return { fs, path: yield* fs.realPath(yield* fs.makeTempDirectoryScoped()) }
})
// Real FS plus the actual fresh-reservation value producer. Not a Git/holder/reset qualification.
const slotFixture = Effect.gen(function* () {
  const { fs, path } = yield* temp
  const { slot } = yield* reserveFreshPoolRoot({
    state: { version: 1, maxSlots: 2, maxBytes: 1_000_000_000, slots: [] },
    bare: join(path, 'repo', '.bare'),
    commit: 'a'.repeat(40),
    charge: 1,
  })
  yield* fs.makeDirectory(slot.path, { recursive: true })
  return { fs, slot, buck: join(slot.path, 'buck-out'), outside: join(path, 'outside') }
})
const sparse = (path: string) =>
  Effect.acquireUseRelease(
    Effect.promise(() => open(path, 'w')),
    (file) => Effect.promise(() => file.truncate(4 * 1024 * 1024 + 3)),
    (file) => Effect.promise(() => file.close()),
  )

describe('pool byte accounting and bounded Buck observation', () => {
  it.effect(
    'reports exact logical bytes rather than rounding the directory and file to KiB',
    (test) =>
      Effect.gen(function* () {
        const { fs, path } = yield* temp
        const file = join(path, 'payload')
        yield* fs.writeFileString(file, 'abc')
        const expected = (yield* Effect.promise(() => stat(path))).size + 3
        expect(yield* poolBytes({ path, kind: 'logical' })).toBe(expected)
        expect(Number.isSafeInteger(yield* poolBytes({ path, kind: 'allocated' }))).toBe(true)
      }).pipe(withTestCtx(test)),
  )

  it.effect('distinguishes genuine sparse logical bytes from allocated blocks', (test) =>
    Effect.gen(function* () {
      const { path } = yield* temp
      yield* sparse(join(path, 'sparse'))
      const logical = yield* poolBytes({ path, kind: 'logical' })
      const allocated = yield* poolBytes({ path, kind: 'allocated' })
      expect(logical).toBeGreaterThanOrEqual(4 * 1024 * 1024 + 3)
      expect(allocated).toBeLessThan(logical)
    }).pipe(withTestCtx(test)),
  )

  it.effect(
    'does not charge an external symlink target as bytes inside the measured directory',
    (test) =>
      Effect.gen(function* () {
        const { fs, path } = yield* temp
        const root = join(path, 'measured')
        const outside = join(path, 'outside')
        yield* fs.makeDirectory(root)
        yield* sparse(outside)
        const link = join(root, 'link')
        yield* Effect.promise(() => symlink(outside, link))
        const rootSize = (yield* Effect.promise(() => stat(root))).size
        const linkSize = (yield* fs.lstat(link)).size
        expect(yield* poolBytes({ path: root, kind: 'logical' })).toBe(rootSize + Number(linkSize))
        expect(Number((yield* fs.stat(outside)).size)).toBe(4 * 1024 * 1024 + 3)
      }).pipe(withTestCtx(test)),
  )

  it.effect('observes a genuinely absent Buck directory without creating one', (test) =>
    Effect.gen(function* () {
      const { fs, slot, buck } = yield* slotFixture
      expect(yield* inspectPoolBuckReset({ slot, maxBytes: 15_000_000_000 })).toEqual({
        disposition: 'absent',
        logicalBytes: 0,
        allocatedBytes: 0,
        maxBytes: 15_000_000_000,
      })
      expect(yield* fs.exists(buck)).toBe(false)
    }).pipe(withTestCtx(test)),
  )

  it.effect(
    'uses both actual metrics, supports a zero wipe bound and never deletes observed state',
    (test) =>
      Effect.gen(function* () {
        const { fs, slot, buck } = yield* slotFixture
        yield* fs.makeDirectory(buck)
        const file = join(buck, 'artifact')
        yield* sparse(file)
        const retained = yield* inspectPoolBuckReset({ slot, maxBytes: 15_000_000_000 })
        expect(retained.disposition).toBe('within-bound')
        expect(retained.logicalBytes).toBeGreaterThan(retained.allocatedBytes)
        expect((yield* inspectPoolBuckReset({ slot, maxBytes: 1_000_000 })).disposition).toBe(
          'over-bound',
        )
        expect((yield* inspectPoolBuckReset({ slot, maxBytes: 0 })).disposition).toBe('over-bound')
        expect(Number((yield* fs.stat(file)).size)).toBe(4 * 1024 * 1024 + 3)
      }).pipe(withTestCtx(test)),
  )

  it.effect('refuses a symlinked Buck directory and leaves its external target unchanged', (test) =>
    Effect.gen(function* () {
      const { fs, slot, buck, outside } = yield* slotFixture
      yield* fs.makeDirectory(outside)
      yield* fs.writeFileString(join(outside, 'sentinel'), 'user-owned')
      yield* Effect.promise(() => symlink(outside, buck))
      expect(Exit.isFailure(yield* Effect.exit(inspectPoolBuckReset({ slot, maxBytes: 0 })))).toBe(
        true,
      )
      expect(yield* fs.readFileString(join(outside, 'sentinel'))).toBe('user-owned')
    }).pipe(withTestCtx(test)),
  )

  it.effect(
    'refuses authored physical roots before accounting, including a promoted marker',
    (test) =>
      Effect.gen(function* () {
        const { slot } = yield* slotFixture
        const authored: PoolSlot = {
          ...slot,
          executionRoot: {
            origin: 'fresh-reserved-uuid',
            path: slot.path,
            authored: true,
          },
        }
        expect(
          Exit.isFailure(yield* Effect.exit(inspectPoolBuckReset({ slot: authored, maxBytes: 0 }))),
        ).toBe(true)
      }).pipe(withTestCtx(test)),
  )

  for (const maxBytes of [
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    it.effect(`refuses invalid configured bounds: ${String(maxBytes)}`, (test) =>
      Effect.gen(function* () {
        const { slot } = yield* slotFixture
        expect(Exit.isFailure(yield* Effect.exit(inspectPoolBuckReset({ slot, maxBytes })))).toBe(
          true,
        )
      }).pipe(withTestCtx(test)),
    )
  }
})
