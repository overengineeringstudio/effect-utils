import { dlopen, read as ffiRead } from 'bun:ffi'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import {
  constants,
  linkSync,
  lstatSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const batchSize = 128
const blobNamePattern = /^([a-f0-9]{64})-(0444|0555)$/
const shardPattern = /^[a-f0-9]{2}$/
const temporaryPattern = /^\.tmp-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
/** Private, rebuildable source-stat hints stored in each finite generation. */
export const editorViewSourceManifestName = 'editor-view-sources-v1.json'
/** A source inode key and its proved immutable content-store address. */
export type EditorViewSourceFile = {
  readonly sourceKey: string
  readonly digest: string
  readonly mode: number
  readonly blobKey: string
}
/** Encode source metadata, omitting ctime only for immutable shared inodes. */
export const editorViewSourceKey = (status: BigIntStats): string => verificationKey(status)
/** Read validated source hints; every reuse still requires the full payload proof. */
export const readEditorViewSourceManifest = (path: string): Map<string, EditorViewSourceFile> => {
  let raw: unknown
  try {
    const status = lstatSync(path, { bigint: true })
    requireBlob({ path, status, mode: 0o444 })
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (hasCode({ error, code: 'ENOENT' }) === true) return new Map()
    throw error
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) === true)
    return fail(`invalid source manifest: ${path}`)
  const entries = new Map<string, EditorViewSourceFile>()
  for (const [source, entry] of Object.entries(raw)) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('sourceKey' in entry) ||
      typeof entry.sourceKey !== 'string' ||
      !('digest' in entry) ||
      typeof entry.digest !== 'string' ||
      /^[a-f0-9]{64}$/.test(entry.digest) === false ||
      !('mode' in entry) ||
      (entry.mode !== 0o444 && entry.mode !== 0o555) ||
      !('blobKey' in entry) ||
      typeof entry.blobKey !== 'string'
    )
      return fail(`invalid source manifest entry: ${path}`)
    entries.set(source, {
      sourceKey: entry.sourceKey,
      digest: entry.digest,
      mode: entry.mode,
      blobKey: entry.blobKey,
    })
  }
  return entries
}

const fail: (message: string) => never = (message) => {
  throw new Error(`editor view sharing: ${message}`)
}

const hasCode = ({ error, code }: { readonly error: unknown; readonly code: string }): boolean =>
  error instanceof Error && 'code' in error && error.code === code

const userId = (): bigint => {
  const uid = process.getuid?.()
  return uid === undefined ? fail('content sharing requires POSIX user ownership') : BigInt(uid)
}

const statusIfPresent = async (path: string): Promise<BigIntStats | undefined> => {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (hasCode({ error: error, code: 'ENOENT' }) === true) return undefined
    throw error
  }
}

const unlinkIfPresent = async (path: string): Promise<void> => {
  try {
    await unlink(path)
  } catch (error) {
    if (hasCode({ error: error, code: 'ENOENT' }) === false) throw error
  }
}

const permissions = (status: BigIntStats): bigint => status.mode & 0o7777n
const isImmutable = (status: BigIntStats): boolean =>
  permissions(status) === 0o444n || permissions(status) === 0o555n
const sameInode = ({
  left,
  right,
}: {
  readonly left: BigIntStats
  readonly right: BigIntStats
}): boolean => left.dev === right.dev && left.ino === right.ino

// Readonly hardlinks legitimately change ctime/nlink in other worktrees. Content,
// identity and mode must still agree; writable files also require stable ctime.
const unchanged = ({
  left,
  right,
}: {
  readonly left: BigIntStats
  readonly right: BigIntStats
}): boolean =>
  sameInode({ left: left, right: right }) === true &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.mode === right.mode &&
  left.uid === right.uid &&
  (left.ctimeNs === right.ctimeNs ||
    (isImmutable(left) === true &&
      isImmutable(right) === true &&
      (left.nlink > 1n || right.nlink > 1n)))

const requireOwned = ({
  path,
  status,
}: {
  readonly path: string
  readonly status: BigIntStats
}): void => {
  if (status.uid !== userId()) fail(`entry must be owned by the current user: ${path}`)
}

const requireRealDirectory = async ({
  path,
  status,
}: {
  readonly path: string
  readonly status: BigIntStats
}): Promise<void> => {
  if (status.isDirectory() === false || (await realpath(path)) !== path)
    fail(`directory must be canonical and real, without symbolic links: ${path}`)
}

class WritableBlobTrustError extends Error {
  constructor(path: string) {
    super(
      `editor view sharing: writable blob is not trusted: ${path}; stop all editor-view readers/writers, then run editor-view.ts repair-content --repo-root <repo> --quiesced true`,
    )
    this.name = 'WritableBlobTrustError'
  }
}

const requireBlob = ({
  path,
  status,
  mode,
}: {
  readonly path: string
  readonly status: BigIntStats
  readonly mode: number
}): void => {
  if (status.isFile() === false)
    fail(`blob must be a real regular file, not a symbolic link: ${path}`)
  requireOwned({ path: path, status: status })
  if ((status.mode & 0o222n) !== 0n) throw new WritableBlobTrustError(path)
  if (permissions(status) !== BigInt(mode)) fail(`blob mode does not match its address: ${path}`)
}

/** Resolve Git's shared administration directory without invoking Git or megarepo. */
export const editorViewGitCommonDirectory = (repoRoot: string): string | undefined => {
  const gitPath = join(resolve(repoRoot), '.git')
  let gitStatus: BigIntStats
  try {
    gitStatus = lstatSync(gitPath, { bigint: true })
  } catch (error) {
    if (hasCode({ error: error, code: 'ENOENT' }) === true) return undefined
    throw error
  }
  let gitDirectory: string
  if (gitStatus.isDirectory() === true) gitDirectory = realpathSync(gitPath)
  else if (gitStatus.isFile() === true) {
    const match = /^gitdir: (.+?)(?:\r?\n)?$/.exec(readFileSync(gitPath, 'utf8'))
    if (match === null || match[1] === undefined) fail(`invalid Git gitdir file: ${gitPath}`)
    gitDirectory = realpathSync(resolve(dirname(gitPath), match[1]))
  } else return fail(`Git administration entry must be a real directory or gitdir file: ${gitPath}`)
  let commonDirectory = gitDirectory
  const commonPath = join(gitDirectory, 'commondir')
  let common: string | undefined
  try {
    common = readFileSync(commonPath, 'utf8').trim()
  } catch (error) {
    if (hasCode({ error: error, code: 'ENOENT' }) === false) throw error
  }
  if (common !== undefined) {
    if (common.length === 0 || common.includes('\n') === true || common.includes('\r') === true)
      fail(`invalid Git commondir file: ${commonPath}`)
    commonDirectory = realpathSync(resolve(gitDirectory, common))
  }
  if (lstatSync(commonDirectory).isDirectory() === false)
    fail(`Git common administration path is not a directory: ${commonDirectory}`)
  return commonDirectory
}

/** Resolve the host-local content store shared by registered Git worktrees. */
export const defaultEditorViewContentStore = (repoRoot: string): string => {
  const override = process.env.EDITOR_VIEW_CONTENT_STORE
  if (override !== undefined) {
    if (override.length === 0) fail('EDITOR_VIEW_CONTENT_STORE must not be empty')
    return resolve(override)
  }
  const commonDirectory = editorViewGitCommonDirectory(repoRoot)
  return commonDirectory === undefined
    ? join(homedir(), '.cache', 'effect-utils', 'editor-view-content', 'v1')
    : join(dirname(commonDirectory), '.editor-view-content', 'v1')
}

const lockPath = (contentStore: string): string => `${contentStore}.flock`
const libcPath =
  process.platform === 'darwin'
    ? '/usr/lib/libSystem.B.dylib'
    : process.platform === 'linux'
      ? 'libc.so.6'
      : fail(`flock content stores require Linux or macOS: ${process.platform}`)
const libc = dlopen(libcPath, {
  flock: { args: ['i32', 'i32'], returns: 'i32' },
})
/* eslint-disable no-underscore-dangle -- These exported errno symbol names are fixed by the native libc ABI. */
const errnoAddress =
  process.platform === 'darwin'
    ? dlopen(libcPath, { __error: { args: [], returns: 'ptr' } }).symbols.__error
    : dlopen(libcPath, { __errno_location: { args: [], returns: 'ptr' } }).symbols.__errno_location
/* eslint-enable no-underscore-dangle */
const closeOnExec = process.platform === 'darwin' ? 0x1000000 : 0x80000

