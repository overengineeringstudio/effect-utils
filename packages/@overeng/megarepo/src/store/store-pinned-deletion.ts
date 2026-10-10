import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs'
import { basename, isAbsolute, normalize, relative } from 'node:path'

import { Effect, Schema } from 'effect'

/** Serializable no-follow directory identities, ordered from filesystem root through the target. */
export const DeletionIdentity = Schema.Array(
  Schema.Struct({
    path: Schema.NonEmptyString,
    dev: Schema.String.check(Schema.isPattern(/^[0-9]+$/u)),
    ino: Schema.String.check(Schema.isPattern(/^[0-9]+$/u)),
  }),
).annotate({ identifier: 'Megarepo.DeletionIdentity' })
/** Exact ancestor and target identity captured before deletion authority is evaluated. */
export type DeletionIdentity = typeof DeletionIdentity.Type

/** Missing, replaced, unsupported, or unreadable deletion evidence always refuses removal. */
export class PinnedDeletionError extends Schema.TaggedError<PinnedDeletionError>()(
  'PinnedDeletionError',
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Capture every absolute ancestor without following symlinks, including ancestors above rootPath. */
export const captureDeletionIdentity = Effect.fn('store.captureDeletionIdentity')(function* ({
  rootPath,
  path,
}: {
  rootPath: string
  path: string
}) {
  return yield* Effect.acquireUseRelease(
    native({ path, operation: () => pinChain({ rootPath, path }) }),
    (chain) =>
      native({
        path,
        operation: () => {
          verifyChain(chain)
          return chain.map((entry) => entry.identity)
        },
      }),
    (chain) => Effect.sync(() => closeChain(chain)),
  )
})

/**
 * Pin the recorded chain before final authority checks, then quarantine and remove only through fds.
 * beforeRemove runs with every ancestor pinned, immediately before the final chain check/quarantine;
 * it also supplies the deterministic real-filesystem race seam without a production hook flag.
 * Linux /proc/self/fd is required. Other platforms and unavailable evidence fail closed.
 */
export const withPinnedDeletion = <TError = never, TRequirements = never>({
  rootPath,
  path,
  identity,
  beforeRemove,
}: {
  rootPath: string
  path: string
  identity: DeletionIdentity
  beforeRemove?: () => Effect.Effect<void, TError, TRequirements>
}): Effect.Effect<void, PinnedDeletionError | TError, TRequirements> =>
  Effect.acquireUseRelease(
    native({ path, operation: () => pinChain({ rootPath, path, identity }) }),
    (chain) =>
      Effect.gen(function* () {
        if (beforeRemove !== undefined) yield* beforeRemove()
        yield* native({ path, operation: () => quarantineAndRemove(chain) })
      }),
    (chain) => Effect.sync(() => closeChain(chain)),
  ).pipe(Effect.withSpan('store.withPinnedDeletion'))

// Effect FileSystem has no openat/no-follow directory primitive. Keep the Linux-native boundary
// synchronous so cancellation cannot strand an acquired fd or interrupt quarantine mid-operation.
type PinnedDirectory = {
  readonly fd: number
  readonly identity: DeletionIdentity[number]
}
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const fdPath = (fd: number): string => `/proc/self/fd/${fd}`
const fail = ({ path, message }: { path: string; message: string }): PinnedDeletionError =>
  new PinnedDeletionError({ path, message })
const native = <TResult>({ path, operation }: { path: string; operation: () => TResult }) =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof PinnedDeletionError
        ? cause
        : new PinnedDeletionError({
            path,
            message: 'Pinned deletion filesystem evidence is unavailable; refusing removal',
            cause,
          }),
  })
