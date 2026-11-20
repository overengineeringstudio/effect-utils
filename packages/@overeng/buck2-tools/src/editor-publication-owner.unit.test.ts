import { dlopen } from 'bun:ffi'
import { expect, it } from 'bun:test'
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  type EditorPublicationOwner,
  editorPublicationIsolation,
  editorPublicationLockPath,
  releaseEditorPublicationOwner,
  requireEditorPublicationOwner,
  tryAcquireEditorPublicationOwner,
  withEditorPublicationOwner,
} from './editor-publication-owner.ts'

const ownerLibrary = process.env.BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY
if (ownerLibrary === undefined || ownerLibrary.length === 0)
  throw new Error('Owner regression requires BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY')
const native = dlopen(ownerLibrary, {
  buck2_publication_owner_open: { args: ['cstring'], returns: 'i32' },
  buck2_publication_owner_lock: { args: ['i32', 'i32'], returns: 'i32' },
  buck2_publication_owner_fd_flags: { args: ['i32'], returns: 'i32' },
})
const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-publication-owner-')))
  try {
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const canAcquire = (root: string, mode = 2): boolean => {
  const fd = openSync(editorPublicationLockPath(root), 'r+')
  try {
    return native.symbols.buck2_publication_owner_lock(fd, mode | 4) === 0
  } finally {
    closeSync(fd)
  }
}
// Observe real descriptors solely to verify native CLOEXEC and externally closed-inode safety.
// Production never exposes this descriptor, nor accepts one as authority.
const findOwnerFd = (root: string): number => {
  const expected = statSync(editorPublicationLockPath(root))
  for (const entry of readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')) {
    const fd = Number(entry)
    try {
      const observed = fstatSync(fd)
      if (observed.dev === expected.dev && observed.ino === expected.ino) return fd
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error
    }
  }
  throw new Error('Acquired publication owner descriptor was not found')
}

it('rejects absent, foreign, unowned, shared, exclusive and closed numeric capabilities without mutation', () =>
  withRoot(async (root) => {
    const path = editorPublicationLockPath(root)
    expect(editorPublicationIsolation).toBe('editor-publication')
    expect(path).toBe(join(root, '.devenv/editor-view-publication.lock'))
    mkdirSync(dirname(path), { recursive: true })
    const fd = openSync(path, 'a+')
    const other = openSync(join(root, 'other-lock'), 'a+')
    const reject = (value: unknown): void => {
      expect(() => requireEditorPublicationOwner({ root, owner: value as EditorPublicationOwner })).toThrow(
        'live in-process publication owner',
      )
    }
    try {
      expect(() => requireEditorPublicationOwner({ root })).toThrow('live in-process publication owner')
      for (const value of [null, {}, { fd }, { fd: other }, fd, String(fd), -1, 999999999]) reject(value)
      expect(canAcquire(root)).toBe(true)
      expect(native.symbols.buck2_publication_owner_lock(other, 2 | 4)).toBe(0)
      reject({ fd: other })
      expect(native.symbols.buck2_publication_owner_lock(fd, 1 | 4)).toBe(0)
      reject({ fd })
      // Requiring a forged shared owner neither upgrades nor unlocks it.
      expect(canAcquire(root, 1)).toBe(true)
      expect(canAcquire(root)).toBe(false)
      expect(native.symbols.buck2_publication_owner_lock(fd, 2 | 4)).toBe(0)
      reject({ fd })
      expect(canAcquire(root, 1)).toBe(false)
    } finally {
      closeSync(other)
      closeSync(fd)
    }
    reject({ fd })
    expect(canAcquire(root)).toBe(true)
  }))

it('holds the persistent inode through callback failure and releases maintenance idempotently', () =>
  withRoot(async (root) => {
    let inode: number | undefined
    let expired: EditorPublicationOwner | undefined
    await expect(
      withEditorPublicationOwner({
        root,
        run: async (owner) => {
          expired = owner
          inode = statSync(editorPublicationLockPath(root)).ino
          expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
          expect(Reflect.ownKeys(owner)).toEqual([])
          expect(Object.isFrozen(owner)).toBe(true)
          expect(() => requireEditorPublicationOwner({ root, owner: { ...owner } })).toThrow(
            'live in-process publication owner',
          )
          expect(() => releaseEditorPublicationOwner({ ...owner })).toThrow('Invalid')
          expect(canAcquire(root)).toBe(false)
          expect(tryAcquireEditorPublicationOwner({ root })).toBeUndefined()
          throw new Error('publication failed')
        },
      }),
    ).rejects.toThrow('publication failed')
    expect(() => requireEditorPublicationOwner({ root, owner: expired })).toThrow('released')
    expect(canAcquire(root)).toBe(true)
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        expect(statSync(editorPublicationLockPath(root)).ino).toBe(inode)
        expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
        expect(canAcquire(root)).toBe(false)
      },
    })
    const owner = tryAcquireEditorPublicationOwner({ root })
    expect(owner).toBeDefined()
    expect(requireEditorPublicationOwner({ root, owner })).toBe(owner!)
    expect(canAcquire(root)).toBe(false)
    releaseEditorPublicationOwner(owner!)
    const next = tryAcquireEditorPublicationOwner({ root })
    expect(next).toBeDefined()
    // A second release must not close a descriptor reused by the next owner.
    releaseEditorPublicationOwner(owner!)
    expect(canAcquire(root)).toBe(false)
    expect(() => requireEditorPublicationOwner({ root, owner })).toThrow('released')
    releaseEditorPublicationOwner(next!)
    expect(canAcquire(root)).toBe(true)
  }))

