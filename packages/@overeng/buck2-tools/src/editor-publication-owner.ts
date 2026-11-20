import type * as NativeFfi from 'bun:ffi'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

/** Stable across invocations: publication owns a separate materializer and DICE graph. */
export const editorPublicationIsolation = 'editor-publication'
export const editorPublicationOwnerFdEnv = 'BUCK2_EDITOR_PUBLICATION_OWNER_FD'
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

const openOwner = (root: string, lock: PublicationFlock): number => {
  const path = editorPublicationLockPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const fd = lock.open(path)
  if (fd < 0)
    throw new Error(`Could not open Buck editor publication owner (errno ${-fd})`)
  return fd
}

// Read-only Node consumers can import buck2-tools; native locking itself requires Bun.
let ffi: typeof NativeFfi | undefined

type PublicationFlock = {
  readonly open: (path: string) => number
  readonly acquire: (fd: number, mode?: number) => number
  readonly closeOnExec: (fd: number) => void
  readonly close: () => void
}

const openFlock = (): PublicationFlock => {
  const path = process.env.BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY
  if (path === undefined || path.length === 0)
    throw new Error('Buck editor publication requires BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY')
  ffi ??= createRequire(import.meta.url)('bun:ffi') as typeof NativeFfi
  const { dlopen } = ffi
  const library = (() => {
    try {
      return dlopen(path, {
        buck2_publication_owner_open: { args: ['cstring'], returns: 'i32' },
        buck2_publication_owner_lock: { args: ['i32', 'i32'], returns: 'i32' },
        buck2_publication_owner_cloexec: { args: ['i32', 'i32'], returns: 'i32' },
      })
    } catch (cause) {
      throw new Error(`Could not load Buck editor publication owner library: ${path}`, { cause })
    }
  })()
  return {
    open: (path: string): number => library.symbols.buck2_publication_owner_open(path),
    acquire: (fd: number, mode = 2): number =>
      library.symbols.buck2_publication_owner_lock(fd, mode | 4),
    closeOnExec: (fd: number): void => {
      const error = library.symbols.buck2_publication_owner_cloexec(fd, 1)
      if (error !== 0)
        throw new Error(
          `Could not protect Buck publication owner from native daemon inheritance (errno ${error})`,
        )
    },
    close: (): void => library.close(),
  }
}

/** A descriptor is a capability only when it names and really locks this root's owner inode. */
const validateOwner = ({
  root,
  env,
  lock,
}: {
  readonly root: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly lock: PublicationFlock
}): number => {
  const value = env[editorPublicationOwnerFdEnv]
  if (value === undefined || /^[3-9][0-9]*$|^[1-9][0-9]+$/u.test(value) === false)
    throw new Error('Buck editor publication requires an inherited publication-owner descriptor')
  const fd = Number(value)
  if (Number.isSafeInteger(fd) === false)
    throw new Error('Invalid Buck editor publication owner descriptor')
  const actual = fstatSync(fd)
  const expected = lstatSync(editorPublicationLockPath(root))
  if (
    actual.isFile() === false ||
    expected.isFile() === false ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.nlink !== 1
  )
    throw new Error('Buck editor publication owner descriptor names a different lock inode')
  const probe = openSync(
    editorPublicationLockPath(root),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const observed = fstatSync(probe)
    if (observed.dev !== actual.dev || observed.ino !== actual.ino || observed.nlink !== 1)
      throw new Error('Buck editor publication owner inode changed during validation')
    const contention = lock.acquire(probe, 1)
    if (contention !== 11 && contention !== 35)
      throw new Error('Buck editor publication requires a pre-existing exclusive owner')
    if (lock.acquire(fd) !== 0)
      throw new Error('Buck editor publication owner descriptor does not own the exclusive lock')
    lock.closeOnExec(fd)
  } finally {
    // Never unlock a borrowed open-file description: the supervisor and its children share it.
    closeSync(probe)
  }
  return fd
}

export const requireEditorPublicationOwner = ({
  root,
  env = process.env,
}: {
  readonly root: string
  readonly env?: Readonly<Record<string, string | undefined>>
}): number => {
  const lock = openFlock()
  try {
    return validateOwner({ root, env, lock })
  } finally {
    lock.close()
  }
}

/** Own the complete build/read/publication flow, not just a publisher's final snapshot. */
export const withEditorPublicationOwner = async <TResult>({
  root,
  run,
}: {
  readonly root: string
  readonly run: (fd: number) => Promise<TResult>
}): Promise<TResult> => {
  if (process.env[editorPublicationOwnerFdEnv] !== undefined)
    return run(requireEditorPublicationOwner({ root }))
  const lock = openFlock()
  let fd: number | undefined
  try {
    fd = openOwner(root, lock)
    for (;;) {
      const error = lock.acquire(fd)
      if (error === 0) break
      // EAGAIN/EWOULDBLOCK are 11 on Linux and 35 on Darwin. Other failures are not contention.
      if (error !== 11 && error !== 35)
        throw new Error(`Could not acquire Buck editor publication owner (errno ${error})`)
      // eslint-disable-next-line no-await-in-loop -- Wait for this specific owner, not another job.
      await setTimeout(50)
    }
    validateOwner({ root, env: { [editorPublicationOwnerFdEnv]: String(fd) }, lock })
    return await run(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
    lock.close()
  }
}

/** An independently acquired maintenance lease; closing it never unlocks a borrowed owner. */
export type EditorPublicationOwner = {
  readonly fd: number
  readonly release: () => void
}

/** Maintenance defers rather than waiting behind a publisher, including an inherited owner. */
export const tryAcquireEditorPublicationOwner = ({
  root,
}: {
  readonly root: string
}): EditorPublicationOwner | undefined => {
  const lock = openFlock()
  let fd: number | undefined
  let owned = false
  try {
    const ownerFd = openOwner(root, lock)
    fd = ownerFd
    const error = lock.acquire(ownerFd)
    if (error === 11 || error === 35) return undefined
    if (error !== 0)
      throw new Error(`Could not acquire Buck editor publication owner (errno ${error})`)
    validateOwner({ root, env: { [editorPublicationOwnerFdEnv]: String(ownerFd) }, lock })
    owned = true
    return {
      fd: ownerFd,
      release: (): void => {
        if (owned === false) return
        owned = false
        closeSync(ownerFd)
      },
    }
  } finally {
    if (owned === false && fd !== undefined) closeSync(fd)
    lock.close()
  }
}
