/**
 * The launcher leases the generations reachable at launch and keeps those leases for the process lifetime. It does not refresh leases when a pointer moves later.
 * A valid lease is not a managed-only root declaration; #1985 owns that integration.
 */
import { dlopen, read as ffiRead } from 'bun:ffi'
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statfsSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { withEditorViewContentStoreLock } from './editor-view-sharing.ts'

const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'
const native = dlopen(library, {
  flock: { args: ['i32', 'i32'], returns: 'i32' },
  fcntl: { args: ['i32', 'i32', 'i32'], returns: 'i32' },
})
/* eslint-disable no-underscore-dangle -- Native ABI names. */
const errnoAddress =
  process.platform === 'darwin'
    ? dlopen(library, { __error: { args: [], returns: 'ptr' } }).symbols.__error
    : dlopen(library, { __errno_location: { args: [], returns: 'ptr' } }).symbols.__errno_location
/* eslint-enable no-underscore-dangle */
const darwinFilesystem =
  process.platform === 'darwin'
    ? dlopen(library, { statfs64: { args: ['ptr', 'ptr'], returns: 'i32' } })
    : undefined

const fail = (message: string): never => {
  throw new Error(`editor view lease: ${message}`)
}
const owned = (status: BigIntStats): boolean =>
  process.getuid !== undefined && status.uid === BigInt(process.getuid())
const same = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino
const privateDirectory = (path: string): BigIntStats => {
  const status = lstatSync(path, { bigint: true })
  if (
    !status.isDirectory() ||
    !owned(status) ||
    (status.mode & 0o077n) !== 0n ||
    realpathSync(path) !== path
  )
    fail(`unsafe private directory: ${path}`)
  return status
}

/** Unknown/remote filesystems must never authorize destructive retirement. */
export const editorViewLeaseFilesystem = (path: string): 'local' | 'unknown' => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return 'unknown'
  if (darwinFilesystem !== undefined) {
    // Darwin's public __DARWIN_STRUCT_STATFS64 ABI: 2168 bytes, fstypename at 72.
    // f_type is dynamically assigned, not a stable APFS/HFS magic number.
    const status = Buffer.alloc(2168)
    if (darwinFilesystem.symbols.statfs64(Buffer.from(`${path}\0`), status) !== 0) return 'unknown'
    const name = status.subarray(72, 88).toString('utf8').split('\0', 1)[0]
    return name === 'apfs' || name === 'hfs' ? 'local' : 'unknown'
  }
  const type = Number(statfsSync(path).type) >>> 0
  // ext2/3/4, XFS, Btrfs, tmpfs, ramfs, local OpenZFS. Overlay stays unknown.
  return [0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x858458f6, 0x2fc12fc1].includes(type)
    ? 'local'
    : 'unknown'
}

const paths = ({
  editorRoot,
  snapshot,
}: {
  readonly editorRoot: string
  readonly snapshot: string
}): { root: string; generation: string; snapshot: string; control: string } => {
  const root = resolve(editorRoot)
  const generation = basename(snapshot)
  if (
    generation === '.' ||
    generation === '..' ||
    generation.length === 0 ||
    (!isAbsolute(snapshot) && generation !== snapshot)
  )
    fail('invalid generation name')
  const payload = join(root, '.store', generation)
  if (isAbsolute(snapshot) && resolve(snapshot) !== payload)
    fail('snapshot is outside the owning root')
  return {
    root,
    generation,
    snapshot: payload,
    control: join(root, '.leases', `${generation}.lock`),
  }
}

const validateGeneration = (root: string, snapshot: string, requireLocal = true): BigIntStats => {
  if (realpathSync(root) !== root) fail('editor root is not canonical')
  const store = lstatSync(join(root, '.store'), { bigint: true })
  const status = lstatSync(snapshot, { bigint: true })
  if (
    !store.isDirectory() ||
    !status.isDirectory() ||
    !owned(store) ||
    !owned(status) ||
    realpathSync(snapshot) !== snapshot
  )
    fail('unsafe generation identity')
  if (
    requireLocal &&
    (editorViewLeaseFilesystem(root) !== 'local' || editorViewLeaseFilesystem(snapshot) !== 'local')
  )
    fail('unknown filesystem semantics')
  return status
}

const controlIdentity = (control: string, status: BigIntStats): string =>
  `${status.dev}:${status.ino}\n${dirname(dirname(control))}\n${basename(control, '.lock')}\n`

