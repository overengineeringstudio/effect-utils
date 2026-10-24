/* eslint-disable no-await-in-loop -- Kernel exclusion acquisition waits without holding the CAS fence. */
import { dlopen, read as ffiRead } from 'bun:ffi'
import { constants, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

const fail = (message: string): never => {
  throw new Error(`Buck materialization metadata: ${message}`)
}
const ownedDirectory = (path: string): void => {
  const status = lstatSync(path, { bigint: true })
  if (
    status.isDirectory() === false ||
    status.uid !== BigInt(process.getuid!()) ||
    (status.mode & 0o022n) !== 0n ||
    realpathSync(path) !== path
  )
    fail(`unsafe directory: ${path}`)
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
export const lockMaterialization = async ({
  metadata,
  digest,
  wait = true,
  kind = 'archive',
}: {
  metadata: string
  digest: string
  wait?: boolean
  kind?: 'archive' | 'recipe'
}): Promise<FileHandle | undefined> => {
  const locks = join(metadata, kind === 'recipe' ? '.recipes' : '.downloads')
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
      const address = errno() ?? fail('digest flock errno pointer unavailable')
      const code = ffiRead.i32(address)
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
/** Persist directory entries before exposing a published generation. */
export const syncMaterializationDirectory = async (path: string): Promise<void> => {
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

/** Create and validate only the shared materialization metadata hierarchy. */
export const initializeMaterializationMetadata = (contentStore: string): string => {
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
