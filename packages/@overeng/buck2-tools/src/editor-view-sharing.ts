import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
  watch,
  type BigIntStats,
  type FSWatcher,
} from 'node:fs'
import {
  copyFile,
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
import { clearTimeout, setTimeout } from 'node:timers'

const lockSchema = 'editor-view-content-store-lock/v1' as const
const batchSize = 128
const blobNamePattern = /^([a-f0-9]{64})-(0444|0555)$/
const shardPattern = /^[a-f0-9]{2}$/
const temporaryPattern = /^\.tmp-([a-f0-9]{64})-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/

const fail = (message: string): never => {
  throw new Error(`editor view sharing: ${message}`)
}

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code

const userId = (): bigint => {
  const uid = process.getuid?.()
  return uid === undefined ? fail('content sharing requires POSIX user ownership') : BigInt(uid)
}

const statusIfPresent = async (path: string): Promise<BigIntStats | undefined> => {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
}

const unlinkIfPresent = async (path: string): Promise<void> => {
  try {
    await unlink(path)
  } catch (error) {
    if (hasCode(error, 'ENOENT') === false) throw error
  }
}

const permissions = (status: BigIntStats): bigint => status.mode & 0o7777n
const isImmutable = (status: BigIntStats): boolean =>
  permissions(status) === 0o444n || permissions(status) === 0o555n
const sameInode = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino

// Readonly hardlinks legitimately change ctime/nlink in other worktrees. Content,
// identity and mode must still agree; writable files also require stable ctime.
const unchanged = (left: BigIntStats, right: BigIntStats): boolean =>
  sameInode(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.mode === right.mode &&
  left.uid === right.uid &&
  (left.ctimeNs === right.ctimeNs || (isImmutable(left) && isImmutable(right)))

const requireOwned = (path: string, status: BigIntStats): void => {
  if (status.uid !== userId()) fail(`entry must be owned by the current user: ${path}`)
}

const requireRealDirectory = async (path: string, status: BigIntStats): Promise<void> => {
  if (status.isDirectory() === false || (await realpath(path)) !== path)
    fail(`directory must be canonical and real, without symbolic links: ${path}`)
}

const requireBlob = (path: string, status: BigIntStats, mode: number): void => {
  if (status.isFile() === false)
    fail(`blob must be a real regular file, not a symbolic link: ${path}`)
  requireOwned(path, status)
  if ((status.mode & 0o222n) !== 0n) fail(`writable blob is not trusted: ${path}`)
  if (permissions(status) !== BigInt(mode)) fail(`blob mode does not match its address: ${path}`)
}

/** Resolve Git's shared administration directory without invoking Git or megarepo. */
export const defaultEditorViewContentStore = (repoRoot: string): string => {
  const override = process.env.EDITOR_VIEW_CONTENT_STORE
  if (override !== undefined) {
    if (override.length === 0) fail('EDITOR_VIEW_CONTENT_STORE must not be empty')
    return resolve(override)
  }
  const gitPath = join(resolve(repoRoot), '.git')
  let gitStatus: BigIntStats
  try {
    gitStatus = lstatSync(gitPath, { bigint: true })
  } catch (error) {
    if (hasCode(error, 'ENOENT'))
      return join(homedir(), '.cache', 'effect-utils', 'editor-view-content', 'v1')
    throw error
  }
  let gitDirectory: string
  if (gitStatus.isDirectory()) gitDirectory = realpathSync(gitPath)
  else if (gitStatus.isFile()) {
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
    if (hasCode(error, 'ENOENT') === false) throw error
  }
  if (common !== undefined) {
    if (common.length === 0 || common.includes('\n') || common.includes('\r'))
      fail(`invalid Git commondir file: ${commonPath}`)
    commonDirectory = realpathSync(resolve(gitDirectory, common))
  }
  if (lstatSync(commonDirectory).isDirectory() === false)
    fail(`Git common administration path is not a directory: ${commonDirectory}`)
  return join(dirname(commonDirectory), '.editor-view-content', 'v1')
}

type LockOwner = {
  readonly schema: typeof lockSchema
  readonly token: string
  readonly pid: number
}
type Lock = { readonly path: string; readonly owner: LockOwner }

const readOwner = async (path: string): Promise<LockOwner | undefined> => {
  const expected = await statusIfPresent(path)
  if (expected === undefined) return undefined
  requireBlob(path, expected, 0o444)
  let file: FileHandle
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
  try {
    if (unchanged(expected, await file.stat({ bigint: true })) === false)
      fail(`content-store lock owner changed while opening: ${path}`)
    let owner: unknown
    try {
      owner = JSON.parse(await file.readFile('utf8'))
    } catch (error) {
      return fail(`cannot decode content-store lock owner at ${path}: ${String(error)}`)
    }
    const named = await statusIfPresent(path)
    if (named === undefined) return undefined
    if (
      unchanged(expected, await file.stat({ bigint: true })) === false ||
      unchanged(expected, named) === false
    )
      fail(`content-store lock owner changed while reading: ${path}`)
    if (
      typeof owner !== 'object' ||
      owner === null ||
      Array.isArray(owner) ||
      Object.keys(owner).toSorted().join(',') !== 'pid,schema,token' ||
      'schema' in owner === false ||
      owner.schema !== lockSchema ||
      'token' in owner === false ||
      typeof owner.token !== 'string' ||
      owner.token.length === 0 ||
      'pid' in owner === false ||
      typeof owner.pid !== 'number' ||
      Number.isSafeInteger(owner.pid) === false ||
      owner.pid <= 0 ||
      owner.pid > 0x7fffffff
    )
      return fail(`content-store lock owner does not conform to ${lockSchema}: ${path}`)
    return { schema: lockSchema, token: owner.token, pid: owner.pid }
  } finally {
    await file.close()
  }
}

const ownerIsLive = (owner: LockOwner): boolean => {
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return false
    if (hasCode(error, 'EPERM')) return true
    throw error
  }
}

const tokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex')
const lockPath = (contentStore: string): string => `${contentStore}.lock`
const recoveryPath = (contentStore: string): string => `${contentStore}.lock.recovery`

const staleOwner = (path: string, owner: LockOwner): never =>
  fail(
    `content-store lock owner pid=${owner.pid} is gone at ${path}; explicit recovery requires exact token ${JSON.stringify(owner.token)} (no automatic lock theft)`,
  )

const prepareOwner = async (path: string, owner: LockOwner): Promise<string> => {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o444,
  )
  let complete = false
  try {
    await file.writeFile(`${JSON.stringify(owner)}\n`)
    await file.chmod(0o444)
    complete = true
  } finally {
    try {
      await file.close()
    } catch (error) {
      complete = false
      throw error
    } finally {
      if (complete === false) await unlinkIfPresent(temporary)
    }
  }
  return temporary
}

