import { dlopen } from 'bun:ffi'
import { expect, it } from 'bun:test'
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  editorPublicationIsolation,
  editorPublicationLockPath,
  editorPublicationOwnerFdEnv,
  requireEditorPublicationOwner,
  tryAcquireEditorPublicationOwner,
  withEditorPublicationOwner,
} from './editor-publication-owner.ts'

const native = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: ['i32', 'i32'], returns: 'i32' },
  fcntl: { args: ['i32', 'i32', 'i32'], returns: 'i32' },
})
const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-publication-owner-')))
  try {
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const canAcquire = (root: string): boolean => {
  const fd = openSync(editorPublicationLockPath(root), 'r+')
  try {
    return native.symbols.flock(fd, 2 | 4) === 0
  } finally {
    closeSync(fd)
  }
}

it('rejects absent, malformed, closed, wrong-inode, unlocked and shared-lock descriptors', () =>
  withRoot(async (root) => {
    const lock = editorPublicationLockPath(root)
    expect(editorPublicationIsolation).toBe('editor-publication')
    expect(lock).toBe(join(root, '.devenv/editor-view-publication.lock'))
    mkdirSync(dirname(lock), { recursive: true })
    const fd = openSync(lock, 'a+')
    const other = openSync(join(root, 'other-lock'), 'a+')
    const env = (value: string) => ({ [editorPublicationOwnerFdEnv]: value })
    try {
      for (const value of ['', '-1', 'true', '3oops', '1.5', '999999999'])
        expect(() => requireEditorPublicationOwner({ root, env: env(value) })).toThrow()
      expect(() => requireEditorPublicationOwner({ root, env: {} })).toThrow()
      expect(() => requireEditorPublicationOwner({ root, env: env(String(fd)) })).toThrow()
      expect(canAcquire(root)).toBe(true)
      expect(native.symbols.flock(other, 2 | 4)).toBe(0)
      expect(() => requireEditorPublicationOwner({ root, env: env(String(other)) })).toThrow()
      const rival = openSync(lock, 'r+')
      try {
        expect(native.symbols.flock(rival, 2 | 4)).toBe(0)
        expect(() => requireEditorPublicationOwner({ root, env: env(String(fd)) })).toThrow()
      } finally {
        closeSync(rival)
      }
      expect(native.symbols.flock(fd, 1 | 4)).toBe(0)
      expect(() => requireEditorPublicationOwner({ root, env: env(String(fd)) })).toThrow()
      expect(native.symbols.flock(fd, 2 | 4)).toBe(0)
      expect(requireEditorPublicationOwner({ root, env: env(String(fd)) })).toBe(fd)
      expect(native.symbols.fcntl(fd, 1, 0) & 1).toBe(1)
    } finally {
      closeSync(other)
      closeSync(fd)
    }
    expect(() => requireEditorPublicationOwner({ root, env: env(String(fd)) })).toThrow()
  }))

it('holds the persistent inode through the whole callback and releases on failure', () =>
  withRoot(async (root) => {
    let inode: number | undefined
    await expect(withEditorPublicationOwner({ root, run: async (fd) => {
      inode = statSync(editorPublicationLockPath(root)).ino
      expect(requireEditorPublicationOwner({ root, env: { [editorPublicationOwnerFdEnv]: String(fd) } })).toBe(fd)
      expect(canAcquire(root)).toBe(false)
      expect(tryAcquireEditorPublicationOwner({ root })).toBeUndefined()
      throw new Error('publication failed')
    } })).rejects.toThrow('publication failed')
    expect(canAcquire(root)).toBe(true)
    await withEditorPublicationOwner({ root, run: async () => {
      expect(statSync(editorPublicationLockPath(root)).ino).toBe(inode)
      expect(canAcquire(root)).toBe(false)
    } })
    expect(canAcquire(root)).toBe(true)
    const owner = tryAcquireEditorPublicationOwner({ root })
    expect(owner).toBeDefined()
    expect(canAcquire(root)).toBe(false)
    owner!.release()
    owner!.release()
    expect(canAcquire(root)).toBe(true)
    rmSync(join(root, '.devenv'), { recursive: true })
    const foreign = join(root, 'foreign-control')
    mkdirSync(foreign)
    symlinkSync(foreign, join(root, '.devenv'))
    expect(() => tryAcquireEditorPublicationOwner({ root })).toThrow('canonical control directory')
  }))

