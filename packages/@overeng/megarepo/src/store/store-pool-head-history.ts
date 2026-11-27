import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { Effect } from 'effect'

import * as Git from '../core/git.ts'
import { requireOutsidePoolGlobal } from './store-pool-lock-order.ts'
import { PoolError } from './store-pool-state.ts'

/** Bound into the existing install identity; not a second ledger or authoring authority. */
export interface PoolHeadHistory {
  readonly commit: string
  readonly digest: string
  readonly byteLength: number
}

export interface PoolHeadHistoryTarget {
  readonly path: string
  readonly admin: string
  readonly commit: string
}

const hold = () => new PoolError({ message: 'Pool HEAD history cannot be proved; HOLD' })
const hash = (bytes: Uint8Array) => createHash('sha256').update('mr-pool-head-history-v1\0').update(bytes).digest('hex')
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const maxLogBytes = 32 * 1024 * 1024

/** Caller holds ROOT; publication requires a final reread under the actual registration pins. No repair. */
const readHistory = (target: PoolHeadHistoryTarget) => Effect.scoped(Effect.gen(function* () {
  yield* requireOutsidePoolGlobal(hold)
  if (!['linux', 'darwin'].includes(process.platform) || !isAbsolute(target.admin) || !commitPattern.test(target.commit) ||
    (yield* Git.getAbsoluteGitDir(target.path)) !== target.admin ||
    (yield* Git.getCurrentCommit(target.path)) !== target.commit)
    return yield* hold()
  const logging = yield* Git.runCommand({ args: ['config', '--get', 'core.logAllRefUpdates'], cwd: target.path })
  if (!['true', 'always'].includes(logging.toLowerCase())) return yield* hold()
  const path = join(target.admin, 'logs', 'HEAD')
  const prepared = yield* Effect.tryPromise({ try: () => lstat(path, { bigint: true }), catch: hold })
  if (!prepared.isFile() || prepared.nlink !== 1n) return yield* hold()
  const file = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
        (process.platform === 'darwin' ? 0x1000000 : 0o2000000)),
      catch: hold,
    }),
    (handle) => Effect.promise(() => handle.close()).pipe(Effect.orDie),
  )
  const bytes = yield* Effect.tryPromise({
    try: async () => {
      const before = await file.stat({ bigint: true })
      const namedBefore = await lstat(path, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n || process.getuid === undefined ||
        before.uid !== BigInt(process.getuid()) || before.size === 0n ||
        before.size > BigInt(maxLogBytes) || prepared.dev !== before.dev || prepared.ino !== before.ino || !namedBefore.isFile() ||
        namedBefore.dev !== before.dev || namedBefore.ino !== before.ino ||
        (await realpath(path)) !== path) throw hold()
      const content = Buffer.alloc(Number(before.size))
      let offset = 0
      while (offset < content.length) {
        const read = await file.read(content, offset, content.length - offset, offset)
        if (read.bytesRead === 0) throw hold()
        offset += read.bytesRead
      }
      const after = await file.stat({ bigint: true })
      const namedAfter = await lstat(path, { bigint: true })
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        after.nlink !== 1n || !namedAfter.isFile() || namedAfter.nlink !== 1n ||
        namedAfter.dev !== after.dev || namedAfter.ino !== after.ino ||
        namedAfter.size !== after.size || namedAfter.mtimeNs !== after.mtimeNs ||
        namedAfter.ctimeNs !== after.ctimeNs || (await realpath(path)) !== path) throw hold()
      return content
    },
    catch: hold,
  })
  if ((yield* Git.getCurrentCommit(target.path)) !== target.commit ||
    (yield* Git.runCommand({ args: ['config', '--get', 'core.logAllRefUpdates'], cwd: target.path })).toLowerCase() !== logging.toLowerCase())
    return yield* hold()
  const history: PoolHeadHistory = { commit: target.commit, digest: hash(bytes), byteLength: bytes.length }
  return { history, bytes }
}))

/** Strict raw OLD/NEW pairs: reflog expiry must not erase an authored OLD commit from proof. */
const transitionsMatch = ({ bytes, from, to }: { bytes: Buffer; from: string; to: string }) => {
  let offset = 0
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset)
    const width = to.length
    if (end < offset + width * 2 + 2 || bytes[offset + width] !== 32 ||
      bytes[offset + width * 2 + 1] !== 32) return false
    const oldCommit = bytes.toString('ascii', offset, offset + width)
    const newCommit = bytes.toString('ascii', offset + width + 1, offset + width * 2 + 1)
    if (oldCommit !== from || newCommit !== to) return false
    offset = end + 1
  }
  return true
}

/** Current bytes only. Existing roots require equality with the recorded install identity, never rebaseline. */
export const inspectPoolHeadHistory = (target: PoolHeadHistoryTarget) =>
  readHistory(target).pipe(Effect.map(({ history }) => history))

/** Fresh reserved UUID roots only; caller must separately prove origin/authored bit, Git and holders. */
export const inspectFreshPoolHeadHistory = (target: PoolHeadHistoryTarget) => Effect.gen(function* () {
  const { history, bytes } = yield* readHistory(target)
  let offset = 0
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset)
    if (end < 0) return yield* hold()
    const entry = bytes.subarray(offset, end + 1)
    if (!transitionsMatch({ bytes: entry, from: '0'.repeat(target.commit.length), to: target.commit }) &&
      !transitionsMatch({ bytes: entry, from: target.commit, to: target.commit })) return yield* hold()
    offset = end + 1
  }
  return history
})

/** After an owned checkout ONLY: old prefix unchanged, then only the expected checkout transitions. */
export const advancePoolHeadHistory = (args: PoolHeadHistoryTarget & { readonly previous: PoolHeadHistory }) => Effect.gen(function* () {
  const { previous, ...target } = args
  if (!commitPattern.test(previous.commit) || !/^[0-9a-f]{64}$/u.test(previous.digest) ||
    !Number.isSafeInteger(previous.byteLength) || previous.byteLength <= 0 || previous.byteLength > maxLogBytes)
    return yield* hold()
  const { history, bytes } = yield* readHistory(target)
  if (bytes.length < previous.byteLength || bytes[previous.byteLength - 1] !== 10 ||
    hash(bytes.subarray(0, previous.byteLength)) !== previous.digest)
    return yield* hold()
  const appended = bytes.subarray(previous.byteLength)
  if ((previous.commit !== target.commit && appended.length === 0) ||
    !transitionsMatch({ bytes: appended, from: previous.commit, to: target.commit })) return yield* hold()
  return history
})