it('canonicalizes root aliases but rejects foreign roots and aliased control directories', () =>
  withRoot(async (root) => {
    const actual = join(root, 'actual')
    const other = join(root, 'other')
    const alias = join(root, 'alias')
    mkdirSync(actual)
    mkdirSync(other)
    symlinkSync(actual, alias)
    await withEditorPublicationOwner({
      root: alias,
      run: async (owner) => {
        expect(requireEditorPublicationOwner({ root: actual, owner })).toBe(owner)
        expect(requireEditorPublicationOwner({ root: alias, owner })).toBe(owner)
        expect(() => requireEditorPublicationOwner({ root: other, owner })).toThrow('different root')
        rmSync(alias)
        symlinkSync(other, alias)
        expect(() => requireEditorPublicationOwner({ root: alias, owner })).toThrow('different root')
        expect(canAcquire(actual)).toBe(false)
      },
    })
    symlinkSync(join(actual, '.devenv'), join(other, '.devenv'))
    expect(() => tryAcquireEditorPublicationOwner({ root: other })).toThrow('canonical control directory')
  }))

it('rejects replaced, hardlinked and symlinked owner inodes without releasing ownership', () =>
  withRoot(async (root) => {
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        const path = editorPublicationLockPath(root)
        const saved = join(root, 'original-lock')
        linkSync(path, saved)
        expect(() => requireEditorPublicationOwner({ root, owner })).toThrow('different lock inode')
        rmSync(saved)
        expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
        renameSync(path, saved)
        const replacement = openSync(path, 'a+')
        closeSync(replacement)
        expect(() => requireEditorPublicationOwner({ root, owner })).toThrow('different lock inode')
        rmSync(path)
        symlinkSync(saved, path)
        expect(() => requireEditorPublicationOwner({ root, owner })).toThrow('different lock inode')
        rmSync(path)
        renameSync(saved, path)
        expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
        expect(canAcquire(root)).toBe(false)
      },
    })
  }))

it('rejects a live token whose underlying descriptor was externally closed', () =>
  withRoot(async (root) => {
    const owner = tryAcquireEditorPublicationOwner({ root })!
    closeSync(findOwnerFd(root))
    expect(() => requireEditorPublicationOwner({ root, owner })).toThrow('EBADF')
    expect(() => releaseEditorPublicationOwner(owner)).toThrow('EBADF')
    releaseEditorPublicationOwner(owner)
    expect(() => requireEditorPublicationOwner({ root, owner })).toThrow('released')
    expect(canAcquire(root)).toBe(true)
  }))

it('opens atomically close-on-exec and preserves that flag throughout the whole callback', () =>
  withRoot(async (root) => {
    const path = editorPublicationLockPath(root)
    mkdirSync(dirname(path), { recursive: true })
    const fd = native.symbols.buck2_publication_owner_open(path)
    expect(fd).toBeGreaterThanOrEqual(0)
    try {
      expect(native.symbols.buck2_publication_owner_fd_flags(fd)).toBe(1)
    } finally {
      closeSync(fd)
    }
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        const ownedFd = findOwnerFd(root)
        expect(native.symbols.buck2_publication_owner_fd_flags(ownedFd)).toBe(1)
        expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
        await Promise.resolve()
        expect(native.symbols.buck2_publication_owner_fd_flags(ownedFd)).toBe(1)
        expect(canAcquire(root)).toBe(false)
      },
    })
    expect(canAcquire(root)).toBe(true)
  }))

it('preserves symbolic and numeric EISDIR diagnostics at the fixed-C open boundary', () =>
  withRoot(async (root) => {
    mkdirSync(editorPublicationLockPath(root), { recursive: true })
    expect(() => tryAcquireEditorPublicationOwner({ root })).toThrow(
      'Could not open Buck editor publication owner (EISDIR, errno 21)',
    )
    await expect(withEditorPublicationOwner({ root, run: async () => undefined })).rejects.toThrow(
      'Could not open Buck editor publication owner (EISDIR, errno 21)',
    )
  }))

it('aborts a contending waiter without entering its callback or releasing the current owner', () =>
  withRoot(async (root) => {
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        const controller = new AbortController()
        let entered = false
        // Acquisition runs synchronously through its first real contention before returning.
        const waiting = withEditorPublicationOwner({
          root,
          signal: controller.signal,
          run: async () => { entered = true },
        })
        const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
        controller.abort()
        await rejected
        expect(entered).toBe(false)
        expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
        expect(canAcquire(root)).toBe(false)
        expect(tryAcquireEditorPublicationOwner({ root })).toBeUndefined()
      },
    })
    expect(canAcquire(root)).toBe(true)
  }))

it('does not acquire for an already aborted signal or release an active callback before it joins', () =>
  withRoot(async (root) => {
    const before = new AbortController()
    const reason = new Error('cancelled before acquisition')
    before.abort(reason)
    let entered = false
    await expect(withEditorPublicationOwner({
      root,
      signal: before.signal,
      run: async () => { entered = true },
    })).rejects.toBe(reason)
    expect(entered).toBe(false)
    expect(() => statSync(editorPublicationLockPath(root))).toThrow('ENOENT')

    const controller = new AbortController()
    const ready = Promise.withResolvers<void>()
    const joined = Promise.withResolvers<void>()
    const active = withEditorPublicationOwner({
      root,
      signal: controller.signal,
      run: async (owner) => {
        ready.resolve()
        await joined.promise
        expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
        return 'joined'
      },
    })
    try {
      await ready.promise
      controller.abort()
      expect(canAcquire(root)).toBe(false)
    } finally {
      joined.resolve()
      await active
    }
    expect(await active).toBe('joined')
    expect(canAcquire(root)).toBe(true)
  }))
