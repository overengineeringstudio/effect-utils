import { dirname, isAbsolute, join, resolve } from 'node:path'

import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { resolveGitCommonDir, withGitContainerLock, withPoolRootActionLock } from './git-writer-lock.ts'
import { stopWorktreeBuckDaemons } from './store-buck-daemons.ts'
import { requirePoolBuckDrain } from './store-pool-buck.ts'
import { acquireDeletionLease, createStoreWorktreeDetached, readProcessIdentity } from './store-deletion-lease.ts'
import { inspectFreshPoolHeadHistory } from './store-pool-head-history.ts'
import { requireOutsidePoolGlobal } from './store-pool-lock-order.ts'
import { captureDeletionIdentity, type DeletionIdentity, type OwnedDeletionPins, withVerifiedDirectoryPins } from './store-pinned-deletion.ts'
import { inspectPoolInstall, poolBytes, preparePoolInstall, runPoolTasks } from './store-pool-install.ts'
import {
  beginPoolPreparation, bindPoolPhysicalBirth, finishPoolPreparation, PoolError,
  type PoolActor, type PoolSlot, requireDisposablePoolRoot, requirePoolPhysicalBirth,
  requirePoolSlotSnapshot, reserveFreshPoolRoot, withPoolState,
} from './store-pool-state.ts'
import { assertWorktreeHolderEvidenceFresh, readWorktreeHolderEvidence } from './store-worktree-holder-client.ts'
import { type HolderEvidenceClientConfig } from './store-worktree-holder-codec.ts'

const hold = (message: string) => new PoolError({ message: `${message}; HOLD` })
const capture = (path: string) => captureDeletionIdentity({ rootPath: '/', path })
const leaf = (chain: DeletionIdentity) => {
  const last = chain.at(-1)
  return last?._tag === 'Inode' ? Effect.succeed(last) : Effect.fail(hold('Native inode required'))
}

/** Metadata creation only; existing permissions and symlinks are never repaired. */
const poolParent = (bare: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const parent = join(dirname(bare), 'pool')
  yield* fs.makeDirectory(parent, { mode: 0o700 }).pipe(
    Effect.catch((error) => error.reason._tag === 'AlreadyExists' ? Effect.void : Effect.fail(error)),
  )
  const info = yield* fs.lstat(parent)
  if (info.type !== 'Directory' || process.getuid === undefined ||
    Option.getOrUndefined(info.uid) !== process.getuid() || (info.mode & 0o022) !== 0 ||
    (yield* fs.realPath(parent)) !== parent) return yield* hold('Pool parent is not private and canonical')
})

export const inspectPoolGitSource = ({ slot, admin }: { slot: PoolSlot; admin: string }) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  if ((yield* Git.getAbsoluteGitDir(slot.path)) !== admin ||
    (yield* fs.realPath(admin)) !== admin || dirname(admin) !== join(slot.bare, 'worktrees') ||
    (yield* resolveGitCommonDir(slot.path)) !== slot.bare ||
    (yield* fs.readFileString(join(admin, 'gitdir'))).trim() !== join(slot.path, '.git') ||
    (yield* fs.readFileString(join(admin, 'locked'))).trim() !== `mr-pool:${slot.id}` ||
    (yield* fs.readFileString(join(admin, 'HEAD'))).trim() !== slot.commit ||
    (yield* Git.getCurrentCommit(slot.path)) !== slot.commit ||
    (yield* Git.getWorktreeStatus({ worktreePath: slot.path, readOnly: true })).isDirty)
    return yield* hold('Pool Git registration or source changed')
})

/** Current leader generation is checked against proc, never inferred from a PID label.
 * The normal wire has no authenticated nonleader aliases: every such ref vetoes.
 */