let getDescriptorFlags: ((fd: number) => number) | undefined
/** Load the packaged fixed-arity ABI only when a lease/control descriptor needs it. */
export const editorViewDescriptorFlags = (fd: number): number => {
  if (getDescriptorFlags === undefined) {
    const library = process.env.EDITOR_VIEW_LEASE_LIBRARY
    if (library === undefined || isAbsolute(library) === false)
      fail(
        'EDITOR_VIEW_LEASE_LIBRARY must name the absolute packaged native library; enter the repository development environment',
      )
    getDescriptorFlags = dlopen(library, {
      eu_getfd: { args: ['i32'], returns: 'i32' },
    }).symbols.eu_getfd
  }
  return getDescriptorFlags(fd)
}

/* eslint-disable no-await-in-loop -- The kernel lock arbitrates ownership; the delay only avoids busy-waiting and lets same-process holders finish. */
const acquireLock = async ({
  contentStore,
  afterStoreLockContended,
}: {
  readonly contentStore: string
  readonly afterStoreLockContended?: (() => void | Promise<void>) | undefined
}): Promise<FileHandle> => {
  const path = lockPath(contentStore)
  const file = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | closeOnExec,
    0o600,
  )
  let acquired = false
  try {
    const status = await file.stat({ bigint: true })
    requireOwned({ path, status })
    if (
      status.isFile() === false ||
      permissions(status) !== 0o600n ||
      status.nlink !== 1n ||
      status.size > 1n
    )
      fail(`flock control must be a private same-user regular file: ${path}`)
    const descriptorFlags = editorViewDescriptorFlags(file.fd)
    if (descriptorFlags < 0 || (descriptorFlags & 1) !== 1)
      fail(`flock control descriptor is not close-on-exec: ${path}`)
    let contended = false
    while (libc.symbols.flock(file.fd, 2 | 4) !== 0) {
      const pointer = errnoAddress()
      if (pointer === null) fail('libc did not expose flock errno')
      const errno = ffiRead.i32(pointer)
      if (errno === 4) continue
      if (errno !== (process.platform === 'darwin' ? 35 : 11))
        fail(`flock failed for ${path}: errno=${errno}`)
      if (contended === false) {
        contended = true
        await afterStoreLockContended?.()
      }
      await setTimeout(5)
    }
    const named = await lstat(path, { bigint: true })
    if (sameInode({ left: status, right: named }) === false || named.nlink !== 1n)
      fail(`persistent flock control was replaced or linked: ${path}`)
    acquired = true
    return file
  } finally {
    if (acquired === false) await file.close()
  }
}
/* eslint-enable no-await-in-loop */

/* eslint-disable no-await-in-loop -- Parent admission and creation follow ancestor order; children cannot precede verified parents. */
const ensureParent = async ({
  contentStore,
  create,
}: {
  readonly contentStore: string
  readonly create: boolean
}): Promise<BigIntStats> => {
  const parent = dirname(contentStore)
  if (parent === contentStore) fail('content store must not be the filesystem root')
  const missing: string[] = []
  let ancestor = parent
  let status = await statusIfPresent(ancestor)
  while (status === undefined) {
    if (create === false) fail(`content-store control parent does not exist: ${parent}`)
    missing.push(ancestor)
    ancestor = dirname(ancestor)
    status = await statusIfPresent(ancestor)
  }
  await requireRealDirectory({ path: ancestor, status: status })
  for (const directory of missing.toReversed()) {
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if (hasCode({ error: error, code: 'EEXIST' }) === false) throw error
    }
    const created = await lstat(directory, { bigint: true })
    await requireRealDirectory({ path: directory, status: created })
    requireOwned({ path: directory, status: created })
  }
  const parentStatus = await lstat(parent, { bigint: true })
  await requireRealDirectory({ path: parent, status: parentStatus })
  const root = await statusIfPresent(contentStore)
  if (root !== undefined && root.dev !== parentStatus.dev)
    fail(
      `content store must be a child directory on the same device as its sibling control area, not a filesystem mountpoint: ${contentStore}; choose a path such as /dev/shm/editor-view-content/v1, not /dev/shm`,
    )
  requireOwned({ path: parent, status: parentStatus })
  if ((parentStatus.mode & 0o022n) !== 0n)
    fail(`content-store control parent must not be group/other writable: ${parent}`)
  return parentStatus
}
/* eslint-enable no-await-in-loop */

const validateDirectory = async ({
  path,
  contentStore,
}: {
  readonly path: string
  readonly contentStore: string
}): Promise<BigIntStats | undefined> => {
  const status = await statusIfPresent(path)
  if (status === undefined) return undefined
  await requireRealDirectory({ path, status })
  requireOwned({ path, status })
  if (permissions(status) === 0o555n) return status
  // A concurrent batch or interrupted writer may leave a writable directory.
  // Only kernel exclusion and its repair step can disambiguate that observation.
  return withStoreLock({
    contentStore,
    run: async () => {
      const current = await statusIfPresent(path)
      if (current === undefined) return undefined
      if (sameInode({ left: status, right: current }) === false || permissions(current) !== 0o555n)
        fail(`content-store directory changed during locked validation: ${path}`)
      return current
    },
  })
}

type OpenDirectory = {
  readonly path: string
  readonly file: FileHandle
  status: BigIntStats
  writable: boolean
}
type Directories = Map<string, OpenDirectory>

const openDirectory = async ({
  path,
  directories,
}: {
  readonly path: string
  readonly directories: Directories
}): Promise<OpenDirectory> => {
  const previous = directories.get(path)
  if (previous !== undefined) return previous
  const status = await lstat(path, { bigint: true })
  await requireRealDirectory({ path: path, status: status })
  requireOwned({ path: path, status: status })
  if (permissions(status) !== 0o555n) fail(`content-store directory is not readonly: ${path}`)
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat({ bigint: true })
    if (
      sameInode({ left: status, right: opened }) === false ||
      opened.mode !== status.mode ||
      opened.uid !== status.uid
    )
      fail(`content-store directory changed while opening: ${path}`)
    const directory = { path, file, status, writable: false }
    directories.set(path, directory)
    return directory
  } catch (error) {
    await file.close()
    throw error
  }
}

const makeWritable = async (directory: OpenDirectory): Promise<void> => {
  if (directory.writable === true) return
  const current = await lstat(directory.path, { bigint: true })
  if (
    sameInode({ left: directory.status, right: current }) === false ||
    current.mode !== directory.status.mode
  )
    fail(`content-store directory changed before writing: ${directory.path}`)
  directory.writable = true
  await directory.file.chmod(0o755)
}

const createDirectory = async ({
  path,
  directories,
}: {
  readonly path: string
  readonly directories: Directories
}): Promise<void> => {
  await mkdir(path, { mode: 0o555 })
  // The inode is private to the held lock; normalize a restrictive umask without
  // ever opening a caller-provided symlink for chmod. Register its descriptor
  // before normalization so failure still attempts readonly restoration.
  const status = await lstat(path, { bigint: true })
  await requireRealDirectory({ path: path, status: status })
  requireOwned({ path: path, status: status })
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let registered = false
  try {
    if (sameInode({ left: status, right: await file.stat({ bigint: true }) }) === false)
      fail(`new content-store directory changed: ${path}`)
    const directory: OpenDirectory = { path, file, status, writable: true }
    directories.set(path, directory)
    registered = true
    if (permissions(status) !== 0o555n) await file.chmod(0o555)
    directory.status = await file.stat({ bigint: true })
    directory.writable = false
  } finally {
    if (registered === false) await file.close()
  }
}

const storeDirectory = async ({
  contentStore,
  directories,
  create,
}: {
  readonly contentStore: string
  readonly directories: Directories
  readonly create: boolean
}): Promise<OpenDirectory | undefined> => {
  if ((await statusIfPresent(contentStore)) === undefined) {
    if (create === false) return undefined
    await createDirectory({ path: contentStore, directories: directories })
  }
  return openDirectory({ path: contentStore, directories: directories })
}

const shardDirectory = async ({
  contentStore,
  shard,
  directories,
  create,
}: {
  readonly contentStore: string
  readonly shard: string
  readonly directories: Directories
  readonly create: boolean
}): Promise<OpenDirectory | undefined> => {
  const root = await storeDirectory({
    contentStore: contentStore,
    directories: directories,
    create: create,
  })
  if (root === undefined) return undefined
  const path = join(contentStore, shard)
  if ((await statusIfPresent(path)) === undefined) {
    if (create === false) return undefined
    await makeWritable(root)
    await createDirectory({ path: path, directories: directories })
  }
  return openDirectory({ path: path, directories: directories })
}

