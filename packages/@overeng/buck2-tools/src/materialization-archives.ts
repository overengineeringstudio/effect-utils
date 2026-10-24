/* eslint-disable no-await-in-loop -- Transfers stream through bounded buffers; digest exclusion, lease fences and filesystem walks must settle in order. */
import { dlopen, read as ffiRead } from 'bun:ffi'
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs'
import { copyFile, lstat, open, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  publicArchiveRedirectUrl,
  publicArchiveUrl,
} from '../../../../buck2/dependencies/public-archive-origin.ts'
import {
  acquireExistingEditorViewLeaseUnderFence,
  editorViewLeaseFilesystem,
  ensureEditorViewLeaseControl,
  probeEditorViewLeaseUnderFence,
} from './editor-view-leases.ts'
import {
  collectEditorViewContentStore,
  defaultEditorViewContentStore,
  editorViewContentStoreCensus,
  editorViewContentStoreHighWaterBytes,
  editorViewGitCommonDirectory,
  pinEditorViewContent,
  shareSnapshotFiles,
  withEditorViewContentStoreLock,
} from './editor-view-sharing.ts'
import type { EditorViewContentCensus } from './editor-view-sharing.ts'

const fail = (message: string): never => {
  throw new Error(`Buck archive sharing: ${message}`)
}
const digestPattern = /^[a-f0-9]{64}$/
const archivePattern = /^archive-([a-f0-9]{64})$/
const absent = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
const ownedDirectory = (path: string): BigIntStats => {
  const status = lstatSync(path, { bigint: true })
  if (
    status.isDirectory() === false ||
    status.uid !== BigInt(process.getuid!()) ||
    (status.mode & 0o022n) !== 0n ||
    realpathSync(path) !== path
  )
    fail(`unsafe directory: ${path}`)
  return status
}
const nearestParent = (path: string): string => {
  let parent = path
  while (existsSync(parent) === false) parent = dirname(parent)
  return parent
}

/** Admission runs before Buck analysis: unsupported hosts select native download_file. */
export const archiveSharingAdmission = ({
  repoRoot,
  env = process.env,
}: {
  readonly repoRoot: string
  readonly env?: Readonly<Record<string, string | undefined>>
}): { contentStore: string; highWaterBytes: number } | undefined => {
  if (env['CI'] !== undefined && env['CI'] !== '' && env['CI'] !== 'false' && env['CI'] !== '0')
    return undefined
  if (env['BUCK2_HOST_MATERIALIZATION'] === '0') return undefined
  if (
    env['EDITOR_VIEW_LEASE_LIBRARY'] === undefined ||
    env['EDITOR_VIEW_LEASE_LIBRARY'].startsWith('/nix/store/') === false ||
    existsSync(env['EDITOR_VIEW_LEASE_LIBRARY']) === false
  )
    return undefined
  const common = editorViewGitCommonDirectory(repoRoot)
  if (common === undefined || common.includes('/.megarepo/') === false) return undefined
  const canonicalCommon = realpathSync(common)
  if (editorViewLeaseFilesystem(canonicalCommon) !== 'local') return undefined
  const gitFile = join(realpathSync(repoRoot), '.git')
  if (lstatSync(gitFile).isFile() === false) return undefined
  const gitdir = /^gitdir: (.+)$/.exec(readFileSync(gitFile, 'utf8').trimEnd())
  if (gitdir === null) return undefined
  const administration = realpathSync(resolve(repoRoot, gitdir[1]!))
  if (realpathSync(readFileSync(join(administration, 'gitdir'), 'utf8').trim()) !== gitFile)
    fail('worktree registration does not point back to this root')
  // Resolve the existing CAS, but never permit its standalone-home fallback.
  const contentStore = defaultEditorViewContentStore({ repoRoot: repoRoot, env: env })
  const localRoots = [resolve(repoRoot), env['RUNNER_TEMP'], env['TMPDIR']].filter(
    (path): path is string => path !== undefined && path !== '',
  )
  if (
    localRoots.some(
      (path) => contentStore === resolve(path) || contentStore.startsWith(`${resolve(path)}/`),
    ) === true
  )
    return undefined
  const parent = nearestParent(contentStore)
  const status = ownedDirectory(parent)
  if (
    status.dev !== ownedDirectory(canonicalCommon).dev ||
    editorViewLeaseFilesystem(parent) !== 'local'
  )
    return undefined
  return { contentStore, highWaterBytes: editorViewContentStoreHighWaterBytes(env) }
}

