import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, realpath, link, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const fail = (message: string): never => {
  throw new Error(`editor view sharing: ${message}`)
}

const unchanged = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs &&
  left.mode === right.mode

// Write bits disappear during final hardening; every remaining permission bit must agree.
const outputMode = (status: BigIntStats): bigint => status.mode & 0o7555n

const regularFiles = async function* (
  directory: string,
  root: string = directory,
): AsyncGenerator<string> {
  const status = await lstat(directory)
  if (status.isDirectory() === false || (await realpath(directory)) !== resolve(directory))
    fail(`snapshot directory must not contain symbolic links: ${directory}`)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() === true) yield* regularFiles(path, root)
    else if (entry.isFile() === true && (directory !== root || entry.name !== 'editor-view.json'))
      yield path
  }
}

const fingerprint = async (path: string, expected: BigIntStats): Promise<string> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat({ bigint: true })
    if (before.isFile() === false || unchanged(expected, before) === false)
      fail(`payload changed before hashing: ${path}`)
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    if (
      unchanged(before, await file.stat({ bigint: true })) === false ||
      unchanged(before, await lstat(path, { bigint: true })) === false
    )
      fail(`payload changed while hashing: ${path}`)
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}

type SharedFile = { readonly path: string; readonly status: BigIntStats }

/**
 * Share payload inodes only within publisher-owned snapshots. Callers must prove byte
 * ownership first and supply immutable, hardened prior snapshots (never admitted roots).
 * Links belong to snapshots themselves, so removing the last snapshot frees the inode.
 */
export const shareSnapshotFiles = async ({
  candidate,
  snapshots,
}: {
  readonly candidate: string
  readonly snapshots: readonly string[]
}): Promise<void> => {
  if (snapshots.length === 0) return
  const candidateStatus = await lstat(candidate, { bigint: true })
  const files = new Map<string, SharedFile>()
  for (const snapshot of snapshots) {
    const snapshotStatus = await lstat(snapshot, { bigint: true })
    if (snapshotStatus.isDirectory() === false || snapshotStatus.dev !== candidateStatus.dev) {
      if (snapshotStatus.isDirectory() === false) fail(`snapshot is not a directory: ${snapshot}`)
      continue
    }
    if (resolve(snapshot) === resolve(candidate)) fail('candidate must not be a prior snapshot')
    for await (const path of regularFiles(snapshot)) {
      const status = await lstat(path, { bigint: true })
      if (status.isFile() === false) fail(`snapshot payload is not a regular file: ${path}`)
      if ((status.mode & 0o222n) !== 0n) fail(`prior snapshot payload is writable: ${path}`)
      if (status.dev !== candidateStatus.dev) continue
      const digest = await fingerprint(path, status)
      const key = `${status.size}:${outputMode(status)}:${digest}`
      if (files.has(key) === false) files.set(key, { path, status })
    }
  }
  for await (const path of regularFiles(candidate)) {
    const status = await lstat(path, { bigint: true })
    if (status.isFile() === false) fail(`candidate payload is not a regular file: ${path}`)
    if (status.dev !== candidateStatus.dev) continue
    const digest = await fingerprint(path, status)
    const source = files.get(`${status.size}:${outputMode(status)}:${digest}`)
    if (source === undefined) continue
    // Adding our own links changes ctime. Refresh the stored census after every link.
    if (unchanged(source.status, await lstat(source.path, { bigint: true })) === false)
      fail(`prior snapshot payload changed before linking: ${source.path}`)
    if (unchanged(status, await lstat(path, { bigint: true })) === false)
      fail(`candidate payload changed before linking: ${path}`)
    const temporary = join(dirname(path), `.${basename(path)}.share-${randomUUID()}`)
    let linked = false
    try {
      try {
        await link(source.path, temporary)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EXDEV') continue
        throw error
      }
      linked = true
      const linkedStatus = await lstat(temporary, { bigint: true })
      if (
        linkedStatus.isFile() === false ||
        linkedStatus.dev !== source.status.dev ||
        linkedStatus.ino !== source.status.ino ||
        linkedStatus.size !== source.status.size ||
        linkedStatus.mtimeNs !== source.status.mtimeNs ||
        linkedStatus.mode !== source.status.mode
      )
        fail(`prior snapshot payload changed while linking: ${source.path}`)
      if (unchanged(status, await lstat(path, { bigint: true })) === false)
        fail(`candidate payload changed while linking: ${path}`)
      await rename(temporary, path)
      linked = false
      files.set(`${status.size}:${outputMode(status)}:${digest}`, {
        path: source.path,
        status: await lstat(source.path, { bigint: true }),
      })
    } finally {
      if (linked === true) await unlink(temporary)
    }
  }
}