export const inspectPoolHolders = ({ client, chains, pins }: {
  client: HolderEvidenceClientConfig
  chains: ReadonlyArray<DeletionIdentity>
  pins: ReadonlyArray<OwnedDeletionPins>
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const targets = yield* Effect.forEach(chains, (chain) => leaf(chain).pipe(
      Effect.map((identity) => ({ path: identity.path, identity })),
    ))
    const response = yield* readWorktreeHolderEvidence({ client, targets })
    const start = (yield* readProcessIdentity({ fs, pid: process.pid }))?.startTime
    if (!/^[1-9][0-9]*$/u.test(start ?? '')) return yield* hold('Current leader generation unavailable')
    let witnessed = false
    for (const root of response.roots) for (const ref of root.references) {
      if (ref.tgid !== process.pid || ref.tid !== process.pid || ref.leaderStart !== start ||
        ref.taskStart !== start || ref.effect !== 'in-use' ||
        !pins.some((view) => view.has({ kind: ref.reference, pid: ref.tgid, fd: ref.fd,
          dev: ref.identity.dev, ino: ref.identity.ino })))
        return yield* hold('Unowned, retained or nonleader holder reference')
      witnessed = true
    }
    if (!witnessed || start === undefined) return yield* hold('Authenticated current leader evidence missing')
    const actor: PoolActor = { hostId: response.hostId, bootId: response.bootId, pid: process.pid, startTime: start }
    return { response, actor }
  })

/** Fresh detached birth only. No recovery, adoption, reset, cleanup or removal.
 * Root activation must already be normally qualified; this function cannot qualify it.
 * Short GLOBAL permits only the existing read-only boot/clock freshness validator;
 * holder queries, native acquisition, Git, install and root IO stay outside it.
 */
