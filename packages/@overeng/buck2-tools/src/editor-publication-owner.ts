import type * as NativeFfi from 'bun:ffi'
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { getSystemErrorName } from 'node:util'

/** Stable across invocations: publication owns a separate materializer and DICE graph. */
export const editorPublicationIsolation = 'editor-publication'
export const editorPublicationLockPath = (root: string): string => {
  const directory = join(realpathSync(root), '.devenv')
  const observed = lstatSync(directory, { throwIfNoEntry: false })
  if (
    observed !== undefined &&
    (observed.isDirectory() === false || realpathSync(directory) !== directory)
  )
    throw new Error('Buck editor publication owner requires a real canonical control directory')
  return join(directory, 'editor-view-publication.lock')
}

// Read-only Node consumers can import buck2-tools; native locking itself requires Bun.
let ffi: typeof NativeFfi | undefined

type PublicationFlock = {
  readonly open: (path: string) => number
  readonly acquire: (fd: number) => number
  readonly monotonicSeconds: () => number
  readonly close: () => void
}

const openFlock = (): PublicationFlock => {
  const path = process.env.BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY
  if (path === undefined || path.length === 0)
    throw new Error('Buck editor publication requires BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY')
  ffi ??= createRequire(import.meta.url)('bun:ffi') as typeof NativeFfi
  const { dlopen, ptr } = ffi
  const library = (() => {
    try {
      return dlopen(path, {
        buck2_publication_owner_open: { args: ['cstring'], returns: 'i32' },
        buck2_publication_owner_lock: { args: ['i32', 'i32'], returns: 'i32' },
        clock_gettime: { args: ['i32', 'ptr'], returns: 'i32' },
      })
    } catch (cause) {
      throw new Error(`Could not load Buck editor publication owner library: ${path}`, { cause })
    }
  })()
  const time = Buffer.alloc(16)
  const timePointer = ptr(time)
  return {
    open: (path: string): number => library.symbols.buck2_publication_owner_open(path),
    acquire: (fd: number): number => library.symbols.buck2_publication_owner_lock(fd, 2 | 4),
    monotonicSeconds: (): number => {
      // Python uses mach_absolute_time on Darwin (CLOCK_UPTIME_RAW = 8),
      // and CLOCK_MONOTONIC = 1 on Linux. Darwin CLOCK_MONOTONIC includes sleep.
      // Bun's process.hrtime() can have a process-relative origin, so cannot be used here.
      if (library.symbols.clock_gettime(process.platform === 'darwin' ? 8 : 1, timePointer) !== 0)
        throw new Error('Could not read Buck editor publication owner monotonic clock')
      return Number(time.readBigInt64LE(0)) + Number(time.readBigInt64LE(8)) / 1e9
    },
    close: (): void => library.close(),
  }
}

const openOwner = (root: string, lock: PublicationFlock): number => {
  const path = editorPublicationLockPath(root)
  mkdirSync(dirname(path), { recursive: true })
  // The fixed-arity C ABI opens atomically O_CLOEXEC. No owner is ever lent to a child.
  const fd = lock.open(path)
  if (fd < 0)
    throw new Error(
      `Could not open Buck editor publication owner (${getSystemErrorName(fd)}, errno ${-fd})`,
    )
  return fd
}

declare const ownerBrand: unique symbol
/** Process-local authority. Only acquisition can mint an owner; descriptors are never exposed. */
export type EditorPublicationOwner = { readonly [ownerBrand]: true }
type OwnerState = { readonly root: string; readonly fd: number; live: boolean }
const owners = new WeakMap<EditorPublicationOwner, OwnerState>()

const validateOwner = (root: string, state: OwnerState): void => {
  if (state.live === false) throw new Error('Buck editor publication owner has been released')
  if (realpathSync(root) !== state.root)
    throw new Error('Buck editor publication owner belongs to a different root')
  const actual = fstatSync(state.fd)
  const expected = lstatSync(editorPublicationLockPath(root))
  if (
    actual.isFile() === false ||
    expected.isFile() === false ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.nlink !== 1 ||
    expected.nlink !== 1
  )
    throw new Error('Buck editor publication owner names a different lock inode')
}

