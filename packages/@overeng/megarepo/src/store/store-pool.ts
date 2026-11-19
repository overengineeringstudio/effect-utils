import { dirname } from 'node:path'

import { type Cause, Clock, Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import { type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { type GitWriterLockError, resolveGitCommonDir, withGitContainerLock } from './git-writer-lock.ts'
import {
  acquireDeletionLease,
  adoptPersistentDeletionLease,
  deletionLeasePath,
  type DeletionLeaseUnavailableError,
  persistentDeletionLeaseOwnerAlive,
  readCurrentDeletionLeaseProvider,
} from './store-deletion-lease.ts'
import { readWorktreeReferencesInUse } from './store-inuse.ts'
import {
  captureDeletionIdentity, type PinnedDeletionError, withVerifiedDirectoryPins,
} from './store-pinned-deletion.ts'
import type { WorktreeHolderEvidenceClientConfig } from './store-worktree-holder-codec.ts'
import { makeWorktreeHolderSource } from './store-worktree-holder-source.ts'
import {
  poolBytes,
  poolInstallIdentity,
  preparePoolInstall,
  runPoolCommand,
} from './store-pool-install.ts'
import {
  beginPoolRetarget,
  finishPoolRetarget,
  failedPoolRetarget,
  readPoolState,
  claimPoolGeneration,
  consumePoolReservation,
  PoolError,
  type PoolActivity,
  type PoolActivityEvent,
  type PoolSlot,
  markPoolRootAuthored,
  requireDisposablePoolRoot,
  requirePoolLease,
  reservePoolGeneration,
  readPoolState,
  retainPoolFailure,
  withPoolSlotOperation,
  withPoolState,
} from './store-pool-state.ts'

type PoolOperationError =
  | PoolError
  | PlatformError
  | Schema.SchemaError
  | Git.GitCommandError
  | Git.LinkedWorktreeAdmissionError
  | Cause.UnknownError
  | GitWriterLockError
  | DeletionLeaseUnavailableError
  | PinnedDeletionError

const barrier = ({ base, slot }: { base: AbsoluteDirPath; slot: PoolSlot }) => ({
  leasePath: deletionLeasePath({ storeBasePath: base, ownerPath: slot.path }),
  ownerPath: slot.path,
  token: slot.barrierToken,
})

/** Record service transitions, never inventing a missing historical claim or child exit. */
const observePoolActivity = ({
  slot, phase,
}: {
  slot: PoolSlot
  phase: Exclude<PoolActivity['phase'], 'retarget-ready' | 'retarget-failed'>
}): Effect.Effect<PoolSlot, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const birth = phase.startsWith('birth-')
    const previous = slot.activity
    const origin = birth === true ? 'none' :
      phase === 'claim-active' || previous?.claimed !== undefined ? 'claim-argument' : 'legacy-record'
    const event: PoolActivityEvent = {
      observedAtUtc: new Date(yield* Clock.currentTimeMillis).toISOString(),
      provider: yield* readCurrentDeletionLeaseProvider,
      ownerLabel: birth === true ? '' : previous?.claimed?.ownerLabel ?? previous?.event.ownerLabel ?? slot.owner,
      ownerLabelOrigin: origin,
    }
    const claimed = birth === true ? undefined : phase === 'claim-active' ? event : previous?.claimed
    const completed = birth === true || phase === 'claim-active' ? undefined :
      phase === 'claim-completed' && claimed !== undefined ? event : previous?.completed
    return { ...slot, activity: {
      generation: slot.generation, commit: slot.commit, identity: slot.identity,
      phase, event, claimed, completed,
    } }
  })
const cleanSource = (slot: PoolSlot) =>
  Effect.gen(function* () {
    if (
      /^[a-zA-Z0-9-]+$/u.test(slot.id) === false ||
      slot.path !== `${dirname(slot.bare)}/pool/${slot.id}`
    )
      return yield* new PoolError({ message: 'Pool root is not its fixed detached execution path' })
    yield* Git.readLinkedWorktreeAdmission({ owner: slot.path, barePath: slot.bare })
    if ((yield* Git.resolveRef({ repoPath: slot.path, ref: 'HEAD' })) !== slot.commit)
      return yield* new PoolError({ message: 'Committed work retained; source HEAD changed' })
    const history = yield* Git.runCommand({
      cwd: slot.path,
      args: ['reflog', 'show', '--format=%H', 'HEAD'],
    })
    const allowedSourceHistory = new Set(slot.sourceHistory)
    if (
      history.split('\n').some((commit) => allowedSourceHistory.has(commit) === false) === true
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
      slot.initialPreparation !== undefined ||
      slot.retirement !== undefined
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
        slot.retirement === undefined &&
        exists === true &&
        bytes !== undefined &&
        holders?._tag === 'free',
    }
    return next
  })