/* eslint-disable no-await-in-loop -- Bounded owned directory handles must settle restoration before the exclusive lock is released. */
const withStoreLock = async <T>({
  contentStore,
  afterStoreLock,
  writableRepair,
  afterStoreLockContended,
  run,
}: {
  readonly contentStore: string
  readonly afterStoreLock?: (() => void | Promise<void>) | undefined
  readonly writableRepair?: EditorViewContentRepair
  readonly afterStoreLockContended?: (() => void | Promise<void>) | undefined
  readonly run: (directories: Directories) => Promise<T>
}): Promise<T> => {
  await ensureParent({ contentStore, create: true })
  const lock = await acquireLock({ contentStore, afterStoreLockContended })
  try {
    const marker = Buffer.alloc(1)
    const { bytesRead } = await lock.read(marker, 0, 1, 0)
    if (bytesRead === 1 && marker[0] !== 48 && marker[0] !== 49)
      fail(`invalid flock dirty marker: ${lockPath(contentStore)}`)
    // Mark before repair too: a crash during repair must leave the next holder
    // able to finish it. Only successful directory restoration clears this byte.
    await lock.write('1', 0, 'utf8')
    await repairStore({
      contentStore,
      dirty: bytesRead === 0 || marker[0] === 49 || writableRepair !== undefined,
      ...(writableRepair === undefined ? {} : { writableRepair }),
    })
    const directories: Directories = new Map()
    let outcome: { readonly value: T } | { readonly error: unknown }
    try {
      await afterStoreLock?.()
      outcome = { value: await run(directories) }
    } catch (error) {
      outcome = { error }
    }
    const errors: unknown[] = []
    for (const directory of directories.values()) {
      try {
        if (directory.writable === true) await directory.file.chmod(0o555)
        const current = await lstat(directory.path, { bigint: true })
        if (
          sameInode({ left: directory.status, right: current }) === false ||
          permissions(current) !== 0o555n
        )
          fail(`content-store directory changed while restoring readonly mode: ${directory.path}`)
      } catch (error) {
        errors.push(error)
      } finally {
        try {
          await directory.file.close()
        } catch (error) {
          errors.push(error)
        }
      }
    }
    if (errors.length !== 0)
      throw new AggregateError(
        'error' in outcome ? [outcome.error, ...errors] : errors,
        'editor view sharing: readonly restoration failed; next flock acquire repairs the store',
      )
    if ('error' in outcome) throw outcome.error
    await lock.write('0', 0, 'utf8')
    return outcome.value
  } finally {
    // flock ownership belongs to this open description, never to a pathname or
    // owner record. Close releases it on success, failure, and process death.
    await lock.close()
  }
}
/* eslint-enable no-await-in-loop */

/** Serialize generation pins/retirement with the same metadata exclusion as CAS links and GC. */
export const withEditorViewContentStoreLock = async <T>({
  contentStore,
  afterStoreLockContended,
  run,
}: {
  readonly contentStore: string
  readonly afterStoreLockContended?: () => void | Promise<void>
  readonly run: () => Promise<T>
}): Promise<T> =>
  withStoreLock({ contentStore: resolve(contentStore), afterStoreLockContended, run })

// This is only an optimization of immutable inode verification, never an index.
// Bound retained metadata; only readonly shared inodes may omit their mutable ctime.
const verified = new Map<string, string>()
const verificationKey = (status: BigIntStats): string =>
  `${status.dev}:${status.ino}:${status.size}:${status.mtimeNs}:${status.mode}:${status.uid}:${isImmutable(status) === true && status.nlink > 1n ? '' : status.ctimeNs}`
const remember = ({
  status,
  digest,
}: {
  readonly status: BigIntStats
  readonly digest: string
}): void => {
  const key = verificationKey(status)
  if (verified.has(key) === false && verified.size >= 65_536) {
    const oldest = verified.keys().next().value
    if (oldest !== undefined) verified.delete(oldest)
  }
  verified.set(key, digest)
}

const fingerprint = async ({
  path,
  expected,
  mayDisappear = false,
}: {
  readonly path: string
  readonly expected: BigIntStats
  readonly mayDisappear?: boolean
}): Promise<string | undefined> => {
  const cached = verified.get(verificationKey(expected))
  if (cached !== undefined && isImmutable(expected) === true) return cached
  let file: FileHandle
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (mayDisappear === true && hasCode({ error: error, code: 'ENOENT' }) === true)
      return undefined
    throw error
  }
  try {
    const before = await file.stat({ bigint: true })
    if (before.isFile() === false || unchanged({ left: expected, right: before }) === false) {
      if (
        mayDisappear === true &&
        (sameInode({ left: expected, right: before }) === false ||
          (await statusIfPresent(path)) === undefined)
      )
        return undefined
      fail(`payload changed before hashing: ${path}`)
    }
    const digestBytes =
      before.size <= 65_536n
        ? Buffer.from(await webcrypto.subtle.digest('SHA-256', await file.readFile()))
        : undefined
    const hash = digestBytes === undefined ? createHash('sha256') : undefined
    if (hash !== undefined)
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    if (unchanged({ left: before, right: await file.stat({ bigint: true }) }) === false) {
      if (mayDisappear === true && (await statusIfPresent(path)) === undefined) return undefined
      fail(`payload changed while hashing: ${path}`)
    }
    const named = await statusIfPresent(path)
    if (named === undefined || sameInode({ left: before, right: named }) === false) {
      if (mayDisappear === true) return undefined
      fail(`payload disappeared or was replaced while hashing: ${path}`)
    }
    if (unchanged({ left: before, right: named }) === false)
      fail(`payload changed while hashing: ${path}`)
    const digest = digestBytes?.toString('hex') ?? hash!.digest('hex')
    if (isImmutable(before) === true) remember({ status: before, digest: digest })
    return digest
  } finally {
    await file.close()
  }
}

const regularFiles = async function* ({
  directory,
  root = directory,
}: {
  readonly directory: string
  readonly root?: string
}): AsyncGenerator<string> {
  const status = await lstat(directory, { bigint: true })
  await requireRealDirectory({ path: directory, status: status })
  requireOwned({ path: directory, status: status })
  if ((status.mode & 0o200n) === 0n) {
    // A byte-owned copy can retain readonly source directory modes. Only its
    // private directories need write permission for atomic payload substitution;
    // the publisher hardens them again before promoting any pointer.
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      if (sameInode({ left: status, right: await handle.stat({ bigint: true }) }) === false)
        fail(`candidate directory changed before preparation: ${directory}`)
      await handle.chmod(Number(permissions(status) | 0o200n))
      if (sameInode({ left: status, right: await lstat(directory, { bigint: true }) }) === false)
        fail(`candidate directory changed during preparation: ${directory}`)
    } finally {
      await handle.close()
    }
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() === true) yield* regularFiles({ directory: path, root: root })
    else if (
      entry.isFile() === true &&
      (directory !== root ||
        (entry.name !== 'editor-view.json' && entry.name !== editorViewSourceManifestName))
    )
      yield path
    // Admitted symlinks are not payload files and are never followed or changed.
  }
}

const normalizeCandidate = async (path: string): Promise<BigIntStats> => {
  const expected = await lstat(path, { bigint: true })
  if (expected.isFile() === false) fail(`candidate payload is not a regular file: ${path}`)
  requireOwned({ path: path, status: expected })
  if (isImmutable(expected) === true) return expected
  const mode = (expected.mode & 0o111n) === 0n ? 0o444 : 0o555
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat({ bigint: true })
    if (unchanged({ left: expected, right: before }) === false)
      fail(`candidate payload changed before normalization: ${path}`)
    // A same-mode chmod would change ctime on an already shared readonly inode.
    if (permissions(before) !== BigInt(mode)) await file.chmod(mode)
    const after = await file.stat({ bigint: true })
    if (
      sameInode({ left: before, right: after }) === false ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.uid !== after.uid ||
      permissions(after) !== BigInt(mode) ||
      unchanged({ left: after, right: await lstat(path, { bigint: true }) }) === false
    )
      fail(`candidate payload changed while normalizing: ${path}`)
    return after
  } finally {
    await file.close()
  }
}