/** Validate existing in-process authority without opening, acquiring, upgrading or unlocking. */
export const requireEditorPublicationOwner = ({
  root,
  owner,
}: {
  readonly root: string
  readonly owner?: EditorPublicationOwner
}): EditorPublicationOwner => {
  const state = owner === undefined ? undefined : owners.get(owner)
  if (state === undefined)
    throw new Error('Buck editor publication requires a live in-process publication owner')
  validateOwner(root, state)
  return owner!
}

const mintOwner = (root: string, fd: number, lock: PublicationFlock): EditorPublicationOwner => {
  const state: OwnerState = { root: realpathSync(root), fd, live: true }
  validateOwner(root, state)
  // Diagnostic only: admission_dump reads at most 1024 bytes of this historical schema.
  // Use the system monotonic clock shared with Python, not a process-relative runtime clock.
  // Write only after exclusive acquisition and inode validation; contents never mint authority.
  const metadata = JSON.stringify({
    pid: process.pid,
    command: basename(process.execPath).slice(0, 80),
    started: lock.monotonicSeconds(),
  })
  ftruncateSync(fd, 0)
  writeFileSync(fd, `${metadata}\n`, 'utf8')
  const owner = Object.freeze(Object.create(null)) as EditorPublicationOwner
  owners.set(owner, state)
  return owner
}

/** Release only this process's acquired lease. Repeated releases have no effect. */
export const releaseEditorPublicationOwner = (owner: EditorPublicationOwner): void => {
  const state = owners.get(owner)
  if (state === undefined) throw new Error('Invalid Buck editor publication owner')
  if (state.live === false) return
  state.live = false
  closeSync(state.fd)
}

/** Hold ownership until the callback has joined every subordinate build/read/publication operation. */
export const withEditorPublicationOwner = async <TResult>({
  root,
  signal,
  run,
}: {
  readonly root: string
  readonly signal?: AbortSignal
  readonly run: (owner: EditorPublicationOwner) => Promise<TResult>
}): Promise<TResult> => {
  signal?.throwIfAborted()
  const lock = openFlock()
  let fd: number | undefined
  let owner: EditorPublicationOwner | undefined
  try {
    fd = openOwner(root, lock)
    for (;;) {
      signal?.throwIfAborted()
      const error = lock.acquire(fd)
      if (error === 0) break
      // EAGAIN/EWOULDBLOCK are 11 on Linux and 35 on Darwin. Other failures are not contention.
      if (error !== 11 && error !== 35)
        throw new Error(`Could not acquire Buck editor publication owner (errno ${error})`)
      // eslint-disable-next-line no-await-in-loop -- Wait for this specific owner, not another job.
      await setTimeout(50, undefined, { signal })
    }
    owner = mintOwner(root, fd, lock)
    signal?.throwIfAborted()
    return await run(owner)
  } finally {
    try {
      if (owner !== undefined) releaseEditorPublicationOwner(owner)
      else if (fd !== undefined) closeSync(fd)
    } finally {
      lock.close()
    }
  }
}

/** Maintenance defers rather than waiting behind a publisher. */
export const tryAcquireEditorPublicationOwner = ({
  root,
}: {
  readonly root: string
}): EditorPublicationOwner | undefined => {
  const lock = openFlock()
  let fd: number | undefined
  let owner: EditorPublicationOwner | undefined
  try {
    fd = openOwner(root, lock)
    const error = lock.acquire(fd)
    if (error === 11 || error === 35) return undefined
    if (error !== 0)
      throw new Error(`Could not acquire Buck editor publication owner (errno ${error})`)
    owner = mintOwner(root, fd, lock)
    return owner
  } finally {
    try {
      if (owner === undefined && fd !== undefined) closeSync(fd)
    } finally {
      lock.close()
    }
  }
}