/** Allocate an unborn path for explicit owner enrollment, without preparing a root. */
export const reservePool = (args: {
  base: AbsoluteDirPath
  bare: string
  commit: string
  maxSlots: number
  maxBytes: number
  charge: number
}): Effect.Effect<PoolSlot, PoolOperationError, FileSystem.FileSystem | ChildProcessSpawner> =>
  withPoolState({
    base: args.base,
    limits: { maxSlots: args.maxSlots, maxBytes: args.maxBytes },
    use: (state, save) =>
      Effect.gen(function* () {
        const bare = yield* resolveGitCommonDir(args.bare)
        const next = yield* reservePoolGeneration({ state, bare, commit: args.commit, charge: args.charge })
        yield* save(next)
        return next.slots.at(-1)!
      }),
  })

/** Consume one exact reserved generation; failed preparation cannot resume. */
export const prewarmPool = (args: {
  base: AbsoluteDirPath
  bare: string
  commit: string
  charge: number
  id: string
  reservation: string
  generation: number
}): Effect.Effect<
  PoolSlot,
  PoolOperationError | Git.CommonBareWorktreeConfigError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  withPoolSlotOperation({
    base: args.base, select: args.id,
    use: (state, save) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const bare = yield* resolveGitCommonDir(args.bare)
        const reserved = state.slots.find((slot) => slot.id === args.id)
        if (reserved === undefined) return yield* new PoolError({ message: 'Unknown pool reservation' })
        let slot = yield* consumePoolReservation({ ...args, bare, slot: reserved })
        const update = () =>
          save({ ...state, slots: state.slots.map((item) => (item.id === slot.id ? slot : item)) })
        const exists = yield* fs.exists(slot.path).pipe(Effect.orElseSucceed(() => undefined))
        if (exists !== false) {
          slot = yield* retainPoolSlot({ slot: reserved, reason: 'Reserved path occupied or unknown' })
          yield* update()
          return yield* new PoolError({ message: slot.reason })
        }
        const { id, path } = slot
        const storePath = (yield* fs.realPath(args.base)).replace(/\/$/u, '')
        yield* update()
        let preparing = slot
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
          preparing = slot
          yield* update()
          yield* fs.makeDirectory(path)
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
          const identity = yield* poolInstallIdentity({ path, commit: args.commit, base: args.base })
          const bytes = yield* poolBytes(path)
          if (bytes > args.charge) {
            slot = { ...slot, charge: bytes }
            return yield* new PoolError({ message: 'Prepared root exceeds reserved charge' })
          }
          yield* cleanSource(slot)
          yield* free(slot)
          slot = yield* observePoolActivity({
            slot: { ...slot, identity, initialPreparation: undefined, state: 'ready', chargeKnown: true },
            phase: 'birth-ready',
          })
          yield* update()
          return slot
        }).pipe(withGitContainerLock({ path: bare, mode: 'shared' }))
        return yield* prepare.pipe(
          retainPoolFailure((reason) =>
            Effect.gen(function* () {
              slot = yield* observePoolActivity({
                slot: { ...(yield* retainPoolSlot({ slot: preparing, reason })), chargeKnown: false },
                phase: 'birth-failed',
              })
              yield* update()
            }),
          ),
        )
      }),
  })

