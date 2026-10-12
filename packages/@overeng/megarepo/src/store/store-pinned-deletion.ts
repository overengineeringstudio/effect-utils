import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs'
import { basename, isAbsolute, normalize, relative } from 'node:path'

import { Context, Effect, Option, Schema } from 'effect'

/** Injectable host platform for deletion policy; production uses the actual Node platform. */
export class StoreDeletionPlatform extends Context.Service<
  StoreDeletionPlatform,
  NodeJS.Platform
>()('megarepo/StoreDeletionPlatform') {}

/** Resolve the deletion-policy platform without requiring a service at the CLI boundary. */
export const storeDeletionPlatform = Effect.serviceOption(StoreDeletionPlatform).pipe(
  Effect.map((platform) => Option.getOrElse(platform, () => process.platform)),
)

const DecimalId = Schema.String.check(Schema.isPattern(/^[0-9]+$/u))

/**
 * Serializable no-follow directory identities, ordered from filesystem root through the target.
 * Every entry pins the Linux mount ID. Non-overlay directories also pin exact dev/ino. Overlay
 * directories bind by mount ID + path only: with layers on different filesystems and xino=off,
 * overlay directory st_ino is not persistent across inode eviction, so a plan-time inode cannot be
 * compared at apply time. Apply re-pins overlay directories and races are checked against the
 * dev/ino observed through the held fds.
 */
export const DeletionIdentity = Schema.Array(
  Schema.Union([
    Schema.TaggedStruct('Inode', {
      path: Schema.NonEmptyString,
      mountId: DecimalId,
      dev: DecimalId,
      ino: DecimalId,
    }),
    Schema.TaggedStruct('OverlayDirectory', {
      path: Schema.NonEmptyString,
      mountId: DecimalId,
    }),
  ]),
).annotate({ identifier: 'Megarepo.DeletionIdentity' })
/** Persisted mount/path binding, with exact inode identities on non-overlay filesystems. */
export type DeletionIdentity = typeof DeletionIdentity.Type

/**
 * Missing, replaced, unsupported, or unreadable deletion evidence always refuses removal.
 * partial is set only when in-place overlay removal already started at the original path, so
 * some entries there may be gone and a later plan must observe the remainder. Without partial,
 * the original path is untouched or the target was renamed into a quarantine that keeps any
 * remaining data out of the store path.
 */
export class PinnedDeletionError extends Schema.TaggedError<PinnedDeletionError>()(
  'PinnedDeletionError',
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    partial: Schema.optional(Schema.Literal(true)),
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
          return chain.map((entry) => entry.record)
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
  )

/** No-follow evidence for one directory, observed through a single held fd. */
export type DirectoryEvidence = {
  /** Linux mount ID from /proc/self/fdinfo; unique among mounts live in this mount namespace. */
  readonly mountId: string
  /** The directory lives on overlayfs, whose directory inode numbers may be non-persistent. */
  readonly overlay: boolean
  readonly stat: BigIntStats
}

/**
 * Open path as a directory without following a final symlink and read mount ID, overlay
 * membership, and fstat from that one fd. Synchronous; throws PinnedDeletionError when Linux
 * evidence is unavailable, path is a symlink or not a directory.
 */
export const readDirectoryEvidence = (path: string): DirectoryEvidence => {
  if (process.platform !== 'linux')
    throw fail({ path, message: 'Directory mount evidence requires Linux; refusing' })
  try {
    const fd = openSync(path, directoryFlags)
    try {
      return directoryEvidence({ fd, path })
    } finally {
      closeSync(fd)
    }
  } catch (cause) {
    throw cause instanceof PinnedDeletionError
      ? cause
      : new PinnedDeletionError({
          path,
          message: 'Directory mount evidence is unavailable; refusing',
          cause,
        })
  }
}