const releaseLock = async ({ path, owner }: Lock): Promise<void> => {
  const current = await readOwner(path)
  if (current === undefined || current.token !== owner.token || current.pid !== owner.pid)
    fail(`content-store lock ownership changed; lock was not removed: ${path}`)
  await unlink(path)
}

const acquireLock = async (contentStore: string, token: string): Promise<Lock> => {
  const path = lockPath(contentStore)
  const owner: LockOwner = { schema: lockSchema, token, pid: process.pid }
  const temporary = await prepareOwner(path, owner)
  let installed = false
  let wake: (() => void) | undefined
  let watcherError: Error | undefined
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  try {
    // Watch before any acquisition attempt: a release between EEXIST and reading
    // its owner must not become a lost wakeup.
    watcher = watch(dirname(path), () => wake?.())
    watcher.on('error', (error) => {
      watcherError = error
      wake?.()
    })
    for (;;) {
      if (watcherError !== undefined) throw watcherError
      const changed = new Promise<void>((done) => {
        wake = done
      })
      let recovery = await readOwner(recoveryPath(contentStore))
      if (recovery === undefined) {
        try {
          await link(temporary, path)
          installed = true
          // A recovery guard remains authoritative until its final unlink.
          recovery = await readOwner(recoveryPath(contentStore))
          if (recovery === undefined) {
            await unlink(temporary)
            return { path, owner }
          }
          await releaseLock({ path, owner })
          installed = false
        } catch (error) {
          if (hasCode(error, 'EEXIST') === false) throw error
        }
      }
      if (recovery !== undefined) {
        if (ownerIsLive(recovery) === false) staleOwner(recoveryPath(contentStore), recovery)
      } else {
        const current = await readOwner(path)
        if (current === undefined) continue
        if (ownerIsLive(current) === false) {
          // Recovery may have started after the first guard read.
          const recovering = await readOwner(recoveryPath(contentStore))
          if (recovering === undefined) staleOwner(path, current)
          if (ownerIsLive(recovering) === false) staleOwner(recoveryPath(contentStore), recovering)
        }
      }
      // Owner death does not emit a directory event. This wakeup detects death,
      // not lock ownership: only exclusive hardlink creation arbitrates access.
      timer = setTimeout(() => wake?.(), 1_000)
      timer.unref()
      try {
        await changed
      } finally {
        clearTimeout(timer)
        timer = undefined
      }
    }
  } catch (error) {
    if (installed) await releaseLock({ path, owner })
    throw error
  } finally {
    watcher?.close()
    wake = undefined
    clearTimeout(timer)
    await unlinkIfPresent(temporary)
  }
}