const validateBlob = async ({
  contentStore,
  path,
  digest,
  mode,
}: {
  readonly contentStore: string
  readonly path: string
  readonly digest: string
  readonly mode: number
}): Promise<BigIntStats | undefined> => {
  if ((await validateDirectory({ path: contentStore, contentStore: contentStore })) === undefined)
    return undefined
  if ((await validateDirectory({ path: dirname(path), contentStore: contentStore })) === undefined)
    return undefined
  const status = await statusIfPresent(path)
  if (status === undefined) return undefined
  requireBlob({ path: path, status: status, mode: mode })
  const actual = await fingerprint({ path: path, expected: status, mayDisappear: true })
  if (actual === undefined) return undefined
  if (actual !== digest) fail(`blob content does not match its address: ${path}`)
  return status
}

type PreparedFile = {
  readonly path: string
  readonly status: BigIntStats
  readonly digest: string
  readonly mode: number
  readonly blob: string
  /** Set only after the kernel rejects a candidate-to-store hardlink with EXDEV. */
  requiresCopy?: true
  copy?: { readonly path: string; readonly status: BigIntStats }
}

const stagingDirectory = async ({
  contentStore,
  directories,
  create,
}: {
  readonly contentStore: string
  readonly directories: Directories
  readonly create: boolean
}): Promise<OpenDirectory | undefined> => {
  const root = await storeDirectory({ contentStore, directories, create })
  if (root === undefined) return undefined
  const path = join(contentStore, stagingDirectoryName)
  if ((await statusIfPresent(path)) === undefined) {
    if (create === false) return undefined
    await makeWritable(root)
    await createDirectory({ path, directories })
  }
  return openDirectory({ path, directories })
}

/* eslint-disable no-await-in-loop -- Recognized staged links are removed serially under the bounded metadata lock. */
const removePreparedCopies = async ({
  contentStore,
  paths,
}: {
  readonly contentStore: string
  readonly paths: readonly string[]
}): Promise<void> => {
  if (paths.length === 0) return
  await withStoreLock({
    contentStore,
    run: async (directories) => {
      const directory = await stagingDirectory({ contentStore, directories, create: false })
      if (directory === undefined) return
      for (const path of paths) {
        if (dirname(path) !== directory.path || stagingPattern.test(basename(path)) === false)
          fail(`prepared copy is outside recognized staging: ${path}`)
        const status = await statusIfPresent(path)
        if (status === undefined) continue
        if (status.isFile() === false) fail(`prepared copy is not a regular file: ${path}`)
        requireOwned({ path, status })
        await makeWritable(directory)
        await unlink(path)
      }
    },
  })
}
/* eslint-enable no-await-in-loop */

/* eslint-disable no-await-in-loop -- Cross-device bytes stream through one reusable buffer outside metadata exclusion. */
const prepareCopy = async ({
  contentStore,
  file,
}: {
  readonly contentStore: string
  readonly file: PreparedFile
}): Promise<void> => {
  if (file.copy !== undefined) return
  const identity = editorViewStagingCreatorIdentity({ pid: process.pid })
  if (identity === 'dead') fail('copy creator unexpectedly has no live process incarnation')
  const temporary = join(
    contentStore,
    stagingDirectoryName,
    `${process.pid}-${identity}-${randomUUID()}.tmp`,
  )
  let created: FileHandle | undefined
  let complete = false
  try {
    const destination = await withStoreLock({
      contentStore,
      run: async (directories) => {
        const directory = await stagingDirectory({ contentStore, directories, create: true })
        if (directory === undefined) fail(`staging directory is absent: ${temporary}`)
        await makeWritable(directory)
        const output = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            closeOnExec,
          0o600,
        )
        created = output
        await output.chmod(0o600)
        return output
      },
    })
    const source = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (unchanged({ left: file.status, right: await source.stat({ bigint: true }) }) === false)
        fail(`candidate payload changed before copying: ${file.path}`)
      const buffer = Buffer.allocUnsafe(64 * 1_024)
      let position = 0
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        let written = 0
        while (written < bytesRead) {
          const { bytesWritten } = await destination.write(
            buffer,
            written,
            bytesRead - written,
            position + written,
          )
          if (bytesWritten === 0) fail(`copy made no progress: ${temporary}`)
          written += bytesWritten
        }
        position += bytesRead
      }
      if (
        unchanged({ left: file.status, right: await source.stat({ bigint: true }) }) === false ||
        unchanged({ left: file.status, right: await lstat(file.path, { bigint: true }) }) === false
      )
        fail(`candidate payload changed while copying: ${file.path}`)
    } finally {
      await source.close()
    }
    await destination.chmod(file.mode)
    const status = await destination.stat({ bigint: true })
    if (
      sameInode({ left: status, right: await lstat(temporary, { bigint: true }) }) === false ||
      status.nlink !== 1n
    )
      fail(`private staged copy changed during preparation: ${temporary}`)
    requireBlob({ path: temporary, status, mode: file.mode })
    if ((await fingerprint({ path: temporary, expected: status })) !== file.digest)
      fail(`prepared cross-device blob differs from its candidate: ${file.path}`)
    file.copy = { path: temporary, status }
    complete = true
  } finally {
    await created?.close()
    if (created !== undefined && complete === false)
      await removePreparedCopies({ contentStore, paths: [temporary] })
  }
}
/* eslint-enable no-await-in-loop */

/** Observed sharing/fallback work for one byte-owned candidate. */
export type EditorViewContentSharing = {
  linkedFiles: number
  copiedFiles: number
  copiedBytes: number
  createdBlobs: number
}

const substituteCandidate = async ({
  file,
  blobStatus,
  sharing,
}: {
  readonly file: PreparedFile
  readonly blobStatus: BigIntStats
  readonly sharing: EditorViewContentSharing
}): Promise<void> => {
  if (unchanged({ left: file.status, right: await lstat(file.path, { bigint: true }) }) === false)
    fail(`candidate payload changed before linking: ${file.path}`)
  if (sameInode({ left: file.status, right: blobStatus }) === true) {
    sharing.linkedFiles += 1
    return
  }
  const temporary = join(dirname(file.path), `.${basename(file.path)}.share-${randomUUID()}`)
  let linked = false
  try {
    try {
      await link(file.blob, temporary)
    } catch (error) {
      if (hasCode({ error: error, code: 'EXDEV' }) === false) throw error
      // The caller already proved independent byte ownership. Keeping this
      // normalized inode avoids another redundant copy of its admitted bytes.
      if (
        unchanged({ left: file.status, right: await lstat(file.path, { bigint: true }) }) === false
      )
        fail(`candidate payload changed during cross-device fallback: ${file.path}`)
      sharing.copiedFiles += 1
      sharing.copiedBytes += Number(file.status.size)
      return
    }
    linked = true
    const linkedStatus = await lstat(temporary, { bigint: true })
    if (
      unchanged({ left: blobStatus, right: linkedStatus }) === false ||
      linkedStatus.isFile() === false
    )
      fail(`blob changed while linking into candidate: ${file.blob}`)
    if (unchanged({ left: file.status, right: await lstat(file.path, { bigint: true }) }) === false)
      fail(`candidate payload changed while linking: ${file.path}`)
    await rename(temporary, file.path)
    linked = false
    sharing.linkedFiles += 1
  } finally {
    if (linked === true) await unlinkIfPresent(temporary)
  }
}