// Effect FileSystem has no openat/no-follow directory primitive. Keep the Linux-native boundary
// synchronous so cancellation cannot strand an acquired fd or interrupt quarantine mid-operation.
type PinnedDirectory = {
  readonly fd: number
  readonly path: string
  readonly mountId: string
  readonly overlay: boolean
  /** Observed through the held fd during this operation, never taken from a recorded plan. */
  readonly dev: bigint
  readonly ino: bigint
  readonly record: DeletionIdentity[number]
}
type PinnedInode = { readonly dev: bigint; readonly ino: bigint }
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const OVERLAYFS_SUPER_MAGIC = 0x794c7630n
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
const mountIdOf = ({ fd, path }: { fd: number; path: string }): string => {
  const mountId = /^mnt_id:\s*([0-9]+)\s*$/mu.exec(
    readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'),
  )?.[1]
  if (mountId === undefined)
    throw fail({ path, message: 'Directory mount ID is unavailable; refusing' })
  return mountId
}
const directoryEvidence = ({ fd, path }: { fd: number; path: string }): DirectoryEvidence => {
  const stat = fstatSync(fd, { bigint: true })
  if (stat.isDirectory() === false)
    throw fail({ path, message: 'Directory evidence requires a directory; refusing' })
  return {
    mountId: mountIdOf({ fd, path }),
    overlay: statfsSync(fdPath(fd), { bigint: true }).type === OVERLAYFS_SUPER_MAGIC,
    stat,
  }
}
const assertPinnedDirectory = ({
  path,
  info,
  pinned,
}: {
  path: string
  info: BigIntStats
  pinned: PinnedInode
}): void => {
  if (info.isDirectory() === false || info.dev !== pinned.dev || info.ino !== pinned.ino)
    throw fail({ path, message: 'Deletion directory identity changed; refusing removal' })
}
const recordFor = ({
  path,
  evidence,
}: {
  path: string
  evidence: DirectoryEvidence
}): DeletionIdentity[number] =>
  evidence.overlay === true
    ? { _tag: 'OverlayDirectory', path, mountId: evidence.mountId }
    : {
        _tag: 'Inode',
        path,
        mountId: evidence.mountId,
        dev: evidence.stat.dev.toString(),
        ino: evidence.stat.ino.toString(),
      }
