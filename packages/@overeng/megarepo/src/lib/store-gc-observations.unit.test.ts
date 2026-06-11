import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import {
  coldSinceMs,
  nextObservationLedger,
  readObservationLedger,
  recordObservations,
  GC_OBSERVATIONS_RELATIVE_PATH,
} from './store-gc-observations.ts'

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)))

const withTempStore = <A, E>(
  body: (storeBasePath: AbsoluteDirPath) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      return yield* body(tmp)
    }).pipe(Effect.scoped),
  )

describe('store-gc-observations', () => {
  describe('nextObservationLedger (transitions)', () => {
    it('starts the grace clock for a newly-cold path at `now`', () => {
      const next = nextObservationLedger({ current: {}, coldPaths: ['/s/a'], now: 100 })
      expect(next).toEqual({ '/s/a': 100 })
    })

    it('preserves an existing firstSeen for a still-cold path (grace advances)', () => {
      const next = nextObservationLedger({
        current: { '/s/a': 100 },
        coldPaths: ['/s/a'],
        now: 500,
      })
      expect(next['/s/a']).toBe(100)
    })

    it('drops a path that is no longer cold', () => {
      const next = nextObservationLedger({
        current: { '/s/a': 100, '/s/b': 200 },
        coldPaths: ['/s/a'],
        now: 500,
      })
      expect(next).toEqual({ '/s/a': 100 })
    })

    it('no continuity laundering: cold -> not-cold -> cold restarts the clock', () => {
      const armed = nextObservationLedger({ current: {}, coldPaths: ['/s/a'], now: 100 })
      const cleared = nextObservationLedger({ current: armed, coldPaths: [], now: 200 })
      expect(cleared).toEqual({})
      const rearmed = nextObservationLedger({ current: cleared, coldPaths: ['/s/a'], now: 300 })
      expect(rearmed['/s/a']).toBe(300)
    })

    it('normalizes trailing slashes so a dir/file form maps to one entry', () => {
      const next = nextObservationLedger({ current: { '/s/a': 50 }, coldPaths: ['/s/a/'], now: 9 })
      expect(next).toEqual({ '/s/a': 50 })
    })

    it('skips grace-advance for unclean-reconcile paths (not added)', () => {
      const next = nextObservationLedger({
        current: {},
        coldPaths: ['/s/a', '/s/b'],
        uncleanReconcilePaths: ['/s/b'],
        now: 100,
      })
      expect(next).toEqual({ '/s/a': 100 })
    })

    it('re-arms an existing unclean-reconcile path (drops its credit)', () => {
      const next = nextObservationLedger({
        current: { '/s/b': 10 },
        coldPaths: ['/s/b'],
        uncleanReconcilePaths: ['/s/b'],
        now: 100,
      })
      expect(next['/s/b']).toBeUndefined()
    })
  })

  describe('coldSinceMs', () => {
    it('returns the recorded ms, normalizing the query path', () => {
      expect(coldSinceMs({ ledger: { '/s/a': 42 }, path: '/s/a/' })).toBe(42)
    })

    it('returns undefined for an untracked path', () => {
      expect(coldSinceMs({ ledger: {}, path: '/s/a' })).toBeUndefined()
    })
  })

  describe('persistence', () => {
    it('round-trips through atomic write and read', async () => {
      const ledger = await withTempStore((storeBasePath) =>
        Effect.gen(function* () {
          yield* recordObservations({ storeBasePath, coldPaths: ['/s/a'], now: 100 })
          return yield* readObservationLedger({ storeBasePath })
        }),
      )
      expect(ledger).toEqual({ '/s/a': 100 })
    })

    it('advances grace across runs while a path stays cold', async () => {
      const ledger = await withTempStore((storeBasePath) =>
        Effect.gen(function* () {
          yield* recordObservations({ storeBasePath, coldPaths: ['/s/a'], now: 100 })
          yield* recordObservations({ storeBasePath, coldPaths: ['/s/a'], now: 900 })
          return yield* readObservationLedger({ storeBasePath })
        }),
      )
      expect(ledger['/s/a']).toBe(100)
    })

    it('treats a corrupt ledger as empty (conservatively re-arming)', async () => {
      const ledger = await withTempStore((storeBasePath) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const stateDir = EffectPath.ops.join(
            storeBasePath,
            EffectPath.unsafe.relativeDir('.state/'),
          )
          yield* fs.makeDirectory(stateDir, { recursive: true })
          yield* fs.writeFileString(
            EffectPath.ops.join(
              storeBasePath,
              EffectPath.unsafe.relativeFile(GC_OBSERVATIONS_RELATIVE_PATH),
            ),
            '{ this is not valid json',
          )
          return yield* readObservationLedger({ storeBasePath })
        }),
      )
      expect(ledger).toEqual({})
    })
  })
})