/* eslint-disable no-await-in-loop -- Each bounded metadata transaction proves and substitutes one inode before proceeding; retries hash outside the lock. */
const shareBatch = async ({
  contentStore,
  files,
  afterStoreLock,
  afterStoreLockContended,
  afterBlobInstall,
  sharing,
}: {
  readonly contentStore: string
  readonly files: readonly PreparedFile[]
  readonly afterStoreLock?: (() => void | Promise<void>) | undefined
  readonly afterStoreLockContended?: (() => void | Promise<void>) | undefined
  readonly afterBlobInstall?:
    | ((installed: {
        blob: string
        temporary: string
        preparedCopy?: string
      }) => void | Promise<void>)
    | undefined
  readonly sharing: EditorViewContentSharing
}): Promise<void> => {
  let pending: readonly PreparedFile[] = files
  let failure: { readonly error: unknown } | undefined
  try {
    while (pending.length !== 0) {
      // All walks, hashes and EXDEV preparation occur before acquisition. A
      // concurrent GC may unlink a validated key; private candidate bytes remain.
      for (let index = 0; index < pending.length; index += 4) {
        const prepared = await Promise.allSettled(
          pending.slice(index, index + 4).map(async (file) => {
            const existing = await validateBlob({
              contentStore,
              path: file.blob,
              digest: file.digest,
              mode: file.mode,
            })
            if (existing === undefined && file.requiresCopy === true)
              await prepareCopy({ contentStore, file })
          }),
        )
        for (const result of prepared) if (result.status === 'rejected') throw result.reason
      }
      pending = await withStoreLock({
        contentStore,
        afterStoreLock,
        afterStoreLockContended,
        run: async (directories) => {
          const retry: PreparedFile[] = []
          for (const file of pending) {
            if (
              unchanged({ left: file.status, right: await lstat(file.path, { bigint: true }) }) ===
              false
            )
              fail(`candidate payload changed before store installation: ${file.path}`)
            const shard = await shardDirectory({
              contentStore: contentStore,
              shard: file.digest.slice(0, 2),
              directories: directories,
              create: true,
            })
            if (shard === undefined) fail(`content-store shard is absent: ${file.blob}`)
            let blobStatus = await statusIfPresent(file.blob)
            if (blobStatus !== undefined) {
              requireBlob({ path: file.blob, status: blobStatus, mode: file.mode })
              const knownDigest = verified.get(verificationKey(blobStatus))
              if (knownDigest === undefined) {
                retry.push(file)
                continue
              }
              if (knownDigest !== file.digest)
                fail(`blob content does not match its address: ${file.blob}`)
            } else {
              const source = file.copy ?? { path: file.path, status: file.status }
              if (
                unchanged({
                  left: source.status,
                  right: await lstat(source.path, { bigint: true }),
                }) === false
              )
                fail(`prepared blob source changed before installation: ${source.path}`)
              await makeWritable(shard)
              const temporary = join(shard.path, `.tmp-${randomUUID()}`)
              let linked = false
              try {
                try {
                  await link(source.path, temporary)
                } catch (error) {
                  if (file.copy !== undefined || hasCode({ error, code: 'EXDEV' }) === false)
                    throw error
                  // Overlayfs may report different st_dev values for files and
                  // directories even when hardlinks work. Only EXDEV proves
                  // copying is needed; stream those bytes outside this lock.
                  file.requiresCopy = true
                  retry.push(file)
                  continue
                }
                linked = true
                if (
                  unchanged({
                    left: source.status,
                    right: await lstat(temporary, { bigint: true }),
                  }) === false
                )
                  fail(`prepared blob source changed while linking: ${source.path}`)
                try {
                  // Final blob paths are never opened for writing or truncation.
                  await link(temporary, file.blob)
                  sharing.createdBlobs += 1
                } catch (error) {
                  if (hasCode({ error: error, code: 'EEXIST' }) === false) throw error
                  const raced = await statusIfPresent(file.blob)
                  if (raced !== undefined)
                    requireBlob({ path: file.blob, status: raced, mode: file.mode })
                  retry.push(file)
                  continue
                }
                blobStatus = await lstat(file.blob, { bigint: true })
                requireBlob({ path: file.blob, status: blobStatus, mode: file.mode })
                if (unchanged({ left: source.status, right: blobStatus }) === false)
                  fail(`new blob does not retain its verified source inode: ${file.blob}`)
                remember({ status: blobStatus, digest: file.digest })
                await afterBlobInstall?.({
                  blob: file.blob,
                  temporary,
                  ...(file.copy === undefined ? {} : { preparedCopy: file.copy.path }),
                })
              } finally {
                if (linked === true) await unlinkIfPresent(temporary)
              }
            }
            await substituteCandidate({
              file: file,
              blobStatus: blobStatus ?? fail(`installed blob is absent: ${file.blob}`),
              sharing: sharing,
            })
          }
          return retry
        },
      })
    }
  } catch (error) {
    failure = { error }
  }
  const errors: unknown[] = []
  try {
    await removePreparedCopies({
      contentStore,
      paths: files.flatMap((file) => (file.copy === undefined ? [] : [file.copy.path])),
    })
  } catch (error) {
    errors.push(error)
  }
  if (errors.length !== 0)
    throw new AggregateError(
      failure === undefined ? errors : [failure.error, ...errors],
      'editor view sharing: prepared blob cleanup failed',
    )
  if (failure !== undefined) throw failure.error
}
/* eslint-enable no-await-in-loop */

const within = ({ parent, path }: { readonly parent: string; readonly path: string }): boolean => {
  const fromParent = relative(parent, path)
  return (
    fromParent === '' ||
    (isAbsolute(fromParent) === false &&
      fromParent !== '..' &&
      fromParent.startsWith('../') === false)
  )
}

/* eslint-disable no-await-in-loop -- Settle each bounded preparation/link batch before accepting more files or releasing its candidate. */
/**
 * Callers MUST prove candidate byte ownership before sharing; admitted sources
 * are never supplied or linked. Only regular payload files participate. Root
 * editor-view.json stays private; nested files with that name are ordinary bytes.
 */