/** Claim is serialized with capacity and generations; it never resets a root. */
export const claimPool = (args: { base: AbsoluteDirPath; identity: string; owner: string }) =>
  withPoolSlotOperation({
    base: args.base,
    select: (slot) => slot.state === 'ready' && slot.identity === args.identity,
    use: (state, save, slot) =>
      Effect.gen(function* () {
        const update = (next: PoolSlot) =>
          save({ ...state, slots: state.slots.map((item) => (item.id === slot.id ? next : item)) })
        let attempted = slot
        return yield* Effect.gen(function* () {
          yield* adoptPersistentDeletionLease(barrier({ base: args.base, slot }))
          yield* requireDisposablePoolRoot(slot)
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
          }).pipe(Effect.flatMap((claimed) => observePoolActivity({ slot: claimed, phase: 'claim-active' })))
          attempted = next
          yield* update(next)
          return next
        }).pipe(
          withGitContainerLock({ path: slot.bare, mode: 'shared' }),
          retainPoolFailure((reason) =>
            Effect.flatMap(retainPoolSlot({ slot: attempted, reason }), update),
          ),
        )
      }),
  })

/** Persist authoring before handing this physical root to an arbitrary child. */
export const authorPoolRoot = (args: {
  base: AbsoluteDirPath; id: string; token: string; generation: number
}): Effect.Effect<void, PoolOperationError, FileSystem.FileSystem | ChildProcessSpawner> => withPoolSlotOperation({
  base: args.base, select: args.id,
  use: (state, save) => Effect.gen(function* () {
    const slot = state.slots.find((item) => item.id === args.id)
    if (slot === undefined) return yield* new PoolError({ message: 'Unknown pool slot' })
    yield* requirePoolLease({ slot, token: args.token, generation: args.generation })
    const marked = yield* markPoolRootAuthored(slot)
    yield* save({ ...state, slots: state.slots.map((item) => item.id === slot.id ? marked : item) })
  }),
})

/** Teardown is the existing owner. Dirty, committed, crashed or uncertain roots stay locked. */
export const releasePool = (args: {
  base: AbsoluteDirPath
  id: string
  token: string
  generation: number
}) =>
  withPoolSlotOperation({
    base: args.base, select: args.id,
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
          yield* requireDisposablePoolRoot(slot)
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
          yield* requireDisposablePoolRoot(slot)
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
          const ready = yield* observePoolActivity({ slot: {
            ...slot,
            state: 'ready',
            chargeKnown: true,
            token: '',
            owner: '',
            reason: '',
          }, phase: 'release-ready' })
          yield* update(ready)
          return ready
        }).pipe(
          withGitContainerLock({ path: slot.bare, mode: 'shared' }),
          retainPoolFailure((reason) =>
            Effect.flatMap(retainPoolSlot({ slot, reason }), (retained) =>
              observePoolActivity({ slot: retained, phase: 'release-failed' }).pipe(Effect.flatMap(update))),
          ),
        )
      }),
  })