const sameIdentity = ({
  info,
  identity,
}: {
  info: BigIntStats
  identity: DeletionIdentity[number]
}): boolean => info.dev.toString() === identity.dev && info.ino.toString() === identity.ino
const assertDirectoryIdentity = ({
  path,
  info,
  identity,
}: {
  path: string
  info: BigIntStats
  identity: DeletionIdentity[number]
}): void => {
  if (info.isDirectory() === false || sameIdentity({ info, identity }) === false)
    throw fail({ path, message: 'Deletion directory identity changed; refusing removal' })
}
const closeChain = (chain: readonly PinnedDirectory[]): void => {
  for (let index = chain.length - 1; index >= 0; index--) closeSync(chain[index]!.fd)
}
const pinChain = ({
  rootPath,
  path,
  identity,
}: {
  rootPath: string
  path: string
  identity?: DeletionIdentity
}): readonly PinnedDirectory[] => {
  if (process.platform !== 'linux')
    throw fail({ path, message: 'Pinned store deletion requires Linux; refusing removal' })
  for (const value of [rootPath, path]) {
    if (
      isAbsolute(value) === false ||
      value.includes('\0') === true ||
      value.split('/').some((part) => part === '.' || part === '..') === true
    )
      throw fail({ path, message: 'Deletion requires absolute paths without traversal components' })
  }
  const normalizedRoot = normalize(rootPath)
  const normalizedTarget = normalize(path)
  const root = normalizedRoot === '/' ? '/' : normalizedRoot.replace(/\/$/u, '')
  const target = normalizedTarget === '/' ? '/' : normalizedTarget.replace(/\/$/u, '')
  const contained = relative(root, target)
  if (contained === '' || contained === '..' || contained.startsWith('../') === true)
    throw fail({ path, message: 'Deletion target must be strictly inside the admitted root' })
  const paths = ['/']
  let current = ''
  for (const part of target.split('/').filter((part) => part !== '')) {
    current += `/${part}`
    paths.push(current)
  }
  if (
    identity !== undefined &&
    (identity.length !== paths.length ||
      identity.some((entry, index) => entry.path !== paths[index]) === true)
  )
    throw fail({ path, message: 'Recorded deletion chain does not match the requested target' })
  const chain: PinnedDirectory[] = []
  try {
    for (const [index, entryPath] of paths.entries()) {
      const parent = chain[index - 1]
      const anchoredPath =
        parent === undefined ? '/' : `${fdPath(parent.fd)}/${basename(entryPath)}`
      const observed = lstatSync(anchoredPath, { bigint: true })
      const expected = identity?.[index] ?? {
        path: entryPath,
        dev: observed.dev.toString(),
        ino: observed.ino.toString(),
      }
      assertDirectoryIdentity({ path: entryPath, info: observed, identity: expected })
      const fd = openSync(anchoredPath, directoryFlags)
      chain.push({ fd, identity: expected })
      assertDirectoryIdentity({
        path: entryPath,
        info: fstatSync(fd, { bigint: true }),
        identity: expected,
      })
    }
    verifyChain(chain)
    return chain
  } catch (cause) {
    closeChain(chain)
    throw cause
  }
}
const verifyChain = (chain: readonly PinnedDirectory[]): void => {
  for (const [index, entry] of chain.entries()) {
    assertDirectoryIdentity({
      path: entry.identity.path,
      info: fstatSync(entry.fd, { bigint: true }),
      identity: entry.identity,
    })
    const parent = chain[index - 1]
    const anchoredPath =
      parent === undefined ? '/' : `${fdPath(parent.fd)}/${basename(entry.identity.path)}`
    assertDirectoryIdentity({
      path: entry.identity.path,
      info: lstatSync(anchoredPath, { bigint: true }),
      identity: entry.identity,
    })
  }
}
const removeDirectoryContents = ({
  fd,
  path,
  device,
}: {
  fd: number
  path: string
  device: bigint
}): void => {
  for (const name of readdirSync(fdPath(fd))) {
    const anchoredPath = `${fdPath(fd)}/${name}`
    const childPath = `${path}/${name}`
    const observed = lstatSync(anchoredPath, { bigint: true })
    if (observed.dev !== device)
      throw fail({
        path: childPath,
        message: 'Deletion crosses a filesystem boundary; refusing removal',
      })
    const identity = {
      path: childPath,
      dev: observed.dev.toString(),
      ino: observed.ino.toString(),
    }
    if (observed.isDirectory() === true) {
      const childFd = openSync(anchoredPath, directoryFlags)
      try {
        assertDirectoryIdentity({
          path: childPath,
          info: fstatSync(childFd, { bigint: true }),
          identity,
        })
        assertDirectoryIdentity({
          path: childPath,
          info: lstatSync(anchoredPath, { bigint: true }),
          identity,
        })
        removeDirectoryContents({ fd: childFd, path: childPath, device })
        assertDirectoryIdentity({
          path: childPath,
          info: lstatSync(anchoredPath, { bigint: true }),
          identity,
        })
        // rmdir never follows a substituted symlink; recursion used the pinned child fd only.
        rmdirSync(anchoredPath)
      } finally {
        closeSync(childFd)
      }
    } else {
      const current = lstatSync(anchoredPath, { bigint: true })
      if (sameIdentity({ info: current, identity }) === false || current.mode !== observed.mode)
        throw fail({ path: childPath, message: 'Deletion entry changed; refusing removal' })
      // unlink removes a symlink itself, never its referent.
      unlinkSync(anchoredPath)
    }
  }
}
const quarantineAndRemove = (chain: readonly PinnedDirectory[]): void => {
  const target = chain.at(-1)!
  const parent = chain.at(-2)!
  const targetPath = target.identity.path
  const quarantinePath = `${fdPath(parent.fd)}/.mr-delete-${randomUUID()}`
  mkdirSync(quarantinePath, { mode: 0o700 })
  let quarantineFd: number | undefined
  let quarantined = false
  let quarantineRemoved = false
  try {
    const quarantineInfo = lstatSync(quarantinePath, { bigint: true })
    const quarantineIdentity = {
      path: quarantinePath,
      dev: quarantineInfo.dev.toString(),
      ino: quarantineInfo.ino.toString(),
    }
    quarantineFd = openSync(quarantinePath, directoryFlags)
    assertDirectoryIdentity({
      path: quarantinePath,
      info: fstatSync(quarantineFd, { bigint: true }),
      identity: quarantineIdentity,
    })
    verifyChain(chain)
    const quarantinedPath = `${fdPath(quarantineFd)}/target`
    renameSync(`${fdPath(parent.fd)}/${basename(targetPath)}`, quarantinedPath)
    quarantined = true
    // A leaf replaced between the final check and rename is kept in quarantine, never removed.
    assertDirectoryIdentity({
      path: targetPath,
      info: lstatSync(quarantinedPath, { bigint: true }),
      identity: target.identity,
    })
    removeDirectoryContents({
      fd: target.fd,
      path: targetPath,
      device: fstatSync(target.fd, { bigint: true }).dev,
    })
    assertDirectoryIdentity({
      path: targetPath,
      info: lstatSync(quarantinedPath, { bigint: true }),
      identity: target.identity,
    })
    rmdirSync(quarantinedPath)
    quarantined = false
    assertDirectoryIdentity({
      path: quarantinePath,
      info: lstatSync(quarantinePath, { bigint: true }),
      identity: quarantineIdentity,
    })
    rmdirSync(quarantinePath)
    quarantineRemoved = true
  } finally {
    if (quarantineFd !== undefined) closeSync(quarantineFd)
    // Failed post-rename evidence deliberately leaves the quarantined data intact.
    if (quarantined === false && quarantineRemoved === false) {
      try {
        rmdirSync(quarantinePath)
      } catch {
        // A changed/nonempty entry is unknown and must be kept.
      }
    }
  }
}
