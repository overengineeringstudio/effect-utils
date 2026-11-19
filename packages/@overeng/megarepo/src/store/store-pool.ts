import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { resolveGitCommonDir, withGitContainerLock } from './git-writer-lock.ts'
import {
  acquireDeletionLease,
  adoptPersistentDeletionLease,
  deletionLeasePath,
  persistentDeletionLeaseOwnerAlive,
} from './store-deletion-lease.ts'
import { readWorktreeReferencesInUse } from './store-inuse.ts'
import {
  poolBytes,
  poolInstallIdentity,
  preparePoolInstall,
  runPoolCommand,
} from './store-pool-install.ts'
import {
  claimPoolGeneration,
  PoolError,
  type PoolSlot,
  requirePoolLease,
  reservePoolSlot,
  withPoolState,
} from './store-pool-state.ts'

const barrier = ({ base, slot }: { base: AbsoluteDirPath; slot: PoolSlot }) => ({
  leasePath: deletionLeasePath({ storeBasePath: base, ownerPath: slot.path }),
  ownerPath: slot.path,
  token: slot.barrierToken,
})
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
    if (
      history.split('\n').some((commit) => slot.sourceHistory.includes(commit) === false) === true
    )
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
      exists === false ||
      slot.retarget !== undefined ||
      slot.reservation !== undefined ||
      slot.initialPreparation !== undefined
        ? undefined
        : yield* readWorktreeReferencesInUse({ worktreePath: slot.path, scope: 'gc-owner' })
    const next: PoolSlot = {
      ...slot,
      state: 'quarantined',
      reservation: undefined,
      reason,
      charge: Math.max(slot.charge, bytes ?? slot.charge),
      chargeKnown:
        slot.retarget === undefined &&
        slot.reservation === undefined &&
        slot.initialPreparation === undefined &&
        exists === true &&
        bytes !== undefined &&
        holders?._tag === 'free',
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
          sourceHistory: [args.commit],
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

/** Claim is serialized with capacity and generations; it never resets a root. */
export const claimPool = (args: { base: AbsoluteDirPath; identity: string; owner: string }) =>
  withPoolState({
    base: args.base,
    use: (state, save) =>
      Effect.gen(function* () {
        const slot = state.slots.find(
          (item) => item.state === 'ready' && item.identity === args.identity,
        )
        if (slot === undefined)
          return yield* new PoolError({ message: 'No matching ready pool generation' })
        const update = (next: PoolSlot) =>
          save({ ...state, slots: state.slots.map((item) => (item.id === slot.id ? next : item)) })
        return yield* Effect.gen(function* () {
          yield* adoptPersistentDeletionLease(barrier({ base: args.base, slot }))
          yield* cleanSource(slot)
          yield* free(slot)
          if (
            (yield* poolInstallIdentity({
              path: slot.path,
              commit: slot.commit,
              base: args.base,
            })) !== slot.identity ||
            (yield* poolBytes(slot.path)) > slot.charge
          )
            return yield* new PoolError({ message: 'Pool install identity or byte charge changed' })
          yield* cleanSource(slot)
          yield* free(slot)
          const next = yield* claimPoolGeneration({
            slot,
            identity: args.identity,
            owner: args.owner,
          })
          yield* update(next)
          return next
        }).pipe(
          withGitContainerLock({ path: slot.bare, mode: 'shared' }),
          Effect.tapError((error) =>
            Effect.flatMap(retainPoolSlot({ slot, reason: String(error) }), update),
          ),
        )
      }),
  })

/** Teardown is the existing owner. Dirty, committed, crashed or uncertain roots stay locked. */
export const releasePool = (args: {
  base: AbsoluteDirPath
  id: string
  token: string
  generation: number
}) =>
  withPoolState({
    base: args.base,
    use: (state, save) =>
      Effect.gen(function* () {
        const slot = state.slots.find((item) => item.id === args.id)
        if (slot === undefined) return yield* new PoolError({ message: 'Unknown pool slot' })
        yield* requirePoolLease({ slot, token: args.token, generation: args.generation })
        const update = (next: PoolSlot) =>
          save({ ...state, slots: state.slots.map((item) => (item.id === slot.id ? next : item)) })
        // Durable quarantine precedes any draining/reset. A crash cannot expose ready.
        yield* update({
          ...slot,
          state: 'quarantined',
          chargeKnown: false,
          reason: 'release incomplete',
        })
        return yield* Effect.gen(function* () {
          yield* adoptPersistentDeletionLease(barrier({ base: args.base, slot }))
          const teardown = process.env.WORKTREE_TEARDOWN_BIN
          if (teardown === undefined || teardown.startsWith('/') === false)
            return yield* new PoolError({
              message: 'Packaged WORKTREE_TEARDOWN_BIN provider is required',
            })
          yield* runPoolCommand({ cwd: args.base, command: teardown, args: [slot.path] })
          yield* free(slot)
          yield* cleanSource(slot)
          if (
            (yield* poolInstallIdentity({
              path: slot.path,
              commit: slot.commit,
              base: args.base,
            })) !== slot.identity
          )
            return yield* new PoolError({ message: 'Installed projection changed; retained' })
          yield* cleanSource(slot)
          yield* free(slot)
          // Only this detached slot is cleaned; preserved node_modules was validated above.
          yield* Git.runCommand({ cwd: slot.path, args: ['clean', '-fdx', '-e', '/node_modules/'] })
          yield* Git.runCommand({ cwd: slot.path, args: ['checkout', '--detach', slot.commit] })
          yield* preparePoolInstall(slot.path)
          yield* cleanSource(slot)
          yield* free(slot)
          if (
            (yield* poolInstallIdentity({
              path: slot.path,
              commit: slot.commit,
              base: args.base,
            })) !== slot.identity ||
            (yield* poolBytes(slot.path)) > slot.charge
          )
            return yield* new PoolError({
              message: 'Reprepared root no longer matches reserved identity/bytes',
            })
          yield* cleanSource(slot)
          yield* free(slot)
          const ready: PoolSlot = {
            ...slot,
            state: 'ready',
            chargeKnown: true,
            token: '',
            owner: '',
            reason: '',
          }
          yield* update(ready)
          return ready
        }).pipe(
          withGitContainerLock({ path: slot.bare, mode: 'shared' }),
          Effect.tapError((error) =>
            Effect.flatMap(retainPoolSlot({ slot, reason: String(error) }), update),
          ),
        )
      }),
  })

/** A successful provider publishes completion before exiting; it remains non-reusable. */
export const completePool = ({
  base,
  id,
  token,
  generation,
}: {
  base: AbsoluteDirPath
  id: string
  token: string
  generation: number
}) =>
  withPoolState({
    base,
    use: (state, save) =>
      Effect.gen(function* () {
        const slot = state.slots.find((item) => item.id === id)
        if (slot === undefined) return yield* new PoolError({ message: 'Unknown pool slot' })
        yield* requirePoolLease({ slot, token, generation })
        yield* save({
          ...state,
          slots: state.slots.map((item) =>
            item.id === id ? { ...item, state: 'completed' as const, chargeKnown: false } : item,
          ),
        })
      }),
  })

/** Retain a failed provider generation without discarding its native protection. */
export const quarantinePool = ({
  base,
  id,
  token,
  reason,
}: {
  base: AbsoluteDirPath
  id: string
  token: string
  reason: string
}) =>
  withPoolState({
    base,
    use: (state, save) =>
      Effect.gen(function* () {
        const slots: Array<PoolSlot> = []
        for (const slot of state.slots)
          slots.push(
            slot.id === id && slot.token === token ? yield* retainPoolSlot({ slot, reason }) : slot,
          )
        yield* save({ ...state, slots })
      }),
  })

/** Inspection reconciles abandoned providers only toward retention, never readiness. */
export const inspectPool = (base: AbsoluteDirPath) =>
  withPoolState({
    base,
    use: (state, save) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const slots: Array<PoolSlot> = []
        for (const slot of state.slots) {
          const pathExists = yield* fs.exists(slot.path).pipe(Effect.orElseSucceed(() => undefined))
          if (slot.state === 'reserved' && pathExists === false) {
            slots.push(slot)
            continue
          }
          const pathKnown = pathExists === true
          const uncertain =
            pathKnown === false ||
            slot.state === 'preparing' ||
            slot.state === 'reserved' ||
            (slot.state === 'leased' &&
              (yield* persistentDeletionLeaseOwnerAlive(barrier({ base, slot }))) === false)
          const mutable = slot.state === 'leased' || slot.state === 'completed'
          const reason =
            slot.state === 'reserved'
              ? 'Reserved path unexpectedly exists or is unknown'
              : pathKnown === false
                ? 'Root path lost or unknown'
                : uncertain === true
                  ? 'Provider lost or unknown'
                  : slot.reason
          slots.push(
            uncertain === true || (slot.chargeKnown !== true && mutable === false)
              ? yield* retainPoolSlot({ slot, reason })
              : slot,
          )
        }
        const next = { ...state, slots }
        yield* save(next)
        return next
      }),
  })