export const warmPoolRoot = ({ base, bare, commit, limits, client, prewarmTasks }: {
  base: AbsoluteDirPath
  bare: string
  commit: string
  limits: { maxSlots: number; maxBytes: number }
  client: HolderEvidenceClientConfig
  prewarmTasks: ReadonlyArray<string>
}) => Effect.gen(function* () {
  yield* requireOutsidePoolGlobal(() => hold('Pool warming inside GLOBAL'))
  const fs = yield* FileSystem.FileSystem
  const canonicalStore = yield* fs.realPath(base)
  const canonicalBare = yield* fs.realPath(bare)
  if (!isAbsolute(bare) || canonicalBare !== resolve(bare) ||
    !canonicalBare.endsWith('/.bare') || !canonicalBare.startsWith(`${canonicalStore}/`) ||
    (yield* resolveGitCommonDir(canonicalBare)) !== canonicalBare ||
    !/^[0-9a-f]{40,64}$/u.test(commit) ||
    (yield* Git.resolveRef({ repoPath: canonicalBare, ref: `${commit}^{commit}` })) !== commit ||
    prewarmTasks.some((task) => !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(task)))
    return yield* hold('Exact canonical local source and declared task names required')
  const store = EffectPath.unsafe.absoluteDir(`${canonicalStore}/`)
  yield* poolParent(canonicalBare).pipe(withGitContainerLock({ path: canonicalBare, mode: 'shared' }))
  // One logical reservation unit, NOT a claim of measured or physical root bytes.
  const reserved = yield* withPoolState({ base: store, limits, use: (state, save) => Effect.gen(function* () {
    const reservation = yield* reserveFreshPoolRoot({ state, bare: canonicalBare, commit, charge: 1 })
    yield* save(reservation.state)
    return reservation.slot
  }) })
  return yield* Effect.gen(function* () {
    yield* withPoolState({ base: store, use: (state) => requirePoolSlotSnapshot({ state, expected: reserved }) })
    const lease = yield* acquireDeletionLease({ storeBasePath: store, ownerPath: reserved.path,
      now: Date.now(), persistent: true, activationIdentity: { storePath: canonicalStore, containerPath: canonicalBare } })
    const intent = yield* withPoolState({ base: store, use: (state, save) => Effect.gen(function* () {
      yield* requirePoolSlotSnapshot({ state, expected: reserved })
      yield* requireDisposablePoolRoot(reserved)
      const next = { ...yield* beginPoolPreparation({ state, id: reserved.id, generation: reserved.generation, path: reserved.path }), barrierToken: lease.token }
      yield* save({ ...state, slots: state.slots.map((slot) => slot.id === next.id ? next : slot) })
      return next
    }) })
    yield* createStoreWorktreeDetached({ storeBasePath: store, repoPath: canonicalBare,
      worktreePath: intent.path, commit, lockReason: `mr-pool:${intent.id}`, persistentLease: lease })
    const admin = yield* Git.getAbsoluteGitDir(intent.path)
    yield* inspectPoolGitSource({ slot: intent, admin })
    const initialChains = yield* Effect.all([capture(intent.path), capture(admin)])
    const preparedBirth = yield* withVerifiedDirectoryPins({
      targets: initialChains.map((identity) => ({ rootPath: '/', path: identity.at(-1)!.path, identity })),
      prepare: (pins) => Effect.gen(function* () {
        const sourceHistory = yield* inspectFreshPoolHeadHistory({ path: intent.path, admin, commit })
        const evidence = yield* inspectPoolHolders({ client, chains: initialChains, pins })
        const birth = { bootId: evidence.actor.bootId, root: initialChains[0]!, gitAdmin: initialChains[1]! }
        const next = yield* withPoolState({ base: store, use: (state, save) => Effect.gen(function* () {
          yield* assertWorktreeHolderEvidenceFresh(evidence.response)
          const physical = yield* bindPoolPhysicalBirth({ state, expected: intent, birth })
          const active: PoolSlot = { ...physical, lifecycle: { ...physical.lifecycle,
            birth: { generation: physical.generation, actor: evidence.actor, state: 'active' } } }
          yield* save({ ...state, slots: state.slots.map((slot) => slot.id === active.id ? active : slot) })
          return active
        }) })
        yield* preparePoolInstall(next.path)
        if (prewarmTasks.length !== 0) yield* runPoolTasks(next.path, prewarmTasks)
        const stopped = yield* stopWorktreeBuckDaemons({ worktreePath: next.path, reportRaces: false })
        yield* requirePoolBuckDrain(stopped)
        yield* inspectPoolGitSource({ slot: next, admin })
        return { slot: next, sourceHistory }
      }),
      commit: Effect.succeed,
    })
    const bound = preparedBirth.slot
    const installed = yield* inspectPoolInstall({ path: bound.path, commit, base: store })
    if (installed.sourceHistory.commit !== preparedBirth.sourceHistory.commit ||
      installed.sourceHistory.digest !== preparedBirth.sourceHistory.digest ||
      installed.sourceHistory.byteLength !== preparedBirth.sourceHistory.byteLength)
      return yield* hold('Fresh source history changed during preparation')
    const paths = [...new Set([bound.path, admin, ...installed.backingPaths])]
    const chains = yield* Effect.forEach(paths, capture)
    return yield* withVerifiedDirectoryPins({
      targets: chains.map((identity, index) => ({ rootPath: '/', path: paths[index]!, identity })),
      prepare: (pins) => Effect.gen(function* () {
        // Shared GVS is topology-pinned, not required to be globally idle.
        const current = yield* inspectPoolInstall({ path: bound.path, commit, base: store })
        if (current.identity !== installed.identity || current.backingPaths.length !== installed.backingPaths.length ||
          current.backingPaths.some((path, index) => path !== installed.backingPaths[index]))
          return yield* hold('Installed GVS binding changed')
        yield* inspectPoolGitSource({ slot: bound, admin })
        const charge = yield* poolBytes({ path: bound.path, kind: 'logical' })
        const evidence = yield* inspectPoolHolders({ client, chains: chains.slice(0, 2), pins })
        const birth = { bootId: evidence.actor.bootId, root: chains[0]!, gitAdmin: chains[1]! }
        yield* requirePoolPhysicalBirth({ slot: bound, birth })
        return { evidence, birth, identity: current.identity, charge }
      }),
      commit: (prepared) => withPoolState({ base: store, use: (state, save) => Effect.gen(function* () {
        yield* assertWorktreeHolderEvidenceFresh(prepared.evidence.response)
        yield* requirePoolSlotSnapshot({ state, expected: bound })
        yield* requireDisposablePoolRoot(bound)
        yield* requirePoolPhysicalBirth({ slot: bound, birth: prepared.birth })
        const ready = yield* finishPoolPreparation({ state, intent: bound, prepared })
        const next: PoolSlot = { ...ready, lifecycle: { ...ready.lifecycle,
          birth: { generation: ready.generation, actor: prepared.evidence.actor, state: 'terminal', outcome: 'success' } } }
        yield* save({ ...state, slots: state.slots.map((slot) => slot.id === next.id ? next : slot) })
        return next
      }) }),
    })
  }).pipe(withPoolRootActionLock(reserved.path))
})