const sameRecord = ({
  recorded,
  observed,
}: {
  recorded: DeletionIdentity[number]
  observed: DeletionIdentity[number]
}): boolean => {
  if (recorded.path !== observed.path || recorded.mountId !== observed.mountId) return false
  if (recorded._tag === 'OverlayDirectory') return observed._tag === 'OverlayDirectory'
  return observed._tag === 'Inode' && recorded.dev === observed.dev && recorded.ino === observed.ino
}
const closeChain = (chain: readonly PinnedDirectory[]): void => {
  for (let index = chain.length - 1; index >= 0; index--) closeSync(chain[index]!.fd)
}
const anchoredEntry = ({
  parent,
  path,
}: {
  parent: PinnedDirectory | undefined
  path: string
}): string => (parent === undefined ? '/' : `${fdPath(parent.fd)}/${basename(path)}`)
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
  for (const part of target.split('/').filter((segment) => segment !== '')) {
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
      const anchoredPath = anchoredEntry({ parent: chain[index - 1], path: entryPath })
      const observed = lstatSync(anchoredPath, { bigint: true })
      const recorded = identity?.[index]
      // A strict recorded inode is checked before opening; overlay entries carry no inode.
      if (
        observed.isDirectory() === false ||
        (recorded?._tag === 'Inode' &&
          (observed.dev.toString() !== recorded.dev || observed.ino.toString() !== recorded.ino))
      )
        throw fail({
          path: entryPath,
          message: 'Deletion directory identity changed; refusing removal',
        })
      const fd = openSync(anchoredPath, directoryFlags)
      let evidence: DirectoryEvidence
      try {
        evidence = directoryEvidence({ fd, path: entryPath })
      } catch (cause) {
        closeSync(fd)
        throw cause
      }
      const pinned: PinnedDirectory = {
        fd,
        path: entryPath,
        mountId: evidence.mountId,
        overlay: evidence.overlay,
        dev: evidence.stat.dev,
        ino: evidence.stat.ino,
        record: recordFor({ path: entryPath, evidence }),
      }
      chain.push(pinned)
      // The opened directory must be the one observed by lstat, and match the recorded plan.
      assertPinnedDirectory({ path: entryPath, info: observed, pinned })
      if (recorded !== undefined && sameRecord({ recorded, observed: pinned.record }) === false)
        throw fail({
          path: entryPath,
          message: 'Deletion directory identity changed; refusing removal',
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
    assertPinnedDirectory({
      path: entry.path,
      info: fstatSync(entry.fd, { bigint: true }),
      pinned: entry,
    })
    assertPinnedDirectory({
      path: entry.path,
      info: lstatSync(anchoredEntry({ parent: chain[index - 1], path: entry.path }), {
        bigint: true,
      }),
      pinned: entry,
    })
  }
}
const removeDirectoryContents = ({
  fd,
  path,
  mountId,
}: {
  fd: number
  path: string
  mountId: string
}): void => {
  for (const name of readdirSync(fdPath(fd))) {
    const anchoredPath = `${fdPath(fd)}/${name}`
    const childPath = `${path}/${name}`
    const observed = lstatSync(anchoredPath, { bigint: true })
    if (observed.isDirectory() === true) {
      const childFd = openSync(anchoredPath, directoryFlags)
      try {
        const info = fstatSync(childFd, { bigint: true })
        // Only traversed directories can cross mounts. mnt_id, not st_dev: overlayfs reports
        // per-layer st_dev for non-directories and a mount can reuse the parent's device.
        if (mountIdOf({ fd: childFd, path: childPath }) !== mountId)
          throw fail({
            path: childPath,
            message: 'Deletion crosses a mount boundary; refusing removal',
          })
        const pinned = { dev: info.dev, ino: info.ino }
        assertPinnedDirectory({ path: childPath, info, pinned })
        assertPinnedDirectory({ path: childPath, info: observed, pinned })
        removeDirectoryContents({ fd: childFd, path: childPath, mountId })
        assertPinnedDirectory({
          path: childPath,
          info: lstatSync(anchoredPath, { bigint: true }),
          pinned,
        })
        // rmdir never follows a substituted symlink; recursion used the pinned child fd only.
        rmdirSync(anchoredPath)
      } finally {
        closeSync(childFd)
      }
    } else {
      // Files and symlinks are never traversed, so no mount or device boundary applies.
      const current = lstatSync(anchoredPath, { bigint: true })
      if (
        current.dev !== observed.dev ||
        current.ino !== observed.ino ||
        current.mode !== observed.mode
      )
        throw fail({ path: childPath, message: 'Deletion entry changed; refusing removal' })
      // unlink removes a symlink itself, never its referent.
      unlinkSync(anchoredPath)
    }
  }
}
const quarantineAndRemove = (chain: readonly PinnedDirectory[]): void => {
  const target = chain.at(-1)!
  const parent = chain.at(-2)!
  const targetPath = target.path
  const targetEntry = `${fdPath(parent.fd)}/${basename(targetPath)}`
  const quarantinePath = `${fdPath(parent.fd)}/.mr-delete-${randomUUID()}`
  mkdirSync(quarantinePath, { mode: 0o700 })
  let quarantineFd: number | undefined
  let quarantined = false
  let quarantineRemoved = false
  try {
    const quarantineInfo = lstatSync(quarantinePath, { bigint: true })
    const quarantinePinned = { dev: quarantineInfo.dev, ino: quarantineInfo.ino }
    quarantineFd = openSync(quarantinePath, directoryFlags)
    assertPinnedDirectory({
      path: quarantinePath,
      info: fstatSync(quarantineFd, { bigint: true }),
      pinned: quarantinePinned,
    })
    verifyChain(chain)
    const quarantinedPath = `${fdPath(quarantineFd)}/target`
    let removalEntry = quarantinedPath
    try {
      renameSync(targetEntry, quarantinedPath)
      quarantined = true
    } catch (cause) {
      // Overlayfs without redirect_dir refuses renaming lower-backed directories with EXDEV.
      // Remove in place: contents still go only through the pinned target fd, and the final
      // rmdir neither follows a substituted symlink nor removes a nonempty replacement.
      const exdev = cause instanceof Error && 'code' in cause && cause.code === 'EXDEV'
      if (target.overlay === false || exdev === false) throw cause
      removalEntry = targetEntry
    }
    // A leaf replaced between the final check and rename is kept in quarantine, never removed.
    // Overlay copy-up on rename keeps the held inode, so the fd-observed identity stays valid.
    assertPinnedDirectory({
      path: targetPath,
      info: lstatSync(removalEntry, { bigint: true }),
      pinned: target,
    })
    try {
      removeDirectoryContents({ fd: target.fd, path: targetPath, mountId: target.mountId })
      assertPinnedDirectory({
        path: targetPath,
        info: lstatSync(removalEntry, { bigint: true }),
        pinned: target,
      })
      rmdirSync(removalEntry)
    } catch (cause) {
      if (removalEntry === quarantinedPath) throw cause
      // In-place traversal may already have removed entries at the original path.
      throw new PinnedDeletionError({
        path: cause instanceof PinnedDeletionError ? cause.path : targetPath,
        message:
          cause instanceof PinnedDeletionError
            ? cause.message
            : 'In-place overlay deletion failed after removal started; refusing further removal',
        cause,
        partial: true,
      })
    }
    quarantined = false
    assertPinnedDirectory({
      path: quarantinePath,
      info: lstatSync(quarantinePath, { bigint: true }),
      pinned: quarantinePinned,
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
