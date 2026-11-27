import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Deferred, Effect, Fiber } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'
import { Vitest } from '@overeng/utils-dev/node-vitest'

import { initFixtureRepo } from '../test-utils/git-fixture.ts'
import { withGitContainerLock, withGitWriterLock } from './git-writer-lock.ts'
import {
  acquireDeletionLease,
  adoptPersistentDeletionLease,
  deletionLeasePath,
  withDeletionLease,
  withStoreWorktreeLease,
} from './store-deletion-lease.ts'
import { captureDeletionIdentity, withVerifiedDirectoryPins } from './store-pinned-deletion.ts'
import { withPoolState } from './store-pool-state.ts'

const withTestCtx = Vitest.makeWithTestCtx({ makeLayer: () => NodeServices.layer })
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const base = EffectPath.unsafe.absoluteDir(
    `${yield* fs.realPath(yield* fs.makeTempDirectoryScoped())}/`,
  )
  const repo = EffectPath.unsafe.absoluteDir(`${base}repo/`)
  yield* fs.makeDirectory(repo)
  yield* initFixtureRepo(repo)
  return { fs, base, repo }
})

describe('pool GLOBAL lock order', () => {
  it.effect(
    'refuses reverse root, native-lock, pin and epoch acquisitions before mutation',
    (test) =>
      Effect.gen(function* () {
        const { fs, base, repo } = yield* fixture
        const root = `${base}root`
        const barrier = yield* acquireDeletionLease({
          storeBasePath: base,
          ownerPath: root,
          now: 1,
          persistent: true,
        })
        const before = yield* fs.stat(barrier.leasePath)
        const bytes = yield* fs.readFileString(barrier.leasePath)
        const nested = EffectPath.unsafe.absoluteDir(`${base}nested/`)
        let entered = false
        const body = Effect.sync(() => {
          entered = true
        })
        yield* withPoolState({
          base,
          limits: { maxSlots: 1, maxBytes: 64 },
          use: () =>
            Effect.gen(function* () {
              const attempts = [
                acquireDeletionLease({
                  storeBasePath: base,
                  ownerPath: `${base}other`,
                  now: 2,
                }).pipe(Effect.flip),
                adoptPersistentDeletionLease(barrier).pipe(Effect.flip),
                body.pipe(
                  withStoreWorktreeLease({
                    storeBasePath: base,
                    ownerPath: root,
                    bareRepoPath: repo,
                  }),
                  Effect.flip,
                ),
                body.pipe(withGitWriterLock({ path: repo }), Effect.flip),
                body.pipe(withGitContainerLock({ path: repo, mode: 'shared' }), Effect.flip),
                withPoolState({
                  base: nested,
                  limits: { maxSlots: 1, maxBytes: 64 },
                  use: () => body,
                }).pipe(Effect.flip),
              ]
              for (const attempt of attempts) {
                const error = yield* attempt
                expect(error._tag === 'GitWriterLockError' ? error.cause : error.message).toContain(
                  'GLOBAL pool epoch',
                )
              }
              const child = yield* body.pipe(
                withGitWriterLock({ path: repo }),
                Effect.flip,
                Effect.forkScoped,
              )
              expect((yield* Fiber.join(child)).cause).toBe(
                'GLOBAL pool epoch cannot acquire native locks',
              )
            }),
        })
        expect(entered).toBe(false)
        expect(yield* fs.exists(`${repo}.git.mr-writer.lock`)).toBe(false)
        expect(yield* fs.exists(`${repo}.git.mr-container.lock`)).toBe(false)
        expect(yield* fs.exists(`${nested}.state`)).toBe(false)
        expect(
          yield* fs.exists(deletionLeasePath({ storeBasePath: base, ownerPath: `${base}other` })),
        ).toBe(false)
        expect(yield* fs.readFileString(barrier.leasePath)).toBe(bytes)
        expect((yield* fs.stat(barrier.leasePath)).ino).toEqual(before.ino)
        // A failed epoch must not leak the context into the next physical operation.
        const failure = new Error('state callback failed')
        expect(
          yield* withPoolState({
            base,
            limits: { maxSlots: 1, maxBytes: 64 },
            use: () => Effect.fail(failure),
          }).pipe(Effect.flip),
        ).toBe(failure)
        yield* Effect.void.pipe(withGitWriterLock({ path: repo }))
      }).pipe(withTestCtx(test)),
  )

  it.effect('keeps the epoch fiber-local and revokes it when its holder is interrupted', (test) =>
    Effect.gen(function* () {
      const { fs, base, repo } = yield* fixture
      const entered = yield* Deferred.make<void>()
      const holder = yield* withPoolState({
        base,
        limits: { maxSlots: 1, maxBytes: 64 },
        use: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      // This fiber does not hold GLOBAL: an unrelated native lock is legal now.
      yield* Effect.void.pipe(withGitWriterLock({ path: repo }))
      yield* Fiber.interrupt(holder)
      yield* withPoolState({
        base,
        limits: { maxSlots: 1, maxBytes: 64 },
        use: (_state, save) => save({ version: 1, maxSlots: 1, maxBytes: 64, slots: [] }),
      })
      expect(yield* fs.exists(`${base}.state/pool/state.json`)).toBe(true)
    }).pipe(withTestCtx(test)),
  )

  it.effect('allows ROOT then container then Linux pins then short GLOBAL publication', (test) =>
    Effect.gen(function* () {
      if (process.platform !== 'linux') return
      const { fs, base, repo } = yield* fixture
      const root = `${base}payload`
      yield* fs.makeDirectory(root)
      const identity = yield* captureDeletionIdentity({ rootPath: base, path: root })
      let entered = false
      const body = Effect.sync(() => {
        entered = true
      })
      yield* withPoolState({
        base,
        limits: { maxSlots: 1, maxBytes: 64 },
        use: () =>
          Effect.gen(function* () {
            const captureError = yield* captureDeletionIdentity({
              rootPath: base,
              path: root,
            }).pipe(Effect.flip)
            expect(captureError.message).toContain('GLOBAL pool epoch')
            const pinError = yield* withVerifiedDirectoryPins({
              targets: [{ rootPath: base, path: root, identity }],
              prepare: () => body,
              commit: () => body,
            }).pipe(Effect.flip)
            expect(pinError.message).toContain('GLOBAL pool epoch')
          }),
      })
      expect(entered).toBe(false)
      const value = yield* withVerifiedDirectoryPins({
        targets: [{ rootPath: base, path: root, identity }],
        prepare: () =>
          withPoolState({
            base,
            limits: { maxSlots: 1, maxBytes: 64 },
            use: (state, save) => save(state).pipe(Effect.as('verified')),
          }),
        commit: (prepared) => Effect.succeed(prepared),
      }).pipe(
        withGitContainerLock({ path: repo, mode: 'shared' }),
        withDeletionLease({ storeBasePath: base, ownerPath: root, now: 1 }),
      )
      expect(value).toBe('verified')
      expect(yield* fs.exists(root)).toBe(true)
      expect(yield* fs.exists(deletionLeasePath({ storeBasePath: base, ownerPath: root }))).toBe(
        false,
      )
    }).pipe(withTestCtx(test)),
  )
})