/** Source-integration prototype: no CLI or production activation until SDK/root qualification. */
export const retargetPool = (args: {
  base: AbsoluteDirPath
  id: string
  generation: number
  identity: string
  commit: string
  owner: string
  holderClient: WorktreeHolderEvidenceClientConfig
}): Effect.Effect<PoolSlot, PoolOperationError, FileSystem.FileSystem | ChildProcessSpawner> =>
  withPoolSlotOperation({
    base: args.base, select: args.id,
    use: (state, save) => Effect.gen(function* () {
      const original = state.slots.find((item) => item.id === args.id)
      if (original === undefined) return yield* new PoolError({ message: 'Unknown pool slot' })
      yield* requireDisposablePoolRoot(original)
      let slot = yield* beginPoolRetarget({ ...args, slot: original })
      const update = () => save({
        ...state, slots: state.slots.map((item) => item.id === slot.id ? slot : item),
      })
      return yield* Effect.gen(function* () {
        yield* adoptPersistentDeletionLease(barrier({ base: args.base, slot: original }))
        const admission = yield* Git.readLinkedWorktreeAdmission({
          owner: original.path, barePath: original.bare,
        })
        if (original.path === admission.gitdir || original.path.startsWith(`${admission.gitdir}/`) ||
          admission.gitdir.startsWith(`${original.path}/`))
          return yield* new PoolError({ message: 'Retarget root and admin namespaces must be disjoint' })
        const rootTarget = { rootPath: args.base, path: original.path }
        const adminTarget = { rootPath: args.base, path: admission.gitdir }
        const rootIdentity = yield* captureDeletionIdentity(rootTarget)
        const adminIdentity = yield* captureDeletionIdentity(adminTarget)
        const teardown = process.env.WORKTREE_TEARDOWN_BIN
        if (teardown === undefined || teardown.startsWith('/') === false)
          return yield* new PoolError({ message: 'Packaged WORKTREE_TEARDOWN_BIN provider is required' })
        const assertCurrent = Effect.gen(function* () {
          const current = (yield* readPoolState({ base: args.base })).slots.find((item) => item.id === slot.id)
          if (current?.generation !== slot.generation || current.retarget?.token !== slot.retarget?.token ||
            current.path !== slot.path || current.bare !== slot.bare || current.commit !== slot.commit ||
            current.barrierToken !== slot.barrierToken)
            return yield* new PoolError({ message: 'Stale retarget authority retained' })
          yield* requireDisposablePoolRoot(current)
          const linked = yield* Git.readLinkedWorktreeAdmission({ owner: slot.path, barePath: slot.bare })
          if (linked.gitdir !== admission.gitdir)
            return yield* new PoolError({ message: 'Retarget administrative identity changed' })
        })
        const withFreshProof = <A, E, R, ECommit = never, RCommit = never>(
          use: Effect.Effect<A, E, R>,
          commit: (prepared: A) => Effect.Effect<A, ECommit, RCommit> = Effect.succeed,
        ) => withVerifiedDirectoryPins({
          targets: [
            { ...rootTarget, identity: rootIdentity }, { ...adminTarget, identity: adminIdentity },
          ],
          prepare: ([rootPins, adminPins]) => Effect.gen(function* () {
            if (rootPins === undefined || adminPins === undefined)
              return yield* new PoolError({ message: 'Canonical retarget pins are incomplete' })
            yield* assertCurrent
            // Capture inside BOTH current pin scopes, never reuse a startup census.
            const source = yield* makeWorktreeHolderSource({
              client: args.holderClient, paths: [slot.path, admission.gitdir],
            })
            for (const [worktreePath, ownedPins] of [
              [slot.path, rootPins], [admission.gitdir, adminPins],
            ] as const) {
              const proof = yield* source.read({ worktreePath, ownedPins })
              if (proof.complete !== true || proof.inUse._tag !== 'free')
                return yield* new PoolError({ message: 'Qualified retarget holders not proven absent' })
            }
            yield* assertCurrent
            return yield* use
          }),
          commit,
        })
        // Durable source/epoch revocation precedes teardown, cleanup and checkout.
        yield* update()
        const intent = slot
        let published: PoolSlot | undefined
        const execute = Effect.gen(function* () {
          yield* withFreshProof(runPoolCommand({ cwd: args.base, command: teardown, args: [slot.path] }))
          yield* cleanSource(original)
          if ((yield* withFreshProof(poolInstallIdentity({
            path: original.path, commit: original.commit, base: args.base,
          }))) !== original.identity)
            return yield* new PoolError({ message: 'Retarget installed projection changed; retained' })
          yield* withFreshProof(Effect.gen(function* () {
            yield* cleanSource(original)
            yield* Git.runCommand({ cwd: slot.path, args: ['clean', '-fdx', '-e', '/node_modules/'] })
            yield* Git.runCommand({ cwd: slot.path, args: ['checkout', '--detach', slot.commit] })
          }))
          yield* withFreshProof(preparePoolInstall(slot.path))
          yield* withFreshProof(runPoolCommand({ cwd: args.base, command: teardown, args: [slot.path] }))
          const readiness = yield* withFreshProof(Effect.gen(function* () {
            yield* cleanSource(slot)
            const identity = yield* poolInstallIdentity({ path: slot.path, commit: slot.commit, base: args.base })
            const charge = yield* poolBytes(slot.path)
            if (charge > slot.charge)
              return yield* new PoolError({ message: 'Retarget exceeds reserved byte charge; retained' })
            return { identity, charge }
          }))
          // Doctor is a real subprocess: neither its preceding source check nor census is final.
          yield* cleanSource(slot)
          return yield* withFreshProof(Effect.gen(function* () {
            const prepared = yield* finishPoolRetarget({
              slot, generation: slot.generation, token: slot.retarget!.token,
              result: { _tag: 'Prepared', ...readiness },
            })
            return { ...prepared, activity: {
              generation: prepared.generation, commit: prepared.commit, identity: prepared.identity,
              phase: 'retarget-ready' as const,
              event: {
                observedAtUtc: new Date(yield* Clock.currentTimeMillis).toISOString(),
                provider: yield* readCurrentDeletionLeaseProvider,
                ownerLabel: args.owner, ownerLabelOrigin: 'retarget-argument' as const,
              },
            } }
          }), (prepared) => Effect.gen(function* () {
            // The canonical engine verified ALL chains; only now publish under its held FDs.
            slot = prepared
            published = prepared
            yield* update()
            return prepared
          }))
        })
        return yield* execute.pipe(retainPoolFailure((reason) => Effect.gen(function* () {
          // Never overwrite a superseding nonce or lose the unresolved mutation intent.
          const current = (yield* readPoolState({ base: args.base })).slots.find((item) => item.id === intent.id)
          if (current === undefined) return
          const failed = failedPoolRetarget({ current, intent, published, reason })
          if (failed === undefined) return
          slot = yield* retainPoolSlot({ slot: failed, reason })
          yield* update()
        })))
      }).pipe(withGitContainerLock({ path: original.bare, mode: 'shared' }))
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
  withPoolSlotOperation({
    base, select: id,
    use: (state, save) =>
      Effect.gen(function* () {
        const slot = state.slots.find((item) => item.id === id)
        if (slot === undefined) return yield* new PoolError({ message: 'Unknown pool slot' })
        yield* requirePoolLease({ slot, token, generation })
        const completed = yield* observePoolActivity({
          slot: { ...slot, state: 'completed', chargeKnown: false }, phase: 'claim-completed',
        })
        yield* save({
          ...state,
          slots: state.slots.map((item) =>
            item.id === id ? completed : item,
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
  withPoolSlotOperation({
    base, select: id,
    use: (state, save) =>
      Effect.gen(function* () {
        const slots: Array<PoolSlot> = []
        for (const slot of state.slots) {
          if (slot.id !== id || slot.token !== token) {
            slots.push(slot)
            continue
          }
          const retained = yield* retainPoolSlot({ slot, reason })
          slots.push(slot.state === 'leased' || slot.state === 'completed'
            ? yield* observePoolActivity({ slot: retained, phase: 'claim-failed' })
            : retained)
        }
        yield* save({ ...state, slots })
      }),
  })

export const PoolSlotBusy = Schema.TaggedStruct('PoolSlotBusy', {
  id: Schema.String,
  state: Schema.Literal('HOLD'),
})

/** Reconcile each root independently; a busy action is an observation, never a ready grant. */
export const inspectPool = (base: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const observed = yield* readPoolState({ base })
    const busy: Array<Schema.Schema.Type<typeof PoolSlotBusy>> = []
    for (const observedSlot of observed.slots) {
      yield* withPoolSlotOperation({
        base, select: observedSlot.id,
        use: (state, save, slot) => Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const pathExists = yield* fs.exists(slot.path).pipe(Effect.orElseSucceed(() => undefined))
          if (slot.state === 'reserved' && pathExists === false) return
          const pathKnown = pathExists === true
          const uncertain = pathKnown === false || slot.state === 'preparing' || slot.state === 'reserved' ||
            (slot.state === 'leased' &&
              (yield* persistentDeletionLeaseOwnerAlive(barrier({ base, slot }))) === false)
          const mutable = slot.state === 'leased' || slot.state === 'completed'
          const reason = slot.state === 'reserved' ? 'Reserved path unexpectedly exists or is unknown' :
            pathKnown === false ? 'Root path lost or unknown' :
            uncertain === true ? 'Provider lost or unknown' : slot.reason
          const retained = uncertain === true || (slot.chargeKnown !== true && mutable === false)
            ? yield* retainPoolSlot({ slot, reason }) : slot
          yield* save({ ...state, slots: state.slots.map((item) => item.id === slot.id ? retained : item) })
        }),
      }).pipe(Effect.catchTag('GitWriterLockError', (error) =>
        error.contention === true
          ? Effect.sync(() => { busy.push({ _tag: 'PoolSlotBusy', id: observedSlot.id, state: 'HOLD' }) })
          : Effect.fail(error)))
    }
    return { ...(yield* readPoolState({ base })), ...(busy.length === 0 ? {} : { busy }) }
  })