const ensureParent = async (contentStore: string, create: boolean): Promise<BigIntStats> => {
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
  await requireRealDirectory(ancestor, status)
  for (const directory of missing.toReversed()) {
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if (hasCode(error, 'EEXIST') === false) throw error
    }
    const created = await lstat(directory, { bigint: true })
    await requireRealDirectory(directory, created)
    requireOwned(directory, created)
  }
  const parentStatus = await lstat(parent, { bigint: true })
  await requireRealDirectory(parent, parentStatus)
  const root = await statusIfPresent(contentStore)
  if (root !== undefined && root.dev !== parentStatus.dev)
    fail(
      `content store must be a child directory on the same device as its sibling control area, not a filesystem mountpoint: ${contentStore}; choose a path such as /dev/shm/editor-view-content/v1, not /dev/shm`,
    )
  requireOwned(parent, parentStatus)
  if ((parentStatus.mode & 0o022n) !== 0n)
    fail(`content-store control parent must not be group/other writable: ${parent}`)
  return parentStatus
}

const validateDirectory = async (
  path: string,
  contentStore: string,
): Promise<BigIntStats | undefined> => {
  const status = await statusIfPresent(path)
  if (status === undefined) return undefined
  await requireRealDirectory(path, status)
  requireOwned(path, status)
  if (permissions(status) === 0o555n) return status
  // Another valid lock owner may be installing entries while we prehash. Newly
  // created directories can also briefly reflect a restrictive process umask.
  if ((permissions(status) & ~0o755n) === 0n) {
    const owner =
      (await readOwner(lockPath(contentStore))) ?? (await readOwner(recoveryPath(contentStore)))
    if (owner !== undefined) return status
    const refreshed = await lstat(path, { bigint: true })
    if (sameInode(status, refreshed) && permissions(refreshed) === 0o555n) return refreshed
  }
  return fail(`content-store directory must be readonly when unlocked: ${path}`)
}

type OpenDirectory = {
  readonly path: string
  readonly file: FileHandle
  status: BigIntStats
  writable: boolean
}
type Directories = Map<string, OpenDirectory>