const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'
const native = dlopen(library, { flock: { args: ['i32', 'i32'], returns: 'i32' } })
/* eslint-disable no-underscore-dangle -- Native libc ABI. */
const errno =
  process.platform === 'darwin'
    ? dlopen(library, { __error: { args: [], returns: 'ptr' } }).symbols.__error
    : dlopen(library, { __errno_location: { args: [], returns: 'ptr' } }).symbols.__errno_location
/* eslint-enable no-underscore-dangle */
const closeOnExec = process.platform === 'darwin' ? 0x1000000 : 0x80000

/** Digest locks are outside CAS exclusion and release on crash/descriptor close. */
const lockArchive = async ({
  metadata,
  digest,
  wait = true,
}: {
  metadata: string
  digest: string
  wait?: boolean
}) => {
  const locks = join(metadata, '.downloads')
  mkdirSync(locks, { mode: 0o700, recursive: true })
  ownedDirectory(metadata)
  ownedDirectory(locks)
  const path = join(locks, `${digest}.lock`)
  const file = await open(
    path,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      closeOnExec,
    0o600,
  )
  try {
    const before = await file.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    if (
      before.isFile() === false ||
      before.uid !== BigInt(process.getuid!()) ||
      before.nlink !== 1n ||
      (before.mode & 0o777n) !== 0o600n ||
      before.ino !== named.ino ||
      before.dev !== named.dev
    )
      fail('unsafe download control')
    while (native.symbols.flock(file.fd, 2 | 4) !== 0) {
      const code = ffiRead.i32(errno())
      if (code !== 11 && code !== 35) fail(`digest flock failed: ${code}`)
      if (wait === false) {
        await file.close()
        return undefined
      }
      await Bun.sleep(10)
    }
    return file
  } catch (error) {
    await file.close()
    throw error
  }
}

const verifyArchive = async ({
  path,
  digest,
  size,
}: {
  path: string
  digest: string
  size: number
}): Promise<void> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (
      before.isFile() === false ||
      before.uid !== BigInt(process.getuid!()) ||
      before.size !== BigInt(size) ||
      (before.mode & 0o777n) !== 0o444n
    )
      fail('archive mode, owner or size mismatch')
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    const after = await file.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    if (
      hash.digest('hex') !== digest ||
      before.ino !== named.ino ||
      before.dev !== named.dev ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.mode !== after.mode ||
      (before.ctimeNs !== after.ctimeNs && before.nlink === 1n && after.nlink === 1n)
    )
      fail('archive content or identity mismatch')
  } finally {
    await file.close()
  }
}

/** Network transport seam; origin validation and integrity always stay in the service. */
export type ArchiveResponseFetcher = (url: string, options: RequestInit) => Promise<Response>

const downloadArchive = async ({
  url,
  path,
  digest,
  size,
  fetchResponse,
}: {
  url: string
  path: string
  digest: string
  size: number
  fetchResponse: ArchiveResponseFetcher
}): Promise<number> => {
  let current = publicArchiveUrl({ url, location: 'archive acquisition URL' })
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchResponse(current, { redirect: 'manual', credentials: 'omit' })
    if ([301, 302, 303, 307, 308].includes(response.status) === true) {
      const location = response.headers.get('location') ?? fail('redirect without location')
      await response.body?.cancel()
      current = publicArchiveRedirectUrl({ from: current, redirect: location })
      continue
    }
    if (response.ok === false || response.body === null)
      fail(`archive HTTP status ${response.status}`)
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    let bytes = 0
    const hash = createHash('sha256')
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength
        if (bytes > size) fail('download exceeds declared size')
        hash.update(chunk)
        let offset = 0
        while (offset < chunk.byteLength) offset += (await file.write(chunk, offset)).bytesWritten
      }
      if (bytes !== size || hash.digest('hex') !== digest) fail('download digest/size mismatch')
      await file.chmod(0o444)
      await file.sync()
      return bytes
    } finally {
      await file.close()
      await response.body.cancel().catch(() => undefined)
    }
  }
  return fail('archive redirect limit exceeded')
}