export const shareSnapshotFiles = async ({
  candidate,
  contentStore,
  afterStoreLock,
  afterStoreLockContended,
  afterBlobInstall,
  reusedFiles,
  candidateFiles,
  onSharedFile,
}: {
  readonly candidate: string
  readonly contentStore: string
  readonly afterStoreLock?: () => void | Promise<void>
  readonly afterStoreLockContended?: () => void | Promise<void>
  readonly afterBlobInstall?: (installed: {
    blob: string
    temporary: string
    preparedCopy?: string
  }) => void | Promise<void>
  readonly reusedFiles?: ReadonlySet<string>
  readonly candidateFiles?: Iterable<string>
  readonly onSharedFile?: (file: {
    path: string
    digest: string
    mode: number
    blobKey: string
  }) => void
}): Promise<EditorViewContentSharing> => {
  const root = resolve(candidate)
  const store = resolve(contentStore)
  if (
    within({ parent: root, path: store }) === true ||
    within({ parent: store, path: root }) === true
  )
    fail('candidate and content store must not overlap')
  const sharing: EditorViewContentSharing = {
    linkedFiles: reusedFiles?.size ?? 0,
    copiedFiles: 0,
    copiedBytes: 0,
    createdBlobs: 0,
  }
  // Group bounded link transactions by shard, so each transaction opens and
  // restores one shard instead of most of the store's 256 directories.
  const batches = new Map<string, PreparedFile[]>()
  const flush = async ({
    shard,
    files,
  }: {
    shard: string
    files: PreparedFile[]
  }): Promise<void> => {
    if (files.length === 0) return
    await shareBatch({
      contentStore: store,
      files,
      afterStoreLock,
      afterStoreLockContended,
      afterBlobInstall,
      sharing,
    })
    for (const file of files)
      onSharedFile?.({
        path: file.path,
        digest: file.digest,
        mode: file.mode,
        blobKey: verificationKey(lstatSync(file.path, { bigint: true })),
      })
    batches.delete(shard)
  }
  const prepare = async (path: string): Promise<PreparedFile> => {
    const status = await normalizeCandidate(path)
    const digest =
      (await fingerprint({ path: path, expected: status })) ??
      fail(`candidate disappeared while hashing: ${path}`)
    const mode = Number(permissions(status))
    return {
      path,
      status,
      digest,
      mode,
      blob: join(store, digest.slice(0, 2), `${digest}-${mode === 0o444 ? '0444' : '0555'}`),
    }
  }
  const paths: string[] = []
  const prepareBatch = async (): Promise<void> => {
    // Four small-file digests run on the native crypto worker pool. Large files
    // remain streaming; neither promises nor payload buffers scale with the tree.
    const prepared = await Promise.allSettled(paths.map(prepare))
    const files = prepared.map((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
    paths.length = 0
    for (const file of files) {
      const shard = file.digest.slice(0, 2)
      const batch = batches.get(shard) ?? []
      batch.push(file)
      batches.set(shard, batch)
      if (batch.length === batchSize) await flush({ shard, files: batch })
    }
  }
  for await (const path of candidateFiles ?? regularFiles({ directory: root })) {
    if (reusedFiles?.has(path) === true) continue
    paths.push(path)
    if (paths.length === 4) await prepareBatch()
  }
  await prepareBatch()
  for (const [shard, files] of batches) await flush({ shard, files })
  return sharing
}
/* eslint-enable no-await-in-loop */

/** Reuse only previously proven CAS inodes; GC and the link are one metadata transaction. */
export const reuseEditorViewSourceFiles = async ({
  contentStore,
  files,
}: {
  readonly contentStore: string
  readonly files: readonly { readonly path: string; readonly entry: EditorViewSourceFile }[]
}): Promise<Set<string>> => {
  const reused = new Set<string>()
  if (files.length === 0) return reused
  const store = resolve(contentStore)
  await ensureParent({ contentStore: store, create: true })
  const shards = new Map<string, (typeof files)[number][]>()
  for (const file of files) {
    const shard = file.entry.digest.slice(0, 2)
    const entries = shards.get(shard) ?? []
    entries.push(file)
    shards.set(shard, entries)
  }
  for (const entries of shards.values()) {
    for (let index = 0; index < entries.length; index += batchSize) {
      // eslint-disable-next-line no-await-in-loop -- Each short metadata batch settles before the next shard transaction.
      await withStoreLock({
        contentStore: store,
        run: async (directories) => {
          const shard = await shardDirectory({
            contentStore: store,
            shard: entries[0]!.entry.digest.slice(0, 2),
            directories,
            create: false,
          })
          if (shard === undefined) return
          for (const file of entries.slice(index, index + batchSize)) {
            const blob = join(
              shard.path,
              `${file.entry.digest}-${file.entry.mode === 0o444 ? '0444' : '0555'}`,
            )
            let status: BigIntStats
            try {
              status = lstatSync(blob, { bigint: true })
            } catch (error) {
              if (hasCode({ error, code: 'ENOENT' }) === true) continue
              throw error
            }
            requireBlob({ path: blob, status, mode: file.entry.mode })
            if (verificationKey(status) !== file.entry.blobKey) continue
            try {
              linkSync(blob, file.path)
            } catch (error) {
              if (
                hasCode({ error, code: 'EXDEV' }) === true ||
                hasCode({ error, code: 'ENOENT' }) === true
              )
                continue
              throw error
            }
            const linked = lstatSync(file.path, { bigint: true })
            if (unchanged({ left: status, right: linked }) === false)
              fail(`reused blob changed while linking: ${blob}`)
            remember({ status: linked, digest: file.entry.digest })
            reused.add(file.path)
          }
        },
      })
    }
  }
  return reused
}

type CollectionCandidate = {
  readonly path: string
  readonly status: BigIntStats
  readonly mode: number
  readonly digest: string
}

/* eslint-disable no-await-in-loop -- Stream the census and file verification without retaining a payload-sized promise set. */
const collectionCandidates = async function* (
  contentStore: string,
): AsyncGenerator<CollectionCandidate> {
  if ((await validateDirectory({ path: contentStore, contentStore: contentStore })) === undefined)
    return
  for (const shard of await readdir(contentStore, { withFileTypes: true })) {
    const shardPath = join(contentStore, shard.name)
    if (shard.name === stagingDirectoryName) {
      await validateDirectory({ path: shardPath, contentStore })
      continue
    }
    if (shardPattern.test(shard.name) === false || shard.isDirectory() === false)
      fail(`unknown or symbolic-link content-store shard entry: ${shardPath}`)
    if ((await validateDirectory({ path: shardPath, contentStore: contentStore })) === undefined)
      continue
    for (const entry of await readdir(shardPath, { withFileTypes: true })) {
      const path = join(shardPath, entry.name)
      const temporary = temporaryPattern.exec(entry.name)
      if (temporary !== null) {
        // A live batch may have installed this recognized private link since
        // the initial repair. It is not a canonical blob and is never hashed.
        const status = await statusIfPresent(path)
        if (status === undefined) continue
        if (status.isFile() === false || status.uid !== userId() || isImmutable(status) === false)
          fail(`temporary blob must be a real same-user readonly file: ${path}`)
        continue
      }
      const match = blobNamePattern.exec(entry.name)
      if (
        match === null ||
        match[1] === undefined ||
        match[2] === undefined ||
        match[1].slice(0, 2) !== shard.name
      )
        fail(`unknown content-store blob entry: ${path}`)
      const status = await statusIfPresent(path)
      if (status === undefined) continue
      const mode = match[2] === '0444' ? 0o444 : 0o555
      requireBlob({ path: path, status: status, mode: mode })
      // Linked blobs cannot be collected. Validate their structure/permissions,
      // but do not reread retained snapshot bytes just to prove non-deletability.
      if (status.nlink !== 1n) continue
      const actual = await fingerprint({ path: path, expected: status, mayDisappear: true })
      if (actual === undefined) continue
      if (actual !== match[1]) fail(`blob content does not match its address: ${path}`)
      yield { path, status, mode, digest: actual }
    }
  }
}
/* eslint-enable no-await-in-loop */

const incidentExampleLimit = 8
type ContentStoreIncident = {
  readonly schema: 'editor-view.content-store.integrity-incident.v1'
  /** First-observed metadata census, not a continuously refreshed inventory. */
  readonly observedAt: string
  readonly writableBlobCount: number
  readonly examplePaths: readonly string[]
  readonly repairCommand: string
}
const incidentPath = (contentStore: string): string => `${contentStore}.incident.json`
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/* eslint-disable no-await-in-loop -- An incident census reads metadata only, one shard at a time. */
const writableBlobCensus = async (
  contentStore: string,
): Promise<{ writableBlobCount: number; examplePaths: string[] }> => {
  const result: { writableBlobCount: number; examplePaths: string[] } = {
    writableBlobCount: 0,
    examplePaths: [],
  }
  const rootStatus = await lstat(contentStore, { bigint: true })
  await requireRealDirectory({ path: contentStore, status: rootStatus })
  requireOwned({ path: contentStore, status: rootStatus })
  for (const shard of await readdir(contentStore, { withFileTypes: true })) {
    if (shardPattern.test(shard.name) === false || shard.isDirectory() === false) continue
    const directory = join(contentStore, shard.name)
    const directoryStatus = await lstat(directory, { bigint: true })
    await requireRealDirectory({ path: directory, status: directoryStatus })
    requireOwned({ path: directory, status: directoryStatus })
    for (const entry of await readdir(directory)) {
      const address = blobNamePattern.exec(entry)
      if (address === null || address[1]?.slice(0, 2) !== shard.name) continue
      const path = join(directory, entry)
      const status = await statusIfPresent(path)
      if (status === undefined || status.isFile() === false || status.uid !== userId()) continue
      if ((status.mode & 0o222n) === 0n) continue
      result.writableBlobCount += 1
      if (result.examplePaths.length < incidentExampleLimit) result.examplePaths.push(path)
    }
  }
  return result
}
/* eslint-enable no-await-in-loop */

const readContentStoreIncident = async (
  contentStore: string,
): Promise<ContentStoreIncident | undefined> => {
  const path = incidentPath(contentStore)
  const status = await statusIfPresent(path)
  if (status === undefined) return undefined
  requireOwned({ path, status })
  if (
    status.isFile() === false ||
    permissions(status) !== 0o600n ||
    status.nlink !== 1n ||
    status.size > 64n * 1024n
  )
    fail(`integrity incident receipt must be a private same-user regular file: ${path}`)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (unchanged({ left: status, right: await file.stat({ bigint: true }) }) === false)
      fail(`integrity incident receipt changed while opening: ${path}`)
    const raw: unknown = JSON.parse(await file.readFile('utf8'))
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('schema' in raw) ||
      raw.schema !== 'editor-view.content-store.integrity-incident.v1' ||
      !('observedAt' in raw) ||
      typeof raw.observedAt !== 'string' ||
      Number.isFinite(Date.parse(raw.observedAt)) === false ||
      !('writableBlobCount' in raw) ||
      typeof raw.writableBlobCount !== 'number' ||
      Number.isSafeInteger(raw.writableBlobCount) === false ||
      raw.writableBlobCount < 1 ||
      !('examplePaths' in raw) ||
      Array.isArray(raw.examplePaths) === false ||
      raw.examplePaths.length > incidentExampleLimit ||
      raw.examplePaths.some((example: unknown) => {
        if (typeof example !== 'string') return true
        const shard = basename(dirname(example))
        return (
          dirname(dirname(example)) !== contentStore ||
          shardPattern.test(shard) === false ||
          blobNamePattern.exec(basename(example))?.[1]?.slice(0, 2) !== shard
        )
      }) === true ||
      !('repairCommand' in raw) ||
      typeof raw.repairCommand !== 'string'
    )
      return fail(`invalid integrity incident receipt: ${path}`)
    if (
      unchanged({ left: status, right: await file.stat({ bigint: true }) }) === false ||
      unchanged({ left: status, right: await lstat(path, { bigint: true }) }) === false
    )
      fail(`integrity incident receipt changed while reading: ${path}`)
    return {
      schema: raw.schema,
      observedAt: raw.observedAt,
      writableBlobCount: raw.writableBlobCount,
      examplePaths: raw.examplePaths,
      repairCommand: raw.repairCommand,
    }
  } finally {
    await file.close()
  }
}

