import { dlopen } from 'bun:ffi'
import { expect, it } from 'bun:test'
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type EditorPublicationOwner,
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
  buck2_publication_owner_lock: { args: ['i32', 'i32'], returns: 'i32' },
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
    return native.symbols.buck2_publication_owner_lock(fd, 2 | 4) === 0
  } finally {
    closeSync(fd)
  }
}

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