const validateControl = (control: string, fd: number): BigIntStats => {
  privateDirectory(dirname(control))
  const status = fstatSync(fd, { bigint: true })
  const named = lstatSync(control, { bigint: true })
  if (
    !status.isFile() ||
    !owned(status) ||
    status.nlink !== 1n ||
    (status.mode & 0o777n) !== 0o600n ||
    !same(status, named) ||
    named.nlink !== 1n ||
    status.size > 8192n
  )
    fail(`unsafe or replaced control: ${control}`)
  // A fresh buffer uses pread semantics; descriptor position must not affect validation.
  const text = Buffer.alloc(Number(status.size))
  if (
    readSync(fd, text, 0, text.length, 0) !== text.length ||
    text.toString('utf8') !== controlIdentity(control, status)
  )
    fail(`replaced control identity: ${control}`)
  if ((native.symbols.fcntl(fd, 1, 0) & 1) !== 1) fail('lease descriptor must be close-on-exec')
  return status
}

/** Caller MUST hold the owning CAS fence. Never remove these tombstones, including on retirement. */
export const ensureEditorViewLeaseControl = (input: {
  readonly editorRoot: string
  readonly snapshot: string
}): void => {
  const identity = paths(input)
  validateGeneration(identity.root, identity.snapshot, false)
  try {
    mkdirSync(dirname(identity.control), { mode: 0o700 })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  privateDirectory(dirname(identity.control))
  let created = false
  let fd: number
  try {
    fd = openSync(
      identity.control,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        (process.platform === 'darwin' ? 0x1000000 : 0x80000),
      0o600,
    )
    created = true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    fd = openSync(
      identity.control,
      constants.O_RDWR |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW |
        (process.platform === 'darwin' ? 0x1000000 : 0x80000),
    )
  }
  try {
    if (created) writeSync(fd, controlIdentity(identity.control, fstatSync(fd, { bigint: true })))
    validateControl(identity.control, fd)
  } finally {
    closeSync(fd)
  }
}

export type EditorViewLeaseProbe = {
  readonly state: 'clear' | 'held' | 'unknown'
  readonly reasons: readonly string[]
  readonly release: () => void
}
const acquire = (
  input: { readonly editorRoot: string; readonly snapshot: string },
  exclusive: boolean,
): EditorViewLeaseProbe & {
  readonly fd?: number
  readonly snapshot?: string
  readonly generation?: string
} => {
  let fd: number | undefined
  try {
    const identity = paths(input)
    const generation = validateGeneration(identity.root, identity.snapshot)
    privateDirectory(dirname(identity.control))
    fd = openSync(
      identity.control,
      constants.O_RDWR |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW |
        (process.platform === 'darwin' ? 0x1000000 : 0x80000),
    )
    validateControl(identity.control, fd)
    let result: number
    do {
      result = native.symbols.flock(fd, (exclusive ? 2 : 1) | 4)
    } while (result !== 0 && ffiRead.i32(errnoAddress()!) === 4)
    if (result !== 0) {
      const errno = ffiRead.i32(errnoAddress()!)
      closeSync(fd)
      fd = undefined
      return {
        state: errno === (process.platform === 'darwin' ? 35 : 11) ? 'held' : 'unknown',
        reasons: [`flock errno=${errno}`],
        release: () => {},
      }
    }
    validateControl(identity.control, fd)
    if (!same(generation, validateGeneration(identity.root, identity.snapshot)))
      fail('generation replaced during acquisition')
    const descriptor = fd
    let closed = false
    return {
      state: 'clear',
      reasons: [],
      fd: descriptor,
      snapshot: identity.snapshot,
      generation: identity.generation,
      release: () => {
        if (!closed) {
          closed = true
          closeSync(descriptor)
        }
      },
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    return {
      state: 'unknown',
      reasons: [error instanceof Error ? error.message : String(error)],
      release: () => {},
    }
  }
}

/** Nonblocking EX; caller owns CAS exclusion and retains this handle through retirement. */
export const probeEditorViewLease = (input: {
  readonly editorRoot: string
  readonly snapshot: string
}): EditorViewLeaseProbe => acquire(input, true)

/** Resolution happens inside the CAS fence, never before it. Closing, not LOCK_UN, releases ownership. */
export const acquireEditorViewLease = async ({
  editorRoot,
  contentStore,
  resolveSnapshot,
}: {
  readonly editorRoot: string
  readonly contentStore: string
  readonly resolveSnapshot: () => string | Promise<string>
}): Promise<{
  readonly fd: number
  readonly snapshot: string
  readonly generation: string
  readonly release: () => void
}> => {
  let retained: EditorViewLeaseProbe | undefined
  try {
    return await withEditorViewContentStoreLock({
      contentStore,
      run: async () => {
        const lease = acquire({ editorRoot, snapshot: await resolveSnapshot() }, false)
        retained = lease
        if (
          lease.state !== 'clear' ||
          lease.fd === undefined ||
          lease.snapshot === undefined ||
          lease.generation === undefined
        )
          fail(`cannot acquire reader lease: ${lease.reasons.join('; ')}`)
        return {
          fd: lease.fd,
          snapshot: lease.snapshot,
          generation: lease.generation,
          release: lease.release,
        }
      },
    })
  } catch (error) {
    retained?.release()
    throw error
  }
}