const openDirectory = async (path: string, directories: Directories): Promise<OpenDirectory> => {
  const previous = directories.get(path)
  if (previous !== undefined) return previous
  const status = await lstat(path, { bigint: true })
  await requireRealDirectory(path, status)
  requireOwned(path, status)
  if (permissions(status) !== 0o555n) fail(`content-store directory is not readonly: ${path}`)
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat({ bigint: true })
    if (
      sameInode(status, opened) === false ||
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
  if (directory.writable) return
  const current = await lstat(directory.path, { bigint: true })
  if (sameInode(directory.status, current) === false || current.mode !== directory.status.mode)
    fail(`content-store directory changed before writing: ${directory.path}`)
  directory.writable = true
  await directory.file.chmod(0o755)
}

const createDirectory = async (path: string, directories: Directories): Promise<void> => {
  await mkdir(path, { mode: 0o555 })
  // The inode is private to the held lock; normalize a restrictive umask without
  // ever opening a caller-provided symlink for chmod. Register its descriptor
  // before normalization so failure still attempts readonly restoration.
  const status = await lstat(path, { bigint: true })
  await requireRealDirectory(path, status)
  requireOwned(path, status)
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let registered = false
  try {
    if (sameInode(status, await file.stat({ bigint: true })) === false)
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

const storeDirectory = async (
  contentStore: string,
  directories: Directories,
  create: boolean,
): Promise<OpenDirectory | undefined> => {
  if ((await statusIfPresent(contentStore)) === undefined) {
    if (create === false) return undefined
    await createDirectory(contentStore, directories)
  }
  return openDirectory(contentStore, directories)
}

const shardDirectory = async (
  contentStore: string,
  shard: string,
  directories: Directories,
  create: boolean,
): Promise<OpenDirectory | undefined> => {
  const root = await storeDirectory(contentStore, directories, create)
  if (root === undefined) return undefined
  const path = join(contentStore, shard)
  if ((await statusIfPresent(path)) === undefined) {
    if (create === false) return undefined
    await makeWritable(root)
    await createDirectory(path, directories)
  }
  return openDirectory(path, directories)
}

const withStoreLock = async <T>({
  contentStore,
  token,
  afterStoreLock,
  run,
}: {
  readonly contentStore: string
  readonly token: string
  readonly afterStoreLock?: () => void | Promise<void>
  readonly run: (directories: Directories) => Promise<T>
}): Promise<T> => {
  const lock = await acquireLock(contentStore, token)
  const directories: Directories = new Map()
  try {
    await afterStoreLock?.()
    return await run(directories)
  } finally {
    const errors: unknown[] = []
    for (const directory of directories.values()) {
      try {
        if (directory.writable) await directory.file.chmod(0o555)
        const current = await lstat(directory.path, { bigint: true })
        if (sameInode(directory.status, current) === false || permissions(current) !== 0o555n)
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
        errors,
        'editor view sharing: readonly restoration failed; store lock retained',
      )
    await releaseLock(lock)
  }
}

// This is only an optimization of immutable inode verification, never an index.
// Bound retained metadata and omit ctime, which readonly hardlinks change freely.
const verified = new Map<string, string>()
const verificationKey = (status: BigIntStats): string =>
  `${status.dev}:${status.ino}:${status.size}:${status.mtimeNs}:${status.mode}:${status.uid}`
const remember = (status: BigIntStats, digest: string): void => {
  const key = verificationKey(status)
  if (verified.has(key) === false && verified.size >= 8_192) {
    const oldest = verified.keys().next().value
    if (oldest !== undefined) verified.delete(oldest)
  }
  verified.set(key, digest)
}

const fingerprint = async (
  path: string,
  expected: BigIntStats,
  mayDisappear = false,
): Promise<string | undefined> => {
  const cached = verified.get(verificationKey(expected))
  if (cached !== undefined && isImmutable(expected)) return cached
  let file: FileHandle
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (mayDisappear && hasCode(error, 'ENOENT')) return undefined
    throw error
  }
  try {
    const before = await file.stat({ bigint: true })
    if (before.isFile() === false || unchanged(expected, before) === false) {
      if (mayDisappear && sameInode(expected, before) === false) return undefined
      fail(`payload changed before hashing: ${path}`)
    }
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    if (unchanged(before, await file.stat({ bigint: true })) === false)
      fail(`payload changed while hashing: ${path}`)
    const named = await statusIfPresent(path)
    if (named === undefined || sameInode(before, named) === false) {
      if (mayDisappear) return undefined
      fail(`payload disappeared or was replaced while hashing: ${path}`)
    }
    if (unchanged(before, named) === false) fail(`payload changed while hashing: ${path}`)
    const digest = hash.digest('hex')
    if (isImmutable(before)) remember(before, digest)
    return digest
  } finally {
    await file.close()
  }
}

const regularFiles = async function* (
  directory: string,
  root: string = directory,
): AsyncGenerator<string> {
  const status = await lstat(directory, { bigint: true })
  await requireRealDirectory(directory, status)
  requireOwned(directory, status)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* regularFiles(path, root)
    else if (entry.isFile() && (directory !== root || entry.name !== 'editor-view.json')) yield path
    // Admitted symlinks are not payload files and are never followed or changed.
  }
}

const normalizeCandidate = async (path: string): Promise<BigIntStats> => {
  const expected = await lstat(path, { bigint: true })
  if (expected.isFile() === false) fail(`candidate payload is not a regular file: ${path}`)
  requireOwned(path, expected)
  const mode = (expected.mode & 0o111n) === 0n ? 0o444 : 0o555
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat({ bigint: true })
    if (unchanged(expected, before) === false)
      fail(`candidate payload changed before normalization: ${path}`)
    // A same-mode chmod would change ctime on an already shared readonly inode.
    if (permissions(before) !== BigInt(mode)) await file.chmod(mode)
    const after = await file.stat({ bigint: true })
    if (
      sameInode(before, after) === false ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.uid !== after.uid ||
      permissions(after) !== BigInt(mode) ||
      unchanged(after, await lstat(path, { bigint: true })) === false
    )
      fail(`candidate payload changed while normalizing: ${path}`)
    return after
  } finally {
    await file.close()
  }
}

const validateBlob = async (
  contentStore: string,
  path: string,
  digest: string,
  mode: number,
): Promise<BigIntStats | undefined> => {
  if ((await validateDirectory(contentStore, contentStore)) === undefined) return undefined
  if ((await validateDirectory(dirname(path), contentStore)) === undefined) return undefined
  const status = await statusIfPresent(path)
  if (status === undefined) return undefined
  requireBlob(path, status, mode)
  const actual = await fingerprint(path, status, true)
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
  copy?: { readonly path: string; readonly status: BigIntStats }
}

const prepareCopy = async (
  contentStore: string,
  file: PreparedFile,
  token: string,
): Promise<void> => {
  if (file.copy !== undefined) return
  if (unchanged(file.status, await lstat(file.path, { bigint: true })) === false)
    fail(`candidate payload changed before copying: ${file.path}`)
  const temporary = join(
    dirname(contentStore),
    `.${basename(contentStore)}.blob-${tokenDigest(token)}-${randomUUID()}.tmp`,
  )
  let copied = false
  try {
    // The source has already been normalized readonly. COPYFILE_EXCL prevents
    // following or truncating a preexisting destination; FICLONE falls back to copy.
    try {
      await copyFile(file.path, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    } catch (error) {
      // An interrupted copy may leave a partial private inode. An EEXIST inode
      // was not created by us and must never be removed or overwritten.
      if (hasCode(error, 'EEXIST') === false) await unlinkIfPresent(temporary)
      throw error
    }
    copied = true
    const status = await normalizeCandidate(temporary)
    if ((await fingerprint(temporary, status)) !== file.digest)
      fail(`prepared cross-device blob differs from its candidate: ${file.path}`)
    if (unchanged(file.status, await lstat(file.path, { bigint: true })) === false)
      fail(`candidate payload changed while copying: ${file.path}`)
    file.copy = { path: temporary, status }
    copied = false
  } finally {
    if (copied) await unlinkIfPresent(temporary)
  }
}

/** Observed sharing/fallback work for one byte-owned candidate. */
export type EditorViewContentSharing = {
  linkedFiles: number
  copiedFiles: number
  copiedBytes: number
  createdBlobs: number
}

const substituteCandidate = async (
  file: PreparedFile,
  blobStatus: BigIntStats,
  sharing: EditorViewContentSharing,
): Promise<void> => {
  if (unchanged(file.status, await lstat(file.path, { bigint: true })) === false)
    fail(`candidate payload changed before linking: ${file.path}`)
  if (sameInode(file.status, blobStatus)) {
    sharing.linkedFiles += 1
    return
  }
  const temporary = join(dirname(file.path), `.${basename(file.path)}.share-${randomUUID()}`)
  let linked = false
  try {
    try {
      await link(file.blob, temporary)
    } catch (error) {
      if (hasCode(error, 'EXDEV') === false) throw error
      // The caller already proved independent byte ownership. Keeping this
      // normalized inode avoids another redundant copy of its admitted bytes.
      if (unchanged(file.status, await lstat(file.path, { bigint: true })) === false)
        fail(`candidate payload changed during cross-device fallback: ${file.path}`)
      sharing.copiedFiles += 1
      sharing.copiedBytes += Number(file.status.size)
      return
    }
    linked = true
    const linkedStatus = await lstat(temporary, { bigint: true })
    if (unchanged(blobStatus, linkedStatus) === false || linkedStatus.isFile() === false)
      fail(`blob changed while linking into candidate: ${file.blob}`)
    if (unchanged(file.status, await lstat(file.path, { bigint: true })) === false)
      fail(`candidate payload changed while linking: ${file.path}`)
    await rename(temporary, file.path)
    linked = false
    sharing.linkedFiles += 1
  } finally {
    if (linked) await unlinkIfPresent(temporary)
  }
}

const shareBatch = async ({
  contentStore,
  files,
  parentStatus,
  token,
  afterStoreLock,
  sharing,
}: {
  readonly contentStore: string
  readonly files: readonly PreparedFile[]
  readonly parentStatus: BigIntStats
  readonly token: string
  readonly afterStoreLock?: () => void | Promise<void>
  readonly sharing: EditorViewContentSharing
}): Promise<void> => {
  let pending: readonly PreparedFile[] = files
  try {
    while (pending.length !== 0) {
      // All walks, hashes and EXDEV preparation occur before acquisition. A
      // concurrent GC may unlink a validated key; private candidate bytes remain.
      for (const file of pending) {
        const existing = await validateBlob(contentStore, file.blob, file.digest, file.mode)
        if (existing === undefined && file.status.dev !== parentStatus.dev)
          await prepareCopy(contentStore, file, token)
      }
      pending = await withStoreLock({
        contentStore,
        token,
        afterStoreLock,
        run: async (directories) => {
          const retry: PreparedFile[] = []
          for (const file of pending) {
            if (unchanged(file.status, await lstat(file.path, { bigint: true })) === false)
              fail(`candidate payload changed before store installation: ${file.path}`)
            const shard = await shardDirectory(
              contentStore,
              file.digest.slice(0, 2),
              directories,
              true,
            )
            if (shard === undefined) fail(`content-store shard is absent: ${file.blob}`)
            let blobStatus = await statusIfPresent(file.blob)
            if (blobStatus !== undefined) {
              requireBlob(file.blob, blobStatus, file.mode)
              const knownDigest = verified.get(verificationKey(blobStatus))
              if (knownDigest === undefined) {
                retry.push(file)
                continue
              }
              if (knownDigest !== file.digest)
                fail(`blob content does not match its address: ${file.blob}`)
            } else {
              const source =
                file.status.dev === shard.status.dev
                  ? { path: file.path, status: file.status }
                  : file.copy
              if (source === undefined) {
                retry.push(file)
                continue
              }
              if (unchanged(source.status, await lstat(source.path, { bigint: true })) === false)
                fail(`prepared blob source changed before installation: ${source.path}`)
              await makeWritable(shard)
              const temporary = join(shard.path, `.tmp-${tokenDigest(token)}-${randomUUID()}`)
              let linked = false
              try {
                await link(source.path, temporary)
                linked = true
                if (unchanged(source.status, await lstat(temporary, { bigint: true })) === false)
                  fail(`prepared blob source changed while linking: ${source.path}`)
                try {
                  // Final blob paths are never opened for writing or truncation.
                  await link(temporary, file.blob)
                  sharing.createdBlobs += 1
                } catch (error) {
                  if (hasCode(error, 'EEXIST') === false) throw error
                  const raced = await statusIfPresent(file.blob)
                  if (raced !== undefined) requireBlob(file.blob, raced, file.mode)
                  retry.push(file)
                  continue
                }
                blobStatus = await lstat(file.blob, { bigint: true })
                requireBlob(file.blob, blobStatus, file.mode)
                if (unchanged(source.status, blobStatus) === false)
                  fail(`new blob does not retain its verified source inode: ${file.blob}`)
                remember(blobStatus, file.digest)
              } finally {
                if (linked) await unlinkIfPresent(temporary)
              }
            }
            await substituteCandidate(
              file,
              blobStatus ?? fail(`installed blob is absent: ${file.blob}`),
              sharing,
            )
          }
          return retry
        },
      })
    }
  } finally {
    const errors: unknown[] = []
    for (const file of files) {
      if (file.copy === undefined) continue
      try {
        await unlinkIfPresent(file.copy.path)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length !== 0)
      throw new AggregateError(errors, 'editor view sharing: prepared blob cleanup failed')
  }
}

const within = (parent: string, path: string): boolean => {
  const fromParent = relative(parent, path)
  return (
    fromParent === '' ||
    (isAbsolute(fromParent) === false &&
      fromParent !== '..' &&
      fromParent.startsWith('../') === false)
  )
}

/**
 * Callers MUST prove candidate byte ownership before sharing; admitted sources
 * are never supplied or linked. Only regular payload files participate. Root
 * editor-view.json stays private; nested files with that name are ordinary bytes.
 */
export const shareSnapshotFiles = async ({
  candidate,
  contentStore,
  afterStoreLock,
}: {
  readonly candidate: string
  readonly contentStore: string
  readonly afterStoreLock?: () => void | Promise<void>
}): Promise<EditorViewContentSharing> => {
  const root = resolve(candidate)
  const store = resolve(contentStore)
  if (within(root, store) || within(store, root))
    fail('candidate and content store must not overlap')
  const sharing: EditorViewContentSharing = {
    linkedFiles: 0,
    copiedFiles: 0,
    copiedBytes: 0,
    createdBlobs: 0,
  }
  const token = randomUUID()
  let parentStatus: BigIntStats | undefined
  let files: PreparedFile[] = []
  const flush = async (): Promise<void> => {
    if (files.length === 0) return
    parentStatus ??= await ensureParent(store, true)
    await shareBatch({ contentStore: store, files, parentStatus, token, afterStoreLock, sharing })
    files = []
  }
  for await (const path of regularFiles(root)) {
    const status = await normalizeCandidate(path)
    const digest =
      (await fingerprint(path, status)) ?? fail(`candidate disappeared while hashing: ${path}`)
    const mode = Number(permissions(status))
    files.push({
      path,
      status,
      digest,
      mode,
      blob: join(store, digest.slice(0, 2), `${digest}-${mode === 0o444 ? '0444' : '0555'}`),
    })
    if (files.length === batchSize) await flush()
  }
  await flush()
  return sharing
}

type CollectionCandidate = {
  readonly path: string
  readonly status: BigIntStats
  readonly mode: number
  readonly digest: string
}

const collectionCandidates = async function* (
  contentStore: string,
): AsyncGenerator<CollectionCandidate> {
  if ((await validateDirectory(contentStore, contentStore)) === undefined) return
  for (const shard of await readdir(contentStore, { withFileTypes: true })) {
    const shardPath = join(contentStore, shard.name)
    if (shardPattern.test(shard.name) === false || shard.isDirectory() === false)
      fail(`unknown or symbolic-link content-store shard entry: ${shardPath}`)
    if ((await validateDirectory(shardPath, contentStore)) === undefined) continue
    for (const entry of await readdir(shardPath, { withFileTypes: true })) {
      const path = join(shardPath, entry.name)
      const temporary = temporaryPattern.exec(entry.name)
      if (temporary !== null) {
        const owner = await readOwner(lockPath(contentStore))
        if (
          owner !== undefined &&
          ownerIsLive(owner) &&
          temporary[1] === tokenDigest(owner.token)
        ) {
          const status = await statusIfPresent(path)
          if (status === undefined) continue
          if (status.isFile() && status.uid === userId() && isImmutable(status)) continue
        }
        // A normal publisher may have already removed its private link and lock.
        if ((await statusIfPresent(path)) === undefined) continue
        fail(`unknown temporary blob entry requires explicit recovery: ${path}`)
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
      requireBlob(path, status, mode)
      // Linked blobs cannot be collected. Validate their structure/permissions,
      // but do not reread retained snapshot bytes just to prove non-deletability.
      if (status.nlink !== 1n) continue
      const actual = await fingerprint(path, status, true)
      if (actual === undefined) continue
      if (actual !== match[1]) fail(`blob content does not match its address: ${path}`)
      yield { path, status, mode, digest: actual }
    }
  }
}

/** Delete only validated real blobs with no snapshot/control hardlink remaining. */
export const collectEditorViewContentStore = async ({
  contentStore,
  afterStoreLock,
}: {
  readonly contentStore: string
  readonly afterStoreLock?: () => void | Promise<void>
}): Promise<{ removedBlobs: number; removedBytes: number }> => {
  const store = resolve(contentStore)
  const result = { removedBlobs: 0, removedBytes: 0 }
  if ((await statusIfPresent(store)) === undefined) return result
  await ensureParent(store, false)
  const token = randomUUID()
  let candidates: CollectionCandidate[] = []
  const flush = async (): Promise<void> => {
    if (candidates.length === 0) return
    await withStoreLock({
      contentStore: store,
      token,
      afterStoreLock,
      run: async (directories) => {
        for (const candidate of candidates) {
          const shard = await shardDirectory(
            store,
            candidate.digest.slice(0, 2),
            directories,
            false,
          )
          if (shard === undefined) continue
          const current = await statusIfPresent(candidate.path)
          if (current === undefined) continue
          requireBlob(candidate.path, current, candidate.mode)
          if (unchanged(candidate.status, current) === false || current.nlink !== 1n) continue
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

const recoveryGuardError = (path: string, owner: LockOwner): never =>
  fail(
    `recovery guard already exists at ${path}; token=${JSON.stringify(owner.token)} pid=${owner.pid} status=${ownerIsLive(owner) ? 'live' : 'dead'}; fail closed: quiesce publishers, prove the guard owner dead, rehardening directories only, then explicitly retire that exact guard before retrying recovery`,
  )

const restoreDirectories = async (
  path: string,
  token: string,
  root: string = path,
): Promise<void> => {
  const status = await statusIfPresent(path)
  if (status === undefined) return
  await requireRealDirectory(path, status)
  requireOwned(path, status)
  if ((permissions(status) & ~0o755n) !== 0n)
    fail(`unsafe content-store directory mode during recovery: ${path}`)
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (sameInode(status, await file.stat({ bigint: true })) === false)
      fail(`content-store directory changed during recovery: ${path}`)
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (path === root) {
        if (shardPattern.test(entry.name) === false || entry.isDirectory() === false)
          fail(`unknown or symbolic-link content-store shard during recovery: ${child}`)
        await restoreDirectories(child, token, root)
        continue
      }
      const temporary = temporaryPattern.exec(entry.name)
      if (temporary === null) {
        const blob = blobNamePattern.exec(entry.name)
        if (blob === null || blob[1]?.slice(0, 2) !== basename(path) || entry.isFile() === false)
          fail(`unknown or symbolic-link content-store blob during recovery: ${child}`)
        continue
      }
      if (temporary[1] !== tokenDigest(token))
        fail(`temporary blob does not belong to the exact stale lock token: ${child}`)
      const payload = await statusIfPresent(child)
      if (payload === undefined) continue
      if (payload.isFile() === false || payload.uid !== userId() || isImmutable(payload) === false)
        fail(`stale-token temporary blob is not a real same-user readonly file: ${child}`)
      await file.chmod(0o755)
      const current = await lstat(child, { bigint: true })
      if (unchanged(payload, current) === false)
        fail(`stale-token temporary blob changed during recovery: ${child}`)
      await unlink(child)
    }
  } finally {
    try {
      await file.chmod(0o555)
    } finally {
      await file.close()
    }
  }
}

/**
 * Exact-token administrative recovery never steals a live owner. A readonly
 * sibling guard fences publishers until directory-only rehardening is complete.
 * Interrupted recovery guards require operator quiescence and explicit retirement
 * after proving their PID dead; replacing guards automatically is not safe CAS.
 */
export const recoverEditorViewContentStoreLock = async ({
  contentStore,
  token,
}: {
  readonly contentStore: string
  readonly token: string
}): Promise<void> => {
  const store = resolve(contentStore)
  await ensureParent(store, false)
  const path = lockPath(store)
  const guardPath = recoveryPath(store)
  const guard = await readOwner(guardPath)
  if (guard !== undefined) recoveryGuardError(guardPath, guard)
  const owner = await readOwner(path)
  if (owner === undefined) fail(`content-store lock does not exist: ${path}`)
  if (owner.token !== token)
    fail(`content-store lock token mismatch; lock was not removed: ${path}`)
  if (ownerIsLive(owner))
    fail(`content-store lock owner is still live: pid=${owner.pid} at ${path}`)
  const guardOwner: LockOwner = { schema: lockSchema, token, pid: process.pid }
  const temporary = await prepareOwner(guardPath, guardOwner)
  let installed = false
  try {
    try {
      await link(temporary, guardPath)
      installed = true
    } catch (error) {
      if (hasCode(error, 'EEXIST') === false) throw error
      const existing = await readOwner(guardPath)
      if (existing !== undefined) recoveryGuardError(guardPath, existing)
      fail(`recovery guard changed during installation; retry explicitly: ${guardPath}`)
    }
    const current = await readOwner(path)
    if (current === undefined || current.token !== token || current.pid !== owner.pid)
      fail(`content-store lock ownership changed before recovery; lock was not removed: ${path}`)
    if (ownerIsLive(current))
      fail(`content-store lock owner is still live: pid=${current.pid} at ${path}`)
    await restoreDirectories(store, token)
    const restoredOwner = await readOwner(path)
    if (
      restoredOwner === undefined ||
      restoredOwner.token !== token ||
      restoredOwner.pid !== owner.pid
    )
      fail(`content-store lock ownership changed during recovery; lock was not removed: ${path}`)
    if (ownerIsLive(restoredOwner))
      fail(`content-store lock owner is still live: pid=${restoredOwner.pid} at ${path}`)
    await releaseLock({ path, owner: restoredOwner })
  } finally {
    try {
      if (installed) await releaseLock({ path: guardPath, owner: guardOwner })
    } finally {
      await unlinkIfPresent(temporary)
    }
  }
}
