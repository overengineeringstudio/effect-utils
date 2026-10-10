import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { shareSnapshotFiles } from './editor-view-sharing.ts'

const withTrees = async (
  run: (trees: { root: string; older: string; candidate: string }) => Promise<void>,
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'editor-view-sharing-'))
  const older = join(root, 'older')
  const candidate = join(root, 'candidate')
  mkdirSync(older)
  mkdirSync(candidate)
  try {
    await run({ root, older, candidate })
  } finally {
    // Directory permissions, not payload permissions, govern unlinking hardlinks.
    if (lstatExists(older)) chmodSync(older, 0o755)
    if (lstatExists(candidate)) chmodSync(candidate, 0o755)
    rmSync(root, { recursive: true, force: true })
  }
}

const lstatExists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

const payload = (directory: string, name: string, bytes: string, mode: number): string => {
  const path = join(directory, name)
  writeFileSync(path, bytes)
  chmodSync(path, mode)
  return path
}

const inode = (path: string): string => {
  const status = lstatSync(path, { bigint: true })
  return `${status.dev}:${status.ino}`
}

const harden = (older: string): void => chmodSync(older, 0o555)

describe('snapshot payload sharing', () => {
  it('shares identical bytes across names and keeps metadata on independent inodes', async () => {
    await withTrees(async ({ older, candidate }) => {
      const original = payload(older, 'original.js', 'same payload', 0o444)
      const first = payload(candidate, 'renamed.js', 'same payload', 0o644)
      const second = payload(candidate, 'another.js', 'same payload', 0o644)
      const oldMetadata = payload(older, 'editor-view.json', '{}', 0o444)
      const metadata = payload(candidate, 'editor-view.json', '{}', 0o644)
      harden(older)
      await shareSnapshotFiles({ candidate, snapshots: [older] })
      expect(inode(first)).toBe(inode(original))
      expect(inode(second)).toBe(inode(original))
      expect(lstatSync(original).nlink).toBe(3)
      expect(inode(metadata)).not.toBe(inode(oldMetadata))
      expect(lstatSync(original).mode & 0o777).toBe(0o444)
    })
  })

  it('does not share changed bytes, execute modes, or read modes', async () => {
    await withTrees(async ({ older, candidate }) => {
      const original = payload(older, 'original', 'original', 0o444)
      const changed = payload(candidate, 'changed', 'different', 0o644)
      const executable = payload(candidate, 'executable', 'original', 0o755)
      const privateRead = payload(candidate, 'private', 'original', 0o600)
      harden(older)
      await shareSnapshotFiles({ candidate, snapshots: [older] })
      for (const path of [changed, executable, privateRead]) {
        expect(inode(path)).not.toBe(inode(original))
      }
      expect(readFileSync(changed, 'utf8')).toBe('different')
      expect(lstatSync(executable).mode & 0o777).toBe(0o755)
      expect(lstatSync(privateRead).mode & 0o777).toBe(0o600)
    })
  })

  it('leaves file and directory symlinks unchanged without linking external sources', async () => {
    await withTrees(async ({ root, older, candidate }) => {
      const external = join(root, 'external')
      mkdirSync(external)
      const externalFile = payload(external, 'payload', 'external bytes', 0o644)
      const externalBefore = lstatSync(externalFile, { bigint: true })
      symlinkSync(externalFile, join(older, 'file-link'))
      symlinkSync(external, join(older, 'directory-link'))
      const independent = join(candidate, 'payload')
      copyFileSync(externalFile, independent)
      symlinkSync(externalFile, join(candidate, 'file-link'))
      symlinkSync(external, join(candidate, 'directory-link'))
      const fileLinkInode = inode(join(candidate, 'file-link'))
      const directoryLinkInode = inode(join(candidate, 'directory-link'))
      harden(older)
      await shareSnapshotFiles({ candidate, snapshots: [older] })
      expect(inode(independent)).not.toBe(inode(externalFile))
      expect(inode(join(candidate, 'file-link'))).toBe(fileLinkInode)
      expect(inode(join(candidate, 'directory-link'))).toBe(directoryLinkInode)
      expect(readlinkSync(join(candidate, 'file-link'))).toBe(externalFile)
      expect(readlinkSync(join(candidate, 'directory-link'))).toBe(external)
      const externalAfter = lstatSync(externalFile, { bigint: true })
      expect(externalAfter.ino).toBe(externalBefore.ino)
      expect(externalAfter.nlink).toBe(externalBefore.nlink)
      expect(externalAfter.mode).toBe(externalBefore.mode)
      expect(externalAfter.ctimeNs).toBe(externalBefore.ctimeNs)
    })
  })

  it('keeps shared payload readonly and alive when either generation is deleted', async () => {
    await withTrees(async ({ root, older, candidate }) => {
      const original = payload(older, 'payload', 'survives', 0o555)
      const shared = payload(candidate, 'payload', 'survives', 0o755)
      harden(older)
      await shareSnapshotFiles({ candidate, snapshots: [older] })
      expect(inode(shared)).toBe(inode(original))
      expect(lstatSync(original).mode & 0o777).toBe(0o555)
      const next = join(root, 'next')
      mkdirSync(next)
      const nextFile = payload(next, 'payload', 'survives', 0o755)
      chmodSync(candidate, 0o555)
      await shareSnapshotFiles({ candidate: next, snapshots: [candidate] })
      expect(inode(nextFile)).toBe(inode(original))
      rmSync(next, { recursive: true })
      expect(lstatSync(original).mode & 0o777).toBe(0o555)
      chmodSync(older, 0o755)
      rmSync(older, { recursive: true })
      expect(readFileSync(shared, 'utf8')).toBe('survives')
      expect(lstatSync(shared).mode & 0o777).toBe(0o555)
      expect(lstatSync(shared).nlink).toBe(1)
      chmodSync(candidate, 0o755)
    })
  })

  it('shares nested payload files named editor-view.json', async () => {
    await withTrees(async ({ older, candidate }) => {
      const oldDependency = join(older, 'dependency')
      const newDependency = join(candidate, 'dependency')
      mkdirSync(oldDependency)
      mkdirSync(newDependency)
      const original = payload(oldDependency, 'editor-view.json', '{"dependency":true}', 0o444)
      const shared = payload(newDependency, 'editor-view.json', '{"dependency":true}', 0o644)
      harden(older)
      await shareSnapshotFiles({ candidate, snapshots: [older] })
      expect(inode(shared)).toBe(inode(original))
    })
  })

  it('leaves a first-generation candidate untouched when no prior snapshots exist', async () => {
    await withTrees(async ({ candidate }) => {
      const file = payload(candidate, 'payload', 'first generation', 0o644)
      const before = lstatSync(file, { bigint: true })
      await shareSnapshotFiles({ candidate, snapshots: [] })
      const after = lstatSync(file, { bigint: true })
      expect(after.ino).toBe(before.ino)
      expect(after.mode).toBe(before.mode)
      expect(after.ctimeNs).toBe(before.ctimeNs)
      expect(after.atimeNs).toBe(before.atimeNs)
    })
  })

  it('fails closed for a writable prior payload or symlink snapshot root', async () => {
    await withTrees(async ({ root, older, candidate }) => {
      payload(older, 'payload', 'same', 0o644)
      const unchanged = payload(candidate, 'payload', 'same', 0o644)
      const before = inode(unchanged)
      await expect(shareSnapshotFiles({ candidate, snapshots: [older] })).rejects.toThrow(
        'prior snapshot payload is writable',
      )
      expect(inode(unchanged)).toBe(before)
      const alias = join(root, 'alias')
      symlinkSync(older, alias)
      await expect(shareSnapshotFiles({ candidate, snapshots: [alias] })).rejects.toThrow(
        'snapshot is not a directory',
      )
    })
  })
})