const recordContentStoreIncident = async (contentStore: string): Promise<void> => {
  await ensureParent({ contentStore, create: false })
  // Do not invoke crash repair here: that is precisely what may have rejected
  // the writable inode. The existing flock serializes receipt creation/clearing.
  const lock = await acquireLock({ contentStore })
  try {
    let receipt = await readContentStoreIncident(contentStore)
    if (receipt === undefined) {
      const census = await writableBlobCensus(contentStore)
      if (census.writableBlobCount === 0) return
      receipt = {
        schema: 'editor-view.content-store.integrity-incident.v1',
        observedAt: new Date().toISOString(),
        ...census,
        repairCommand: [
          'bun',
          shellQuote(fileURLToPath(new URL('./editor-view.ts', import.meta.url))),
          'repair-content --repo-root',
          shellQuote(process.cwd()),
          '--content-store',
          shellQuote(contentStore),
          '--quiesced true',
        ].join(' '),
      }
      const temporary = `${incidentPath(contentStore)}.tmp-${randomUUID()}`
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await file.writeFile(`${JSON.stringify(receipt)}\n`)
        await file.sync()
        await rename(temporary, incidentPath(contentStore))
      } finally {
        await file.close()
        await unlinkIfPresent(temporary)
      }
    }
    process.stderr.write(
      `${JSON.stringify({
        event: 'editor-view.content-store.integrity-incident',
        writableBlobCount: receipt.writableBlobCount,
        observedAt: receipt.observedAt,
        alertPath: incidentPath(contentStore),
      })}\n`,
    )
  } finally {
    await lock.close()
  }
}

/** Report only writable-blob trust failures, preserving the original rejection. */
export const collectEditorViewContentStore = async (options: {
  readonly contentStore: string
  readonly afterStoreLock?: () => void | Promise<void>
  readonly afterStoreLockContended?: () => void | Promise<void>
}): Promise<{ removedBlobs: number; removedBytes: number }> => {
  try {
    return await collectContentStore(options)
  } catch (error) {
    if (!(error instanceof WritableBlobTrustError)) throw error
    try {
      await recordContentStoreIncident(resolve(options.contentStore))
    } catch {
      // Unsafe diagnostics must never replace the original trust rejection.
    }
    throw error
  }
}

/* eslint-disable no-await-in-loop -- Each bounded deletion rechecks its inode and link count under the publisher's metadata lock. */
/** Delete only validated real blobs with no snapshot/control hardlink remaining. */
const collectContentStore = async ({
  contentStore,
  afterStoreLock,
  afterStoreLockContended,
}: {
  readonly contentStore: string
  readonly afterStoreLock?: () => void | Promise<void>
  readonly afterStoreLockContended?: () => void | Promise<void>
}): Promise<{ removedBlobs: number; removedBytes: number }> => {
  const store = resolve(contentStore)
  const result = { removedBlobs: 0, removedBytes: 0 }
  if ((await statusIfPresent(store)) === undefined) return result
  await ensureParent({ contentStore: store, create: false })
  // Repair orphan copies before nlink-based admission; otherwise their hardlink
  // would hide a collectable blob from the outside-lock census.
  await withStoreLock({
    contentStore: store,
    afterStoreLock,
    afterStoreLockContended,
    run: async () => undefined,
  })
  let candidates: CollectionCandidate[] = []
  const flush = async (): Promise<void> => {
    if (candidates.length === 0) return
    await withStoreLock({
      contentStore: store,
      afterStoreLock,
      afterStoreLockContended,
      run: async (directories) => {
        for (const candidate of candidates) {
          const shard = await shardDirectory({
            contentStore: store,
            shard: candidate.digest.slice(0, 2),
            directories: directories,
            create: false,
          })
          if (shard === undefined) continue
          const current = await statusIfPresent(candidate.path)
          if (current === undefined) continue
          requireBlob({ path: candidate.path, status: current, mode: candidate.mode })
          if (
            unchanged({ left: candidate.status, right: current }) === false ||
            current.nlink !== 1n
          )
            continue
          await makeWritable(shard)
          await unlink(candidate.path)
          result.removedBlobs += 1
          result.removedBytes += Number(current.size)
        }
      },
    })
    candidates = []
  }
  for await (const candidate of collectionCandidates(store)) {
    candidates.push(candidate)
    if (candidates.length === batchSize) await flush()
  }
  await flush()
  return result
}
/* eslint-enable no-await-in-loop */

const stagingDirectoryName = '.staging'
const stagingPattern =
  /^([1-9][0-9]*)-(linux-[a-f0-9]{32}-[0-9]+|darwin-[a-f0-9]{64}|unknown)-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/
const unknownCreatorGraceMs = 5 * 60 * 1_000

/** Process-incarnation proof for staging reclamation, reservations, and live-eviction waiting. */
export const editorViewStagingCreatorIdentity = ({
  pid,
  platform = process.platform,
  ps = '/bin/ps',
}: {
  pid: number
  platform?: NodeJS.Platform
  ps?: string
}): string => {
  if (platform === 'linux') {
    let boot: string
    try {
      boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().replaceAll('-', '')
      if (/^[a-f0-9]{32}$/.test(boot) === false) return 'unknown'
    } catch {
      return 'unknown'
    }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)
      // The suffix begins at field 3 (state), so index 19 is numeric field 22.
      const start = fields[19]
      if (start === undefined || /^[0-9]+$/.test(start) === false) return 'unknown'
      if (fields[0] === 'Z' || fields[0] === 'X') return 'dead'
      return `linux-${boot}-${start}`
    } catch (error) {
      return hasCode({ error, code: 'ENOENT' }) === true ? 'dead' : 'unknown'
    }
  }
  if (platform === 'darwin') {
    const result = spawnSync(ps, ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      // Equivalent to env -i: no caller TZ, locale, or dynamic-loader variables.
      env: { TZ: 'UTC', LC_ALL: 'C' },
    })
    const start = result.stdout?.trim()
    if (result.status === 0 && start !== undefined && start !== '')
      return `darwin-${createHash('sha256').update(start).digest('hex')}`
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (hasCode({ error, code: 'ESRCH' }) === true) return 'dead'
    }
  }
  return 'unknown'
}

/** Explicit recovery receipt; quarantined inodes remain untrusted in existing snapshots. */
export type EditorViewContentRepair = {
  verifiedBlobs: number
  checkedBlobInodes: number
  writableBlobs: number
  readonly mismatchedBlobs: { readonly path: string; readonly digest: string }[]
  repairedBlobs: number
  readonly quarantined: {
    readonly path: string
    readonly quarantine: string
    readonly digest: string
  }[]
}

/* eslint-disable no-await-in-loop -- Recovery deliberately bounds filesystem/hash pressure to one blob at a time. */
/** Read-only census: no flock creation, directory normalization, or payload chmod. */
export const inspectEditorViewContentStore = async ({
  contentStore,
}: {
  readonly contentStore: string
}): Promise<EditorViewContentRepair> => {
  const result: EditorViewContentRepair = {
    verifiedBlobs: 0,
    checkedBlobInodes: 0,
    writableBlobs: 0,
    mismatchedBlobs: [],
    repairedBlobs: 0,
    quarantined: [],
  }
  const identities = new Set<string>()
  const rootStatus = await lstat(contentStore, { bigint: true })
  await requireRealDirectory({ path: contentStore, status: rootStatus })
  requireOwned({ path: contentStore, status: rootStatus })
  for (const shard of await readdir(contentStore, { withFileTypes: true })) {
    if (shard.name === stagingDirectoryName) continue
    const directory = join(contentStore, shard.name)
    if (shardPattern.test(shard.name) === false || shard.isDirectory() === false)
      fail(`unknown content-store shard during census: ${directory}`)
    const directoryStatus = await lstat(directory, { bigint: true })
    await requireRealDirectory({ path: directory, status: directoryStatus })
    requireOwned({ path: directory, status: directoryStatus })
    for (const entry of await readdir(directory)) {
      if (temporaryPattern.test(entry) === true) continue
      const path = join(directory, entry)
      const address = blobNamePattern.exec(entry)
      if (address === null || address[1]?.slice(0, 2) !== shard.name)
        fail(`unknown content-store blob during census: ${path}`)
      const status = await lstat(path, { bigint: true })
      if (status.isFile() === false) fail(`census blob must be a real regular file: ${path}`)
      requireOwned({ path, status })
      identities.add(`${status.dev}:${status.ino}`)
      const mode = address[2] === '0444' ? 0o444 : 0o555
      if ((status.mode & 0o222n) === 0n) {
        requireBlob({ path, status, mode })
        continue
      }
      result.writableBlobs += 1
      const digest = await fingerprint({ path, expected: status })
      if (digest === undefined) fail(`census blob disappeared: ${path}`)
      if (digest === address[1]) result.verifiedBlobs += 1
      else result.mismatchedBlobs.push({ path, digest })
    }
  }
  result.checkedBlobInodes = identities.size
  return result
}
/* eslint-enable no-await-in-loop */