const syncDirectory = async (path: string): Promise<void> => {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
const metadataRoot = (contentStore: string): string => `${contentStore}.buck-materialization-v1`

const initializeMetadata = (contentStore: string): string => {
  const metadata = metadataRoot(contentStore)
  for (const directory of [
    metadata,
    join(metadata, '.store'),
    join(metadata, '.staging'),
    join(metadata, '.garbage'),
    join(metadata, '.access'),
  ]) {
    mkdirSync(directory, { mode: 0o700, recursive: true })
    ownedDirectory(directory)
  }
  return metadata
}

const metadataAllocatedBytes = async (root: string): Promise<number> => {
  let total = 0
  try {
    total = Number((await lstat(root, { bigint: true })).blocks) * 512
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      try {
        if (entry.isDirectory() === true) {
          ownedDirectory(path)
          total += await metadataAllocatedBytes(path)
        } else if (entry.isFile() === true) {
          // Payload pin allocation is already counted once in C's census.
          if (root.endsWith('/pins') === false)
            total += Number((await lstat(path, { bigint: true })).blocks) * 512
        } else fail('unsafe materialization metadata entry')
      } catch (error) {
        if (absent(error) === false) throw error
      }
    }
  } catch (error) {
    if (absent(error) === false) throw error
  }
  return total
}

