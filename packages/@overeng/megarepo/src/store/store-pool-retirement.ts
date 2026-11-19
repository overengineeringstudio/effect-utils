import { Cause, Effect, Exit, type Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { type GitWriterLockError, withGitContainerLock } from './git-writer-lock.ts'
import {
  adoptPersistentDeletionLease, assertOwnedPersistentDeletionLease, deletionLeasePath,
  type DeletionLeaseUnavailableError, releaseDeletionLease,
} from './store-deletion-lease.ts'
import { type PoolRootProvenance, projectPoolProvenance } from './store-pool-provenance.ts'
import { beginPoolRetirement, PoolError, type PoolSlot, readPoolState, withPoolState } from './store-pool-state.ts'

export type PoolRetirementExpected = Readonly<Pick<PoolSlot,
  'id' | 'path' | 'bare' | 'generation' | 'commit' | 'identity'
>>
export type PoolRetirementTarget = PoolRetirementExpected & {
  readonly base: AbsoluteDirPath
  readonly adminDir: string
  readonly sourceHistory: PoolSlot['sourceHistory']
  readonly ownerActivity: Extract<PoolRootProvenance['ownerActivity'], { _tag: 'Recorded' }>
  readonly terminalRootActivity: NonNullable<PoolRootProvenance['terminalRootActivity']>
}
type RetirementError = PoolError | PlatformError | Schema.SchemaError |
  Git.GitCommandError | GitWriterLockError | DeletionLeaseUnavailableError

/** Internal same-process custody only. Native GC owns physical mutations and fresh admission. */
export const withPoolRetirement = <E, R>({
  base, expected, remove,
}: {
  base: AbsoluteDirPath
  expected: PoolRetirementExpected
  remove: (context: {
    readonly target: PoolRetirementTarget
    readonly assertCurrent: Effect.Effect<void, RetirementError, FileSystem.FileSystem>
  }) => Effect.Effect<void, E, R>
}): Effect.Effect<void, E | RetirementError, R | FileSystem.FileSystem | ChildProcessSpawner> =>
  withPoolState({
    base,
    use: (state, save) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const slot = state.slots.find((item) => item.id === expected.id)
      if (slot === undefined || slot.path !== expected.path || slot.bare !== expected.bare ||
        slot.generation !== expected.generation || slot.commit !== expected.commit || slot.identity !== expected.identity)
        return yield* new PoolError({ message: 'Stale or unknown pool retirement target' })
      const observation = projectPoolProvenance(slot)
      const ownerActivity = observation.ownerActivity
      const terminalRootActivity = observation.terminalRootActivity
      if (observation.disposition !== 'CANDIDATE' || ownerActivity._tag !== 'Recorded' || terminalRootActivity === undefined)
        return yield* new PoolError({ message: 'Pool retirement requires recorded ready/unclaimed history' })
      return yield* Effect.gen(function* () {
        let retiring = yield* beginPoolRetirement({ slot, generation: expected.generation, identity: expected.identity })
        const intent = retiring.retirement
        if (intent === undefined) return yield* new PoolError({ message: 'Retirement transition omitted its intent' })
        const update = (next: PoolSlot) => save({
          ...state, slots: state.slots.map((item) => item.id === slot.id ? next : item),
        })
        yield* update(retiring)
        const barrier = {
          leasePath: deletionLeasePath({ storeBasePath: base, ownerPath: slot.path }),
          ownerPath: slot.path, token: slot.barrierToken,
        }
        const matches = (current: PoolSlot | undefined) => current !== undefined &&
          current.id === slot.id && current.path === slot.path && current.bare === slot.bare &&
          current.commit === slot.commit && current.generation === retiring.generation &&
          current.barrierToken === slot.barrierToken && current.retirement?.nonce === intent.nonce &&
          current.retirement.fromGeneration === expected.generation && current.retirement.identity === expected.identity &&
          current.retirement.status === 'pending' && current.retirement.adminDir === retiring.retirement?.adminDir &&
          current.sourceHistory.length === slot.sourceHistory.length &&
          current.sourceHistory.every((commit, index) => commit === slot.sourceHistory[index])
        const assertAbsent = (path: string): Effect.Effect<void, PlatformError | PoolError> =>
          fs.lstat(path).pipe(Effect.matchEffect({
            onFailure: (error): Effect.Effect<void, PlatformError> =>
              error.reason._tag === 'NotFound' ? Effect.void : Effect.fail(error),
            onSuccess: () => Effect.fail(new PoolError({ message: `Retirement path still present: ${path}` })),
          }))
        const action = yield* Effect.gen(function* () {
          yield* adoptPersistentDeletionLease(barrier)
          const adminDir = yield* fs.realPath(
            yield* Git.runCommand({ cwd: slot.path, args: ['rev-parse', '--absolute-git-dir'] }),
          )
          retiring = { ...retiring, retirement: { ...intent, adminDir } }
          yield* update(retiring)
          const assertCurrent = Effect.gen(function* () {
            const current = (yield* readPoolState({ base })).slots.find((item) => item.id === slot.id)
            if (matches(current) === false)
              return yield* new PoolError({ message: 'Pool retirement ownership changed; retained' })
            yield* assertOwnedPersistentDeletionLease(barrier)
          })
          const target: PoolRetirementTarget = {
            base: EffectPath.unsafe.absoluteDir(`${yield* fs.realPath(base)}/`),
            id: slot.id, path: slot.path, bare: slot.bare, generation: slot.generation,
            commit: slot.commit, identity: slot.identity, sourceHistory: slot.sourceHistory,
            adminDir, ownerActivity, terminalRootActivity,
          }
          yield* assertCurrent
          yield* remove({ target, assertCurrent })
          yield* assertCurrent
          // No Git census or basename inference substitutes for exact no-follow absence.
          yield* assertAbsent(slot.path)
          yield* assertAbsent(adminDir)
          yield* releaseDeletionLease(barrier)
          yield* assertAbsent(barrier.leasePath)
          yield* save({ ...state, slots: state.slots.filter((item) => item.id !== slot.id) })
        }).pipe(Effect.exit)
        if (Exit.isFailure(action) === true) {
          const retained = yield* Effect.gen(function* () {
            const current = yield* readPoolState({ base })
            const owned = current.slots.find((item) => item.id === slot.id)
            if (owned === undefined || matches(owned) === false || owned.retirement === undefined) return
            const failed: PoolSlot = { ...owned, retirement: { ...owned.retirement, status: 'failed' } }
            yield* save({ ...current, slots: current.slots.map((item) => item.id === slot.id ? failed : item) })
          }).pipe(Effect.exit)
          return yield* Effect.failCause(Exit.isFailure(retained) === true
            ? Cause.combine(action.cause, retained.cause) : action.cause)
        }
      }).pipe(withGitContainerLock({ path: slot.bare, mode: 'exclusive' }))
    }),
  })