/**
 * Recover chmod-poisoned payloads only after their owners have stopped every
 * reader and writer. flock excludes publishers, not arbitrary open descriptors.
 * Normal publication and crash repair deliberately continue to fail closed.
 */
export const repairEditorViewContentStore = async ({
  contentStore,
  quiesced,
}: {
  readonly contentStore: string
  readonly quiesced: true
}): Promise<EditorViewContentRepair> => {
  if (quiesced !== true)
    fail('content repair requires all editor-view readers/writers to be stopped')
  const result: EditorViewContentRepair = {
    verifiedBlobs: 0,
    checkedBlobInodes: 0,
    writableBlobs: 0,
    mismatchedBlobs: [],
    repairedBlobs: 0,
    quarantined: [],
  }
  await withStoreLock({
    contentStore,
    writableRepair: result,
    run: async () => {
      const census = await inspectEditorViewContentStore({ contentStore })
      // Mode is an inode property: this proves every non-store hardlink to each
      // surviving blob is readonly too, without finding each alias by pathname.
      if (census.writableBlobs !== 0) fail('content repair left writable shared blob inodes')
      result.checkedBlobInodes = census.checkedBlobInodes
    },
  })
  // Clear only after the complete repair transaction succeeded, and recheck
  // under exclusion so receipt reuse cannot race a new writable observation.
  const store = resolve(contentStore)
  const lock = await acquireLock({ contentStore: store })
  try {
    if (
      result.mismatchedBlobs.length === 0 &&
      (await readContentStoreIncident(store)) !== undefined
    ) {
      const census = await writableBlobCensus(store)
      if (census.writableBlobCount !== 0) fail('content repair left writable shared blob inodes')
      await unlink(incidentPath(store))
    }
  } finally {
    await lock.close()
  }
  return result
}

const repairWritableBlob = async ({
  path,
  contentStore,
  status,
  mode,
  digest,
  result,
}: {
  readonly path: string
  readonly contentStore: string
  readonly status: BigIntStats
  readonly mode: number
  readonly digest: string
  readonly result: EditorViewContentRepair
}): Promise<void> => {
  const actual = await fingerprint({ path, expected: status })
  if (actual === undefined) fail(`repair payload disappeared: ${path}`)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (
      unchanged({ left: status, right: await file.stat({ bigint: true }) }) === false ||
      unchanged({ left: status, right: await lstat(path, { bigint: true }) }) === false
    )
      fail(`repair payload changed after hashing: ${path}`)
    if (actual !== digest) {
      const directory = `${contentStore}.quarantine`
      try {
        await mkdir(directory, { mode: 0o700 })
      } catch (error) {
        if (hasCode({ error, code: 'EEXIST' }) === false) throw error
      }
      const quarantineStatus = await lstat(directory, { bigint: true })
      await requireRealDirectory({ path: directory, status: quarantineStatus })
      requireOwned({ path: directory, status: quarantineStatus })
      if (permissions(quarantineStatus) !== 0o700n)
        fail(`quarantine directory must have mode 0700: ${directory}`)
      const quarantine = join(directory, `${basename(path)}-${randomUUID()}`)
      await rename(path, quarantine)
      result.quarantined.push({ path, quarantine, digest: actual })
      result.mismatchedBlobs.push({ path, digest: actual })
      return
    }
    await file.chmod(mode)
    const after = await file.stat({ bigint: true })
    requireBlob({ path, status: after, mode })
    if (
      sameInode({ left: status, right: after }) === false ||
      status.size !== after.size ||
      status.mtimeNs !== after.mtimeNs ||
      unchanged({ left: after, right: await lstat(path, { bigint: true }) }) === false
    )
      fail(`repair payload changed during hardening: ${path}`)
    result.verifiedBlobs += 1
    result.repairedBlobs += 1
  } finally {
    await file.close()
  }
}

/* eslint-disable no-await-in-loop -- Crash repair is an excluded metadata-only walk, not a payload census or hash pass. */
const repairDirectory = async ({
  path,
  root,
  scan,
  staging = false,
  writableRepair,
}: {
  readonly path: string
  readonly root: string
  readonly scan: boolean
  readonly staging?: boolean
  readonly writableRepair?: EditorViewContentRepair
}): Promise<void> => {
  const status = await statusIfPresent(path)
  if (status === undefined) return
  await requireRealDirectory({ path, status })
  requireOwned({ path, status })
  if ((permissions(status) & ~0o755n) !== 0n)
    fail(`unsafe content-store directory mode during repair: ${path}`)
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let writable = permissions(status) !== 0o555n
  try {
    if (sameInode({ left: status, right: await file.stat({ bigint: true }) }) === false)
      fail(`content-store directory changed during repair: ${path}`)
    if (path !== root && scan === false && writable === false && staging === false) return
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (path === root) {
        if (
          (shardPattern.test(entry.name) === false && entry.name !== stagingDirectoryName) ||
          entry.isDirectory() === false
        )
          fail(`unknown or symbolic-link content-store directory during repair: ${child}`)
        const childStatus = lstatSync(child, { bigint: true })
        requireOwned({ path: child, status: childStatus })
        if (childStatus.isDirectory() === false)
          fail(`content-store directory changed during repair: ${child}`)
        const isStaging = entry.name === stagingDirectoryName
        // The normal path checks only the bounded shard directory set. A dirty
        // acquisition additionally scans shard metadata for abandoned links.
        if (scan === false && permissions(childStatus) === 0o555n && isStaging === false) continue
        await repairDirectory({
          path: child,
          root,
          scan,
          staging: isStaging,
          ...(writableRepair === undefined ? {} : { writableRepair }),
        })
        continue
      }
      const payload = await statusIfPresent(child)
      if (payload === undefined) continue
      if (payload.isFile() === false || payload.uid !== userId())
        fail(`repair entry must be a real same-user regular file: ${child}`)
      let remove = false
      if (staging === true) {
        const match = stagingPattern.exec(entry.name)
        if (match === null || match[1] === undefined || match[2] === undefined)
          fail(`unknown content-store staging entry: ${child}`)
        if (permissions(payload) !== 0o600n && isImmutable(payload) === false)
          fail(`unsafe staging file mode during repair: ${child}`)
        const actual = editorViewStagingCreatorIdentity({ pid: Number(match[1]) })
        const unknown = actual === 'unknown' || match[2] === 'unknown'
        remove =
          actual === 'dead' ||
          (unknown === false && actual !== match[2]) ||
          (unknown === true && Date.now() - Number(payload.mtimeMs) >= unknownCreatorGraceMs)
      } else if (temporaryPattern.test(entry.name) === true) {
        if (isImmutable(payload) === false)
          fail(`temporary blob must be readonly during repair: ${child}`)
        remove = true
      } else {
        const blob = blobNamePattern.exec(entry.name)
        if (blob === null || blob[1]?.slice(0, 2) !== basename(path))
          fail(`unknown content-store blob during repair: ${child}`)
        const mode = blob[2] === '0444' ? 0o444 : 0o555
        if (writableRepair !== undefined && (payload.mode & 0o222n) !== 0n) {
          if (writable === false) {
            await file.chmod(0o755)
            writable = true
          }
          await repairWritableBlob({
            path: child,
            contentStore: root,
            status: payload,
            mode,
            digest: blob[1]!,
            result: writableRepair,
          })
        } else requireBlob({ path: child, status: payload, mode })
      }
      if (remove === false) continue
      if (writable === false) {
        await file.chmod(0o755)
        writable = true
      }
      if (unchanged({ left: payload, right: await lstat(child, { bigint: true }) }) === false)
        fail(`staging inode changed during repair: ${child}`)
      await unlink(child)
    }
  } finally {
    try {
      if (writable === true) await file.chmod(0o555)
    } finally {
      await file.close()
    }
  }
}

const repairStore = async ({
  contentStore,
  dirty,
  writableRepair,
}: {
  readonly contentStore: string
  readonly dirty: boolean
  readonly writableRepair?: EditorViewContentRepair
}): Promise<void> => {
  await repairDirectory({
    path: contentStore,
    root: contentStore,
    scan: dirty,
    ...(writableRepair === undefined ? {} : { writableRepair }),
  })
}
/* eslint-enable no-await-in-loop */