/** LRU hints rank candidates but never authorize unlinking any payload. */
export const recordMaterializationContentUse = async ({
  contentStore,
  keys,
}: {
  contentStore: string
  keys: Iterable<string>
}): Promise<void> => {
  const metadata = initializeMetadata(contentStore)
  for (const key of new Set(keys)) {
    if (/^[a-f0-9]{64}-(0444|0555)$/.test(key) === false) fail('invalid access hint key')
    const temporary = join(metadata, '.access', `.${key}-${randomUUID()}`)
    await writeFile(temporary, `${Date.now()}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(metadata, '.access', key))
  }
}

/** Allocated host content and separately counted metadata under the shared high-water trigger. */
export type ArchiveContentPressure = EditorViewContentCensus & {
  readonly state: 'referenced-bytes-over-cap' | 'within-cap'
  readonly highWaterBytes: number
  readonly metadataBytes: number
  readonly combinedBytes: number
}

/** A renamed garbage generation cannot gain readers; digest exclusion proves its retiring writer exited. */
const reclaimRetiredArchive = async ({
  contentStore,
  metadata,
  name,
  digest,
}: {
  contentStore: string
  metadata: string
  name: string
  digest: string
}): Promise<void> => {
  const garbage = join(metadata, '.garbage', name)
  if (existsSync(garbage) === false) return
  ownedDirectory(garbage)
  const pins = join(garbage, 'pins')
  if (existsSync(pins) === true) {
    ownedDirectory(pins)
    for (const pinName of await readdir(pins)) {
      if (pinName !== `${digest}-0444`) fail('unknown retired archive pin')
      const path = join(pins, pinName)
      await verifyArchive({ path: path, digest: digest, size: Number((await lstat(path)).size) })
      await withEditorViewContentStoreLock({
        contentStore,
        run: async () => {
          await unlink(path)
        },
      })
    }
    await rmdir(pins)
  }
  await rmdir(garbage)
}

/** Retire only independently EX-leased archive pins, then invoke the one CAS collector. */
export const maintainArchiveContent = async ({
  contentStore,
  highWaterBytes,
}: {
  contentStore: string
  highWaterBytes: number
}): Promise<ArchiveContentPressure> => {
  if (Number.isSafeInteger(highWaterBytes) === false || highWaterBytes <= 0)
    fail('invalid high water')
  if (editorViewLeaseFilesystem(nearestParent(contentStore)) !== 'local')
    fail('unknown maintenance filesystem')
  const metadata = initializeMetadata(contentStore)
  for (const name of await readdir(join(metadata, '.garbage'))) {
    const match = /^archive-([a-f0-9]{64})-[a-f0-9-]{36}$/.exec(name)
    if (match === null) fail('unknown retired archive generation')
    const digest = match![1]!
    const lock = await lockArchive({ metadata: metadata, digest: digest, wait: false })
    if (lock === undefined) continue
    try {
      await reclaimRetiredArchive({
        contentStore: contentStore,
        metadata: metadata,
        name: name,
        digest: digest,
      })
    } finally {
      await lock.close()
    }
  }
  const initial = await editorViewContentStoreCensus(contentStore)
  if (initial.totalBytes > highWaterBytes) {
    const generations = await readdir(join(metadata, '.store'))
    const ordered: { generation: string; digest: string; used: number }[] = []
    for (const generation of generations) {
      const match = archivePattern.exec(generation)
      if (match === null) fail('unknown archive generation')
      const digest = match![1]!
      let used = 0
      try {
        used = (await lstat(join(metadata, '.access', `${digest}-0444`))).mtimeMs
      } catch (error) {
        if (absent(error) === false) throw error
      }
      ordered.push({ generation, digest, used })
    }
    ordered.sort((left, right) => left.used - right.used)
    for (const entry of ordered) {
      if ((await editorViewContentStoreCensus(contentStore)).totalBytes <= highWaterBytes) break
      const lock = await lockArchive({ metadata: metadata, digest: entry.digest, wait: false })
      if (lock === undefined) continue
      const snapshot = join(metadata, '.store', entry.generation)
      try {
        if (existsSync(snapshot) === false) continue
        ownedDirectory(snapshot)
        ownedDirectory(join(snapshot, 'pins'))
        const pin = join(snapshot, 'pins', `${entry.digest}-0444`)
        if ((await readdir(join(snapshot, 'pins'))).join() !== `${entry.digest}-0444`)
          fail('malformed archive pins')
        await verifyArchive({
          path: pin,
          digest: entry.digest,
          size: Number((await lstat(pin)).size),
        })
        await withEditorViewContentStoreLock({
          contentStore,
          run: async () => {
            if (existsSync(snapshot) === false) return
            const lease = probeEditorViewLeaseUnderFence({ editorRoot: metadata, snapshot })
            try {
              if (lease.state !== 'clear') return
              const garbage = join(metadata, '.garbage', `${entry.generation}-${randomUUID()}`)
              await rename(snapshot, garbage)
              await unlink(join(garbage, 'pins', `${entry.digest}-0444`))
              await rmdir(join(garbage, 'pins'))
              await rmdir(garbage)
            } finally {
              lease.release()
            }
          },
        })
      } finally {
        await lock.close()
      }
      await collectEditorViewContentStore({
        contentStore,
        pressure: { highWaterBytes, accessDirectory: join(metadata, '.access') },
      })
    }
    await collectEditorViewContentStore({
      contentStore,
      pressure: { highWaterBytes, accessDirectory: join(metadata, '.access') },
    })
  }
  const census = await editorViewContentStoreCensus(contentStore)
  const metadataBytes = await metadataAllocatedBytes(metadata)
  return {
    state: census.referencedBytes > highWaterBytes ? 'referenced-bytes-over-cap' : 'within-cap',
    highWaterBytes,
    ...census,
    metadataBytes,
    combinedBytes: census.totalBytes + metadataBytes,
  }
}

/** One nonblocking, rate-bounded census after insertion; cache hits never scan C. */
const maintainAfterArchivePublication = async ({
  contentStore,
  metadata,
  highWaterBytes,
}: {
  contentStore: string
  metadata: string
  highWaterBytes: number
}): Promise<void> => {
  const lock = await lockArchive({ metadata, digest: 'maintenance', wait: false })
  if (lock === undefined) return
  try {
    const previous = await lock.stat()
    const elapsed = Date.now() - previous.mtimeMs
    if (previous.size !== 0 && elapsed >= 0 && elapsed < 30_000) return
    const pressure = await maintainArchiveContent({ contentStore, highWaterBytes })
    process.stderr.write(`[buck-materialization-pressure] ${JSON.stringify(pressure)}\n`)
    await lock.truncate(0)
    await lock.writeFile(`${Date.now()}\n`)
  } finally {
    await lock.close()
  }
}

/** One public registry acquisition. Outputs are always independent from readonly CAS inodes. */
export const acquireSharedArchive = async ({
  contentStore,
  highWaterBytes,
  url,
  digest,
  size,
  output,
  fetchResponse = fetch,
}: {
  readonly contentStore: string
  readonly highWaterBytes: number
  readonly url: string
  readonly digest: string
  readonly size: number
  readonly output: string
  readonly fetchResponse?: ArchiveResponseFetcher
}): Promise<{
  downloadedBytes: number
  copiedBytes: number
  clonedBytes: number
  cacheHit: boolean
  copyReason: string | undefined
  timingsMs: Record<string, number>
}> => {
  const timingsMs: Record<string, number> = {}
  let previous = performance.now()
  const phase = (name: string): void => {
    const now = performance.now()
    timingsMs[name] = now - previous
    previous = now
  }
  publicArchiveUrl({ url, location: 'archive acquisition URL' })
  if (Number.isSafeInteger(highWaterBytes) === false || highWaterBytes <= 0)
    fail('invalid high water')
  if (digestPattern.test(digest) === false || Number.isSafeInteger(size) === false || size <= 0)
    fail('invalid declared archive identity')
  const parent = nearestParent(contentStore)
  if (editorViewLeaseFilesystem(parent) !== 'local') fail('filesystem no longer admitted')
  ownedDirectory(parent)
  const metadata = initializeMetadata(contentStore)
  phase('admission')
  const lock =
    (await lockArchive({ metadata: metadata, digest: digest })) ?? fail('download lock unavailable')
  phase('digestLock')
  const generation = `archive-${digest}`
  const snapshot = join(metadata, '.store', generation)
  const pinName = `${digest}-0444`
  let downloadedBytes = 0
  let clonedBytes = 0
  let copyReason: string | undefined
  let stage: string | undefined
  let published = false
  let lease: { readonly release: () => void } | undefined
  try {
    if (existsSync(snapshot) === false) {
      // Digest exclusion proves these private leftovers have no live publisher.
      for (const name of await readdir(join(metadata, '.staging'))) {
        if (name.startsWith(`${digest}-`) === false) continue
        if (new RegExp(`^${digest}-[a-f0-9-]{36}$`).test(name) === false)
          fail('unknown archive staging entry')
        const abandoned = join(metadata, '.staging', name)
        ownedDirectory(abandoned)
        for (const file of await readdir(join(abandoned, 'pins'))) {
          if (file !== pinName) fail('unknown staged pin')
          await unlink(join(abandoned, 'pins', file))
        }
        await rmdir(join(abandoned, 'pins'))
        await rmdir(abandoned)
      }
    }
    phase('stagingRecovery')
    if (existsSync(snapshot) === false) {
      stage = join(metadata, '.staging', `${digest}-${randomUUID()}`)
      mkdirSync(join(stage, 'pins'), { recursive: true, mode: 0o700 })
      const pin = join(stage, 'pins', pinName)
      const hit = await pinEditorViewContent({ contentStore, digest, size, destination: pin })
      if (hit === false) {
        downloadedBytes = await downloadArchive({ url, digest, size, path: pin, fetchResponse })
        await shareSnapshotFiles({ candidate: stage, contentStore })
      }
      await verifyArchive({ path: pin, digest: digest, size: size })
      await syncDirectory(join(contentStore, digest.slice(0, 2)))
      await syncDirectory(join(stage, 'pins'))
      await syncDirectory(stage)
      const ready = stage
      await withEditorViewContentStoreLock({
        contentStore,
        run: async () => {
          await rename(ready, snapshot)
          stage = undefined
          ensureEditorViewLeaseControl({ editorRoot: metadata, snapshot })
          await syncDirectory(join(metadata, '.store'))
        },
      })
      published = true
    }
    phase('publication')
    // Every archive publisher and retirer holds this same digest exclusion.
    // The published control is mandatory; hits need no global CAS fence.
    lease = acquireExistingEditorViewLeaseUnderFence({ editorRoot: metadata, snapshot })
    phase('lease')
    const pin = join(snapshot, 'pins', pinName)
    await verifyArchive({ path: pin, digest: digest, size: size })
    // A generation must retain the canonical CAS inode, not a private lookalike.
    const blob = await lstat(join(contentStore, digest.slice(0, 2), pinName), { bigint: true })
    const pinned = await lstat(pin, { bigint: true })
    if (blob.ino !== pinned.ino || blob.dev !== pinned.dev || blob.nlink < 2n)
      fail('archive pin is not the canonical CAS inode')
    phase('pinVerification')
    const temporary = join(dirname(resolve(output)), `.archive-${randomUUID()}`)
    try {
      try {
        await copyFile(pin, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE)
        clonedBytes = size
      } catch (error) {
        if (
          (error instanceof Error &&
            'code' in error &&
            ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS'].includes(String(error.code)) ===
              true) === false
        )
          throw error
        copyReason = String(error.code)
        await copyFile(pin, temporary, constants.COPYFILE_EXCL)
      }
      await verifyArchive({ path: temporary, digest: digest, size: size })
      const copied = await lstat(temporary, { bigint: true })
      if (copied.ino === pinned.ino && copied.dev === pinned.dev)
        fail('ordinary output must not share CAS inode')
      await rename(temporary, output)
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (absent(error) === false) throw error
      })
    }
    phase('privateOutput')
    await recordMaterializationContentUse({ contentStore: contentStore, keys: [pinName] })
    phase('accessHint')
    return {
      downloadedBytes,
      copiedBytes: clonedBytes === 0 ? size : 0,
      clonedBytes,
      cacheHit: downloadedBytes === 0,
      copyReason,
      timingsMs,
    }
  } finally {
    try {
      lease?.release()
      if (stage !== undefined) {
        // Only our unpublished private staging is eligible; never chmod payloads.
        const pin = join(stage, 'pins', pinName)
        await unlink(pin).catch((error: unknown) => {
          if (absent(error) === false) throw error
        })
        await rmdir(join(stage, 'pins'))
        await rmdir(stage)
      }
    } finally {
      await lock.close()
    }
    phase('release')
    if (published === true)
      await maintainAfterArchivePublication({ contentStore, metadata, highWaterBytes })
    phase('maintenance')
  }
}
