import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { resolveGitCommonDir, withGitContainerLock } from './git-writer-lock.ts'
import { acquireDeletionLease } from './store-deletion-lease.ts'
import { readWorktreeReferencesInUse } from './store-inuse.ts'
import { poolBytes, poolInstallIdentity, preparePoolInstall } from './store-pool-install.ts'
import { PoolError, type PoolSlot, reservePoolSlot, withPoolState } from './store-pool-state.ts'

const cleanSource = (slot: PoolSlot) =>
  Effect.gen(function* () {
    if (
      /^[a-zA-Z0-9-]+$/u.test(slot.id) === false ||
      slot.path !== `${dirname(slot.bare)}/pool/${slot.id}`
    )
      return yield* new PoolError({ message: 'Pool root is not its fixed detached execution path' })
    if ((yield* Git.resolveRef({ repoPath: slot.path, ref: 'HEAD' })) !== slot.commit)
      return yield* new PoolError({ message: 'Committed work retained; source HEAD changed' })
    const history = yield* Git.runCommand({
      cwd: slot.path,
      args: ['reflog', 'show', '--format=%H', 'HEAD'],
    })
    if (history.split('\n').some((commit) => commit !== slot.commit) === true)
      return yield* new PoolError({
        message: 'Detached commit history retained; slot is not recyclable',
      })
    const changes = yield* Git.runCommand({
      cwd: slot.path,
      args: ['status', '--porcelain=v1', '--untracked-files=all'],
      env: { GIT_OPTIONAL_LOCKS: '0' },
    })
    if (changes !== '') return yield* new PoolError({ message: 'Dirty or untracked work retained' })
    const registrations = yield* Git.listWorktrees(slot.bare)
    const registration = registrations.find((entry) => entry.path.replace(/\/$/u, '') === slot.path)
    if (
      registration === undefined ||
      Option.isSome(registration.symbolicRef) === true ||
      Option.getOrUndefined(registration.lockReason) !== `mr-pool:${slot.id}:preparing`
    )
      return yield* new PoolError({ message: 'Native pool worktree protection is missing' })
  })
const free = (slot: PoolSlot) =>
  Effect.gen(function* () {
    const proof = yield* readWorktreeReferencesInUse({ worktreePath: slot.path, scope: 'gc-owner' })
    if (proof._tag !== 'free')
      return yield* new PoolError({
        message: `Pool holders not proven absent: ${yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown),
        )(proof)}`,
      })
  })

/** Retention never hides partial growth; unknown holders/accounting block allocation. */
const retainPoolSlot = ({ slot, reason }: { slot: PoolSlot; reason: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(slot.path).pipe(Effect.orElseSucceed(() => undefined))
    const bytes =
      exists === false ? 0 : yield* poolBytes(slot.path).pipe(Effect.orElseSucceed(() => undefined))
    const holders =
      exists === false
        ? undefined
        : yield* readWorktreeReferencesInUse({ worktreePath: slot.path, scope: 'gc-owner' })
    const next: PoolSlot = {
      ...slot,
      state: 'quarantined',
      reason,
      charge: Math.max(slot.charge, bytes ?? slot.charge),
      chargeKnown: exists === true && bytes !== undefined && holders?._tag === 'free',
    }
    return next
  })

/** Explicitly prepare a protected detached generation within immutable host-wide limits. */
export const prewarmPool = (args: {
  base: AbsoluteDirPath
  bare: string
  commit: string
  maxSlots: number
  maxBytes: number
  charge: number
}) =>
  withPoolState({
    base: args.base,
    use: (state, save) =>
      Effect.gen(function* () {
        if (/^[0-9a-f]{40}$/u.test(args.commit) === false)
          return yield* new PoolError({ message: 'Prewarm requires an exact commit SHA' })
        const fs = yield* FileSystem.FileSystem
        const bare = yield* resolveGitCommonDir(args.bare)
        const storePath = (yield* fs.realPath(args.base)).replace(/\/$/u, '')
        const id = randomUUID()
        const path = `${dirname(bare)}/pool/${id}`
        let slot: PoolSlot = {
          id,
          path,
          bare,
          commit: args.commit,
          identity: '',
          charge: args.charge,
          generation: 0,
          state: 'preparing',
          chargeKnown: false,
          token: '',
          barrierToken: '',
          owner: '',
          reason: '',
        }
        const reserved = yield* reservePoolSlot({ state, slot })
        const update = () =>
          save({ ...reserved, slots: reserved.slots.map((item) => (item.id === id ? slot : item)) })
        yield* update()
        const prepare = Effect.gen(function* () {
          yield* fs.makeDirectory(dirname(path), { recursive: true })
          const lease = yield* acquireDeletionLease({
            storeBasePath: args.base,
            ownerPath: path,
            now: Date.now(),
            persistent: true,
            activationIdentity: { storePath, containerPath: bare },
          })
          slot = { ...slot, barrierToken: lease.token }
          yield* update()
          yield* Git.ensureBareRefLogging({ repoPath: bare })
          yield* Git.createWorktreeDetached({
            repoPath: bare,
            worktreePath: path,
            commit: args.commit,
            lockReason: `mr-pool:${id}:preparing`,
          })
          yield* preparePoolInstall(path)
          yield* cleanSource(slot)
          yield* free(slot)
          slot = {
            ...slot,
            identity: yield* poolInstallIdentity({ path, commit: args.commit, base: args.base }),
          }
          const bytes = yield* poolBytes(path)
          if (bytes > args.charge) {
            slot = { ...slot, charge: bytes }
            return yield* new PoolError({ message: 'Prepared root exceeds reserved charge' })
          }
          yield* cleanSource(slot)
          yield* free(slot)
          slot = { ...slot, state: 'ready', chargeKnown: true }
          yield* update()
          return slot
        }).pipe(withGitContainerLock({ path: bare, mode: 'shared' }))
        return yield* prepare.pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              slot = yield* retainPoolSlot({ slot, reason: String(error) })
              yield* update()
            }),
          ),
        )
      }),
    limits: { maxSlots: args.maxSlots, maxBytes: args.maxBytes },
  })
