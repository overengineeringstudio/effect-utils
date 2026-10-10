import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  type BigIntStats,
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  type EditorViewContentSharing,
  collectEditorViewContentStore,
  defaultEditorViewContentStore,
  recoverEditorViewContentStoreLock,
  shareSnapshotFiles,
} from './editor-view-sharing.ts'

const exists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

const removeOwnedTree = (root: string): void => {
  if (exists(root) === false) return
  const unlockDirectories = (path: string): void => {
    const status = lstatSync(path)
    if (status.isDirectory() === false) return
    // Unlinking needs writable directories, never chmod shared payload inodes.
    chmodSync(path, (status.mode & 0o777) | 0o700)
    for (const name of readdirSync(path)) unlockDirectories(join(path, name))
  }
  unlockDirectories(root)
  rmSync(root, { recursive: true, force: true })
}

type Fixture = {
  readonly root: string
  readonly contentStore: string
  readonly candidate: (...parts: readonly string[]) => string
}

const withStore = async (run: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-view-content-store-')))
  const contentStore = join(root, 'shared-content', 'v1')
  const candidate = (...parts: readonly string[]): string => {
    const directory = join(root, ...parts)
    mkdirSync(directory, { recursive: true })
    return directory
  }
  try {
    await run({ root, contentStore, candidate })
  } finally {
    removeOwnedTree(root)
  }
}

const payload = (directory: string, name: string, bytes: string, mode = 0o644): string => {
  const path = join(directory, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  chmodSync(path, mode)
  return path
}

const inode = (path: string): string => {
  const status = lstatSync(path, { bigint: true })
  return `${status.dev}:${status.ino}`
}

const mode = (path: string): number => lstatSync(path).mode & 0o7777

const blobPath = (contentStore: string, bytes: string, executable = false): string => {
  const digest = createHash('sha256').update(bytes).digest('hex')
  return join(
    contentStore,
    digest.slice(0, 2),
    `${digest}-${executable === true ? '0555' : '0444'}`,
  )
}

const regularFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory() === true) return regularFiles(path)
    return entry.isFile() === true ? [path] : []
  })

const expectReadonlyDirectories = (directory: string): void => {
  expect(lstatSync(directory).isDirectory() === true).toBe(true)
  // Inspect permission bits: root/CAP_DAC_OVERRIDE runners can bypass EACCES.
  expect(mode(directory)).toBe(0o555)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() === true) expectReadonlyDirectories(join(directory, entry.name))
  }
}

const expectReadonlyStore = (contentStore: string): void => {
  expectReadonlyDirectories(contentStore)
  for (const file of regularFiles(contentStore)) {
    expect(relative(contentStore, file)).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{64}-(0444|0555)$/)
    expect(mode(file)).toBe(file.endsWith('-0555') === true ? 0o555 : 0o444)
  }
}

const expectNoLock = (contentStore: string): void => {
  const prefix = `${basename(contentStore)}.lock`
  expect(
    readdirSync(dirname(contentStore)).filter(
      (name) => name === prefix || name.startsWith(`${prefix}.`) === true,
    ),
  ).toEqual([])
}

const withContentStoreEnv = (value: string | undefined, run: () => void): void => {
  const previous = process.env.EDITOR_VIEW_CONTENT_STORE
  if (value === undefined) delete process.env.EDITOR_VIEW_CONTENT_STORE
  else process.env.EDITOR_VIEW_CONTENT_STORE = value
  try {
    run()
  } finally {
    if (previous === undefined) delete process.env.EDITOR_VIEW_CONTENT_STORE
    else process.env.EDITOR_VIEW_CONTENT_STORE = previous
  }
}

type StoreLockObservation = {
  readonly entered: Promise<string>
  readonly close: () => void
}

/** A persistent contender temp is real evidence that another acquisition has started. */
const observeContender = (contentStore: string) => {
  const directory = dirname(contentStore)
  const previous = new Set(readdirSync(directory))
  const entered = Promise.withResolvers<string>()
  const scan = (): void => {
    try {
      const name = readdirSync(directory).find(
        (entry) =>
          previous.has(entry) === false &&
          entry.startsWith(`${basename(contentStore)}.lock.`) === true &&
          entry.endsWith('.tmp') === true,
      )
      if (name === undefined) return
      const path = join(directory, name)
      const status = lstatSync(path)
      if (status.isFile() === false || (status.mode & 0o7777) !== 0o444) return
      let owner: unknown
      try {
        owner = JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        // Creation can notify before the async owner-record write completes.
        if (error instanceof SyntaxError) return
        throw error
      }
      if (
        typeof owner === 'object' &&
        owner !== null &&
        'schema' in owner &&
        owner.schema === 'editor-view-content-store-lock/v1' &&
        'token' in owner &&
        typeof owner.token === 'string' &&
        'pid' in owner &&
        owner.pid === process.pid
      )
        entered.resolve(path)
    } catch (error) {
      entered.reject(error)
    }
  }
  const watcher = watch(directory, scan)
  watcher.on('error', entered.reject)
  scan()
  return { entered: entered.promise, close: () => watcher.close() }
}

const reachBarrier = async (
  barrier: Promise<unknown>,
  operation: Promise<unknown>,
): Promise<void> => {
  await Promise.race([
    barrier,
    operation.then(() => {
      throw new Error('operation completed before reaching its filesystem barrier')
    }),
  ])
}

const installBlob = (contentStore: string, bytes: string): string => {
  const path = blobPath(contentStore, bytes)
  const privateTemp = payload(dirname(contentStore), 'injected-blob', bytes, 0o444)
  chmodSync(contentStore, 0o755)
  try {
    mkdirSync(dirname(path), { recursive: true })
    chmodSync(dirname(path), 0o755)
    linkSync(privateTemp, path)
  } finally {
    if (exists(dirname(path)) === true) chmodSync(dirname(path), 0o555)
    chmodSync(contentStore, 0o555)
    unlinkSync(privateTemp)
  }
  return path
}

const maliciousKinds = ['writable', 'symlink', 'corrupted'] as const

const replaceBlob = (
  blob: string,
  kind: (typeof maliciousKinds)[number],
  externalFile: string,
): void => {
  // Fixtures retire all snapshot links before deliberately mutating a store entry.
  expect(lstatSync(blob).nlink).toBe(1)
  if (kind === 'writable') {
    chmodSync(blob, 0o644)
    return
  }
  chmodSync(dirname(blob), 0o755)
  try {
    unlinkSync(blob)
    if (kind === 'symlink') symlinkSync(externalFile, blob)
    else payload(dirname(blob), basename(blob), 'wrong payload', 0o444)
  } finally {
    chmodSync(dirname(blob), 0o555)
  }
}

describe('host-wide editor snapshot content store', () => {
  it('shares one readonly CAS inode across worktrees, state roots, views, and names', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const first = candidate('worktrees', 'one', 'state-a', 'views', 'alpha', 'candidate')
      const sibling = candidate('worktrees', 'one', 'state-b', 'views', 'beta', 'candidate')
      const otherWorktree = candidate('worktrees', 'two', 'state-c', 'views', 'alpha', 'candidate')
      const firstFile = payload(first, 'original.js', 'same payload')
      const renamed = payload(first, 'nested/renamed.js', 'same payload', 0o600)
      const siblingFile = payload(sibling, 'another.js', 'same payload')
      const otherFile = payload(otherWorktree, 'payload.js', 'same payload', 0o444)
      const firstResult = await shareSnapshotFiles({ candidate: first, contentStore })
      expect(firstResult).toEqual({
        linkedFiles: 2,
        copiedFiles: 0,
        copiedBytes: 0,
        createdBlobs: 1,
      })
      for (const directory of [sibling, otherWorktree]) {
        expect(await shareSnapshotFiles({ candidate: directory, contentStore })).toEqual({
          linkedFiles: 1,
          copiedFiles: 0,
          copiedBytes: 0,
          createdBlobs: 0,
        })
      }
      const blob = blobPath(contentStore, 'same payload')
      for (const path of [firstFile, renamed, siblingFile, otherFile]) {
        expect(inode(path)).toBe(inode(blob))
        expect(mode(path)).toBe(0o444)
      }
      expect(lstatSync(blob).nlink).toBe(5)
      expect(regularFiles(contentStore)).toEqual([blob])
      expectReadonlyStore(contentStore)
      expectNoLock(contentStore)
    })
  })

  it('addresses changed bytes separately and normalizes any source execute bit to 0555', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const directory = candidate('candidate')
      const data = payload(directory, 'data', 'original', 0o600)
      const alreadyReadonly = payload(directory, 'readonly', 'original', 0o444)
      const executableFiles = [0o700, 0o610, 0o601].map((sourceMode, index) =>
        payload(directory, `executable-${index}`, 'original', sourceMode),
      )
      const changed = payload(directory, 'changed', 'different')
      expect(await shareSnapshotFiles({ candidate: directory, contentStore })).toEqual({
        linkedFiles: 6,
        copiedFiles: 0,
        copiedBytes: 0,
        createdBlobs: 3,
      })
      const dataBlob = blobPath(contentStore, 'original')
      const executableBlob = blobPath(contentStore, 'original', true)
      expect(inode(data)).toBe(inode(dataBlob))
      expect(inode(alreadyReadonly)).toBe(inode(dataBlob))
      for (const path of executableFiles) {
        expect(inode(path)).toBe(inode(executableBlob))
        expect(mode(path)).toBe(0o555)
      }
      expect(inode(executableBlob)).not.toBe(inode(dataBlob))
      expect(inode(changed)).not.toBe(inode(dataBlob))
      expect(inode(changed)).not.toBe(inode(executableBlob))
      expect(readFileSync(changed, 'utf8')).toBe('different')
      expect(mode(data)).toBe(0o444)
      expect(regularFiles(contentStore)).toHaveLength(3)
      expectReadonlyStore(contentStore)
    })
  })

  it('keeps root editor-view.json private while sharing nested files with the same name', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const first = candidate('first')
      const second = candidate('second')
      const firstMetadata = payload(first, 'editor-view.json', '{}')
      const secondMetadata = payload(second, 'editor-view.json', '{}')
      const metadataInodes = [inode(firstMetadata), inode(secondMetadata)]
      const nestedFirst = payload(first, 'dependency/editor-view.json', '{}')
      const nestedSecond = payload(second, 'dependency/editor-view.json', '{}')
      for (const directory of [first, second])
        await shareSnapshotFiles({ candidate: directory, contentStore })
      expect([inode(firstMetadata), inode(secondMetadata)]).toEqual(metadataInodes)
      expect(inode(firstMetadata)).not.toBe(inode(secondMetadata))
      for (const metadata of [firstMetadata, secondMetadata]) {
        expect(lstatSync(metadata).nlink).toBe(1)
        expect(mode(metadata)).toBe(0o644)
        expect(inode(metadata)).not.toBe(inode(nestedFirst))
      }
      expect(inode(nestedFirst)).toBe(inode(nestedSecond))
      expect(inode(nestedFirst)).toBe(inode(blobPath(contentStore, '{}')))
      expect(mode(nestedFirst)).toBe(0o444)
      expect(regularFiles(contentStore)).toHaveLength(1)
      expectReadonlyStore(contentStore)
    })
  })

  it('prepares private readonly copied directories without changing shared file modes', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const directory = candidate('readonly-candidate')
      const file = payload(directory, 'dependency/payload', 'readonly copied bytes', 0o444)
      chmodSync(dirname(file), 0o555)
      chmodSync(directory, 0o555)
      expect(await shareSnapshotFiles({ candidate: directory, contentStore })).toEqual({
        linkedFiles: 1,
        copiedFiles: 0,
        copiedBytes: 0,
        createdBlobs: 1,
      })
      expect(inode(file)).toBe(inode(blobPath(contentStore, 'readonly copied bytes')))
      expect(mode(file)).toBe(0o444)
      expectReadonlyStore(contentStore)
    })
  })

  it('leaves symlinks and admitted/external source inodes, links, and permissions untouched', async () => {
    await withStore(async ({ root, contentStore, candidate }) => {
      const admitted = candidate('admitted')
      const external = candidate('external')
      const admittedFile = payload(admitted, 'payload', 'admitted bytes', 0o444)
      const externalFile = payload(external, 'payload', 'external bytes', 0o644)
      const sources = [admittedFile, externalFile]
      const before = sources.map((path) => lstatSync(path, { bigint: true }))
      const directory = candidate('worktree', 'candidate')
      const admittedCopy = join(directory, 'admitted-copy')
      const externalCopy = join(directory, 'external-copy')
      copyFileSync(admittedFile, admittedCopy)
      copyFileSync(externalFile, externalCopy)
      symlinkSync(externalFile, join(directory, 'file-link'))
      symlinkSync(admitted, join(directory, 'directory-link'))
      symlinkSync(join(root, 'missing'), join(directory, 'dangling-link'))
      const symlinks = ['file-link', 'directory-link', 'dangling-link'].map((name) =>
        join(directory, name),
      )
      const linksBefore = symlinks.map((path) => ({
        inode: inode(path),
        target: readlinkSync(path),
      }))
      expect(await shareSnapshotFiles({ candidate: directory, contentStore })).toEqual({
        linkedFiles: 2,
        copiedFiles: 0,
        copiedBytes: 0,
        createdBlobs: 2,
      })
      expect(inode(admittedCopy)).not.toBe(inode(admittedFile))
      expect(inode(externalCopy)).not.toBe(inode(externalFile))
      expect(symlinks.map((path) => ({ inode: inode(path), target: readlinkSync(path) }))).toEqual(
        linksBefore,
      )
      sources.forEach((path, index) => {
        const after = lstatSync(path, { bigint: true })
        const original = before[index]
        expect(after.ino).toBe(original?.ino)
        expect(after.dev).toBe(original?.dev)
        expect(after.nlink).toBe(original?.nlink)
        expect(after.mode).toBe(original?.mode)
        expect(after.mtimeNs).toBe(original?.mtimeNs)
        expect(after.ctimeNs).toBe(original?.ctimeNs)
      })
      expectReadonlyStore(contentStore)
    })
  })

  it('reuses immutable blobs without rewriting or truncating existing final files', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const first = candidate('first')
      const second = candidate('second')
      payload(first, 'payload', 'stable bytes')
      const secondFile = payload(second, 'renamed', 'stable bytes')
      await shareSnapshotFiles({ candidate: first, contentStore })
      const blob = blobPath(contentStore, 'stable bytes')
      const before = lstatSync(blob, { bigint: true })
      expect(await shareSnapshotFiles({ candidate: second, contentStore })).toEqual({
        linkedFiles: 1,
        copiedFiles: 0,
        copiedBytes: 0,
        createdBlobs: 0,
      })
      const after = lstatSync(blob, { bigint: true })
      expect(after.ino).toBe(before.ino)
      expect(after.size).toBe(before.size)
      expect(after.mtimeNs).toBe(before.mtimeNs)
      expect(after.mode).toBe(before.mode)
      // Legitimate readonly hardlinks change ctime; it is not an immutability key.
      expect(after.nlink).toBe(3n)
      expect(inode(secondFile)).toBe(inode(blob))
      expect(readFileSync(blob, 'utf8')).toBe('stable bytes')
      expectReadonlyStore(contentStore)
    })
  })

  it('never truncates a valid final key installed after preparation but before atomic publication', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const seed = candidate('seed')
      payload(seed, 'payload', 'seed bytes')
      await shareSnapshotFiles({ candidate: seed, contentStore })
      const directory = candidate('candidate')
      const file = payload(directory, 'payload', 'racing bytes')
      const blob = blobPath(contentStore, 'racing bytes')
      let installed: BigIntStats | undefined
      expect(exists(blob) === true).toBe(false)
      const result = await shareSnapshotFiles({
        candidate: directory,
        contentStore,
        afterStoreLock: async () => {
          // A real final-key race, not a mocked fs.link or another publisher API.
          if (installed !== undefined) return
          installBlob(contentStore, 'racing bytes')
          installed = lstatSync(blob, { bigint: true })
        },
      })
      const after = lstatSync(blob, { bigint: true })
      expect(installed).toBeDefined()
      expect(after.ino).toBe(installed?.ino)
      expect(after.size).toBe(installed?.size)
      expect(after.mtimeNs).toBe(installed?.mtimeNs)
      expect(after.mode).toBe(installed?.mode)
      expect(readFileSync(blob, 'utf8')).toBe('racing bytes')
      expect(inode(file)).toBe(inode(blob))
      expect(result).toEqual({ linkedFiles: 1, copiedFiles: 0, copiedBytes: 0, createdBlobs: 0 })
      expectReadonlyStore(contentStore)
      expectNoLock(contentStore)
    })
  })

  for (const kind of maliciousKinds) {
    it(`rejects an existing ${kind} blob without overwriting it or external sources`, async () => {
      await withStore(async ({ contentStore, candidate }) => {
        const seed = candidate('seed')
        payload(seed, 'payload', 'valid payload')
        await shareSnapshotFiles({ candidate: seed, contentStore })
        removeOwnedTree(seed)
        const external = candidate('external')
        const externalFile = payload(external, 'payload', 'valid payload')
        const externalBefore = lstatSync(externalFile, { bigint: true })
        const blob = blobPath(contentStore, 'valid payload')
        replaceBlob(blob, kind, externalFile)
        const before = lstatSync(blob, { bigint: true })
        const bytesBefore = readFileSync(blob, 'utf8')
        const directory = candidate('next')
        const file = payload(directory, 'payload', 'valid payload')
        await expect(shareSnapshotFiles({ candidate: directory, contentStore })).rejects.toThrow()
        const after = lstatSync(blob, { bigint: true })
        expect(after.ino).toBe(before.ino)
        expect(after.mode).toBe(before.mode)
        expect(after.size).toBe(before.size)
        expect(readFileSync(blob, 'utf8')).toBe(bytesBefore)
        expect(readFileSync(file, 'utf8')).toBe('valid payload')
        if (kind === 'symlink') expect(readlinkSync(blob)).toBe(externalFile)
        const externalAfter = lstatSync(externalFile, { bigint: true })
        expect(externalAfter.ino).toBe(externalBefore.ino)
        expect(externalAfter.nlink).toBe(externalBefore.nlink)
        expect(externalAfter.mode).toBe(externalBefore.mode)
        expect(externalAfter.ctimeNs).toBe(externalBefore.ctimeNs)
        expectReadonlyDirectories(contentStore)
        expectNoLock(contentStore)
      })
    })
  }

  it('restores readonly directories and releases the lock when a publishing hook fails', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const seed = candidate('seed')
      payload(seed, 'payload', 'retained')
      await shareSnapshotFiles({ candidate: seed, contentStore })
      const directory = candidate('next')
      payload(directory, 'payload', 'next bytes')
      const failure = new Error('publishing barrier failed')
      await expect(
        shareSnapshotFiles({
          candidate: directory,
          contentStore,
          afterStoreLock: async () => {
            throw failure
          },
        }),
      ).rejects.toBe(failure)
      expectReadonlyStore(contentStore)
      expectNoLock(contentStore)
      await shareSnapshotFiles({ candidate: directory, contentStore })
      expect(readFileSync(blobPath(contentStore, 'retained'), 'utf8')).toBe('retained')
      expectReadonlyStore(contentStore)
    })
  })

  it('collects only blobs without snapshot links, retaining every linked data and executable blob', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const first = candidate('worktrees', 'one', 'snapshot')
      const second = candidate('worktrees', 'two', 'snapshot')
      payload(first, 'only-first', 'first bytes')
      payload(first, 'shared', 'shared bytes')
      const shared = payload(second, 'shared', 'shared bytes')
      const executable = payload(second, 'executable', 'executable bytes', 0o755)
      await shareSnapshotFiles({ candidate: first, contentStore })
      await shareSnapshotFiles({ candidate: second, contentStore })
      expect(await collectEditorViewContentStore({ contentStore })).toEqual({
        removedBlobs: 0,
        removedBytes: 0,
      })
      expectReadonlyStore(contentStore)
      removeOwnedTree(first)
      expect(await collectEditorViewContentStore({ contentStore })).toEqual({
        removedBlobs: 1,
        removedBytes: Buffer.byteLength('first bytes'),
      })
      expect(exists(blobPath(contentStore, 'first bytes')) === true).toBe(false)
      expect(inode(shared)).toBe(inode(blobPath(contentStore, 'shared bytes')))
      expect(inode(executable)).toBe(inode(blobPath(contentStore, 'executable bytes', true)))
      expect(lstatSync(shared).nlink).toBe(2)
      expect(lstatSync(executable).nlink).toBe(2)
      expect(readFileSync(shared, 'utf8')).toBe('shared bytes')
      expect(mode(executable)).toBe(0o555)
      expectReadonlyStore(contentStore)
      removeOwnedTree(second)
      expect(await collectEditorViewContentStore({ contentStore })).toEqual({
        removedBlobs: 2,
        removedBytes: Buffer.byteLength('shared bytes') + Buffer.byteLength('executable bytes'),
      })
      expect(regularFiles(contentStore)).toEqual([])
      expectReadonlyStore(contentStore)
      expectNoLock(contentStore)
    })
  })

  it('treats a missing content store as a no-op without creating directories or taking a lock', async () => {
    await withStore(async ({ contentStore }) => {
      let entered = false
      expect(
        await collectEditorViewContentStore({
          contentStore,
          afterStoreLock: async () => {
            entered = true
          },
        }),
      ).toEqual({ removedBlobs: 0, removedBytes: 0 })
      expect(entered).toBe(false)
      expect(exists(contentStore) === true).toBe(false)
      expect(exists(`${contentStore}.lock`) === true).toBe(false)
    })
  })

  for (const kind of maliciousKinds) {
    it(`refuses to collect a ${kind} blob and restores readonly directories`, async () => {
      await withStore(async ({ contentStore, candidate }) => {
        const seed = candidate('seed')
        payload(seed, 'payload', 'valid payload')
        await shareSnapshotFiles({ candidate: seed, contentStore })
        removeOwnedTree(seed)
        const externalFile = payload(candidate('external'), 'payload', 'external bytes')
        const externalBefore = lstatSync(externalFile, { bigint: true })
        const blob = blobPath(contentStore, 'valid payload')
        replaceBlob(blob, kind, externalFile)
        const before = lstatSync(blob, { bigint: true })
        const bytesBefore = readFileSync(blob, 'utf8')
        await expect(collectEditorViewContentStore({ contentStore })).rejects.toThrow()
        const after = lstatSync(blob, { bigint: true })
        expect(after.ino).toBe(before.ino)
        expect(after.mode).toBe(before.mode)
        expect(after.size).toBe(before.size)
        expect(readFileSync(blob, 'utf8')).toBe(bytesBefore)
        const externalAfter = lstatSync(externalFile, { bigint: true })
        expect(externalAfter.ino).toBe(externalBefore.ino)
        expect(externalAfter.nlink).toBe(externalBefore.nlink)
        expect(externalAfter.mode).toBe(externalBefore.mode)
        expect(externalAfter.ctimeNs).toBe(externalBefore.ctimeNs)
        expectReadonlyDirectories(contentStore)
        expectNoLock(contentStore)
      })
    })
  }

  it('refuses unknown store entries without deleting them', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const seed = candidate('seed')
      payload(seed, 'payload', 'linked bytes')
      await shareSnapshotFiles({ candidate: seed, contentStore })
      chmodSync(contentStore, 0o755)
      const unknown = payload(contentStore, 'not-a-blob', 'must not delete', 0o444)
      chmodSync(contentStore, 0o555)
      const before = inode(unknown)
      await expect(collectEditorViewContentStore({ contentStore })).rejects.toThrow()
      expect(inode(unknown)).toBe(before)
      expect(readFileSync(unknown, 'utf8')).toBe('must not delete')
      expectReadonlyDirectories(contentStore)
      expectNoLock(contentStore)
    })
  })

  it('restores readonly directories and releases the lock when a collection hook fails', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const seed = candidate('seed')
      payload(seed, 'payload', 'dangling bytes')
      await shareSnapshotFiles({ candidate: seed, contentStore })
      removeOwnedTree(seed)
      const blob = blobPath(contentStore, 'dangling bytes')
      const before = inode(blob)
      const failure = new Error('collection barrier failed')
      await expect(
        collectEditorViewContentStore({
          contentStore,
          afterStoreLock: async () => {
            throw failure
          },
        }),
      ).rejects.toBe(failure)
      expect(inode(blob)).toBe(before)
      expectReadonlyStore(contentStore)
      expectNoLock(contentStore)
      expect(await collectEditorViewContentStore({ contentStore })).toEqual({
        removedBlobs: 1,
        removedBytes: Buffer.byteLength('dangling bytes'),
      })
      expectReadonlyStore(contentStore)
    })
  })

  it('serializes actual GC behind a publisher so an initially unlinked blob survives linking', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const seed = candidate('seed')
      payload(seed, 'payload', 'racing bytes')
      await shareSnapshotFiles({ candidate: seed, contentStore })
      removeOwnedTree(seed)
      const blob = blobPath(contentStore, 'racing bytes')
      expect(lstatSync(blob).nlink).toBe(1)
      const directory = candidate('worktrees', 'next', 'candidate')
      const file = payload(directory, 'payload', 'racing bytes')
      const entered = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      let gcEntered = false
      let gcSettled = false
      const publication = shareSnapshotFiles({
        candidate: directory,
        contentStore,
        afterStoreLock: async () => {
          entered.resolve()
          await proceed.promise
        },
      })
      let collection: Promise<unknown> | undefined
      let observation: StoreLockObservation | undefined
      try {
        await reachBarrier(entered.promise, publication)
        expectReadonlyStore(contentStore)
        expect(mode(`${contentStore}.lock`)).toBe(0o444)
        observation = observeContender(contentStore)
        collection = collectEditorViewContentStore({
          contentStore,
          afterStoreLock: async () => {
            gcEntered = true
          },
        })
        void collection.then(
          () => {
            gcSettled = true
          },
          () => {
            gcSettled = true
          },
        )
        await reachBarrier(observation.entered, collection)
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
        expect(gcEntered).toBe(false)
        expect(gcSettled).toBe(false)
        expect(lstatSync(blob).nlink).toBe(1)
        observation.close()
        proceed.resolve()
        expect(await publication).toEqual({
          linkedFiles: 1,
          copiedFiles: 0,
          copiedBytes: 0,
          createdBlobs: 0,
        })
        expect(await collection).toEqual({ removedBlobs: 0, removedBytes: 0 })
        expect(gcEntered).toBe(true)
        expect(inode(file)).toBe(inode(blob))
        expect(lstatSync(blob).nlink).toBe(2)
        expectReadonlyStore(contentStore)
        expectNoLock(contentStore)
      } finally {
        observation?.close()
        proceed.resolve()
        await Promise.allSettled([publication, ...(collection === undefined ? [] : [collection])])
      }
    })
  })

  it('waits for a live owner and serializes two independent publishers', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const seed = candidate('seed')
      payload(seed, 'payload', 'shared bytes')
      await shareSnapshotFiles({ candidate: seed, contentStore })
      removeOwnedTree(seed)
      const first = candidate('worktrees', 'one', 'candidate')
      const second = candidate('worktrees', 'two', 'candidate')
      const firstFile = payload(first, 'payload', 'shared bytes')
      const secondFile = payload(second, 'payload', 'shared bytes')
      const entered = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      const acquisitions: string[] = []
      let secondSettled = false
      const firstPublication = shareSnapshotFiles({
        candidate: first,
        contentStore,
        afterStoreLock: async () => {
          acquisitions.push('first')
          entered.resolve()
          await proceed.promise
        },
      })
      let secondPublication: Promise<EditorViewContentSharing> | undefined
      let observation: StoreLockObservation | undefined
      try {
        await reachBarrier(entered.promise, firstPublication)
        observation = observeContender(contentStore)
        secondPublication = shareSnapshotFiles({
          candidate: second,
          contentStore,
          afterStoreLock: async () => {
            acquisitions.push('second')
          },
        })
        void secondPublication.then(
          () => {
            secondSettled = true
          },
          () => {
            secondSettled = true
          },
        )
        await reachBarrier(observation.entered, secondPublication)
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
        expect(acquisitions).toEqual(['first'])
        expect(secondSettled).toBe(false)
        observation.close()
        proceed.resolve()
        const results = await Promise.all([firstPublication, secondPublication])
        expect(results).toEqual([
          { linkedFiles: 1, copiedFiles: 0, copiedBytes: 0, createdBlobs: 0 },
          { linkedFiles: 1, copiedFiles: 0, copiedBytes: 0, createdBlobs: 0 },
        ])
        expect(acquisitions).toEqual(['first', 'second'])
        expect(inode(firstFile)).toBe(inode(secondFile))
        expect(lstatSync(blobPath(contentStore, 'shared bytes')).nlink).toBe(3)
        expectReadonlyStore(contentStore)
        expectNoLock(contentStore)
      } finally {
        observation?.close()
        proceed.resolve()
        await Promise.allSettled([
          firstPublication,
          ...(secondPublication === undefined ? [] : [secondPublication]),
        ])
      }
    })
  })

  it('refuses exact-token recovery of an actual live store-lock owner', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const directory = candidate('candidate')
      payload(directory, 'payload', 'live bytes')
      const entered = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      const publication = shareSnapshotFiles({
        candidate: directory,
        contentStore,
        afterStoreLock: async () => {
          entered.resolve()
          await proceed.promise
        },
      })
      try {
        await reachBarrier(entered.promise, publication)
        const lock = `${contentStore}.lock`
        const bytes = readFileSync(lock, 'utf8')
        const owner: unknown = JSON.parse(bytes)
        if (
          typeof owner !== 'object' ||
          owner === null ||
          'token' in owner === false ||
          typeof owner.token !== 'string'
        )
          throw new Error('store lock did not contain a token')
        expect(lstatSync(lock).isFile() === true).toBe(true)
        expect(mode(lock)).toBe(0o444)
        await expect(
          recoverEditorViewContentStoreLock({ contentStore, token: owner.token }),
        ).rejects.toThrow('owner is still live')
        expect(readFileSync(lock, 'utf8')).toBe(bytes)
        proceed.resolve()
        await publication
        expectReadonlyStore(contentStore)
        expectNoLock(contentStore)
      } finally {
        proceed.resolve()
        await publication.catch(() => undefined)
      }
    })
  })

  it('requires explicit exact-token stale recovery and restores interrupted writable directories', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const seed = candidate('seed')
      payload(seed, 'payload', 'recoverable bytes')
      await shareSnapshotFiles({ candidate: seed, contentStore })
      removeOwnedTree(seed)
      const blob = blobPath(contentStore, 'recoverable bytes')
      const before = lstatSync(blob, { bigint: true })
      const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
      if (child.error !== undefined) throw child.error
      expect(child.status).toBe(0)
      expect(child.pid).toBeGreaterThan(0)
      const token = 'df015735-617a-44cb-a27a-9b5d02a97eba'
      const lock = `${contentStore}.lock`
      writeFileSync(
        lock,
        JSON.stringify({ schema: 'editor-view-content-store-lock/v1', token, pid: child.pid }),
      )
      chmodSync(lock, 0o444)
      const lockBefore = readFileSync(lock, 'utf8')
      chmodSync(contentStore, 0o755)
      chmodSync(dirname(blob), 0o755)
      const next = candidate('next')
      const nextFile = payload(next, 'payload', 'recoverable bytes')
      await expect(shareSnapshotFiles({ candidate: next, contentStore })).rejects.toThrow(
        'explicit recovery',
      )
      await expect(collectEditorViewContentStore({ contentStore })).rejects.toThrow(
        'explicit recovery',
      )
      await expect(
        recoverEditorViewContentStoreLock({ contentStore, token: 'wrong-token' }),
      ).rejects.toThrow('token mismatch')
      expect(readFileSync(lock, 'utf8')).toBe(lockBefore)
      await recoverEditorViewContentStoreLock({ contentStore, token })
      expect(exists(lock) === true).toBe(false)
      expectReadonlyStore(contentStore)
      const after = lstatSync(blob, { bigint: true })
      expect(after.ino).toBe(before.ino)
      expect(after.mode).toBe(before.mode)
      expect(after.nlink).toBe(before.nlink)
      await shareSnapshotFiles({ candidate: next, contentStore })
      expect(inode(nextFile)).toBe(inode(blob))
      expectReadonlyStore(contentStore)
      expectNoLock(contentStore)
    })
  })

  it('never overwrites a malformed existing control lock', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const seed = candidate('seed')
      payload(seed, 'payload', 'seed')
      await shareSnapshotFiles({ candidate: seed, contentStore })
      const lock = `${contentStore}.lock`
      writeFileSync(lock, '')
      chmodSync(lock, 0o444)
      const before = lstatSync(lock, { bigint: true })
      const next = candidate('next')
      payload(next, 'payload', 'next')
      await expect(shareSnapshotFiles({ candidate: next, contentStore })).rejects.toThrow()
      expect(lstatSync(lock, { bigint: true }).ino).toBe(before.ino)
      expect(readFileSync(lock, 'utf8')).toBe('')
      expect(mode(lock)).toBe(0o444)
      expectReadonlyStore(contentStore)
    })
  })

  it('uses real cross-device readonly copies or reflinks and accounts every fallback file and byte', async ({
    skip,
  }) => {
    await withStore(async ({ root, contentStore }) => {
      let alternateRoot: string | undefined
      const sourceDevice = lstatSync(root).dev
      for (const directory of ['/dev/shm', '/tmp', '/var/tmp']) {
        try {
          const probe = realpathSync(mkdtempSync(join(directory, 'editor-view-content-store-')))
          if (lstatSync(probe).dev !== sourceDevice) {
            alternateRoot = probe
            break
          }
          removeOwnedTree(probe)
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            ['ENOENT', 'EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(String(error.code)) === true
          )
            continue
          throw error
        }
      }
      if (alternateRoot === undefined) {
        skip()
        return
      }
      try {
        const first = join(alternateRoot, 'first')
        const second = join(alternateRoot, 'second')
        mkdirSync(first)
        mkdirSync(second)
        const dataBytes = 'content: café\n'
        const executableBytes = '#!/bin/sh\nexit 0\n'
        const firstData = payload(first, 'data', dataBytes)
        const firstExecutable = payload(first, 'executable', executableBytes, 0o701)
        const secondData = payload(second, 'data', dataBytes)
        const secondExecutable = payload(second, 'executable', executableBytes, 0o710)
        const copiedBytes = Buffer.byteLength(dataBytes) + Buffer.byteLength(executableBytes)
        expect(await shareSnapshotFiles({ candidate: first, contentStore })).toEqual({
          linkedFiles: 0,
          copiedFiles: 2,
          copiedBytes,
          createdBlobs: 2,
        })
        expect(await shareSnapshotFiles({ candidate: second, contentStore })).toEqual({
          linkedFiles: 0,
          copiedFiles: 2,
          copiedBytes,
          createdBlobs: 0,
        })
        for (const path of [firstData, secondData]) {
          expect(inode(path)).not.toBe(inode(blobPath(contentStore, dataBytes)))
          expect(mode(path)).toBe(0o444)
          expect(readFileSync(path, 'utf8')).toBe(dataBytes)
        }
        for (const path of [firstExecutable, secondExecutable]) {
          expect(inode(path)).not.toBe(inode(blobPath(contentStore, executableBytes, true)))
          expect(mode(path)).toBe(0o555)
          expect(readFileSync(path, 'utf8')).toBe(executableBytes)
        }
        expect(inode(firstData)).not.toBe(inode(secondData))
        expect(inode(firstExecutable)).not.toBe(inode(secondExecutable))
        expect(lstatSync(blobPath(contentStore, dataBytes)).nlink).toBe(1)
        expect(lstatSync(blobPath(contentStore, executableBytes, true)).nlink).toBe(1)
        expectReadonlyStore(contentStore)
        expectNoLock(contentStore)
      } finally {
        removeOwnedTree(alternateRoot)
      }
    })
  })
})

describe('default editor-view content store', () => {
  it('resolves relative and absolute worktree .git files and commondir to one store beside .bare', async () => {
    await withStore(async ({ root, candidate }) => {
      const project = candidate('repository')
      const common = join(project, '.bare')
      const first = candidate('repository', 'refs', 'heads', 'one')
      const second = candidate('repository', 'refs', 'heads', 'two')
      const firstGit = candidate('repository', '.bare', 'worktrees', 'one')
      const secondGit = candidate('repository', '.bare', 'worktrees', 'two')
      writeFileSync(join(first, '.git'), `gitdir: ${relative(first, firstGit)}\n`)
      writeFileSync(join(second, '.git'), `gitdir: ${secondGit}\n`)
      writeFileSync(join(firstGit, 'commondir'), `${relative(firstGit, common)}\n`)
      writeFileSync(join(secondGit, 'commondir'), `${common}\n`)
      const expected = join(project, '.editor-view-content', 'v1')
      withContentStoreEnv(undefined, () => {
        expect(defaultEditorViewContentStore(first)).toBe(expected)
        expect(defaultEditorViewContentStore(second)).toBe(expected)
      })
      expect(exists(join(root, '.editor-view-content')) === true).toBe(false)
      expect(exists(expected) === true).toBe(false)
    })
  })

  it('uses the common directory of an ordinary .git-directory checkout', async () => {
    await withStore(async ({ candidate }) => {
      const repository = candidate('repository')
      candidate('repository', '.git')
      withContentStoreEnv(undefined, () => {
        expect(defaultEditorViewContentStore(repository)).toBe(
          join(repository, '.editor-view-content', 'v1'),
        )
      })
    })
  })

  it('honors an explicit environment override and restores the prior environment', async () => {
    await withStore(async ({ root, candidate }) => {
      const repository = candidate('repository')
      const override = join(root, 'overridden-content', 'v1')
      const previous = process.env.EDITOR_VIEW_CONTENT_STORE
      withContentStoreEnv(override, () => {
        expect(defaultEditorViewContentStore(repository)).toBe(override)
      })
      expect(process.env.EDITOR_VIEW_CONTENT_STORE).toBe(previous)
      expect(exists(override) === true).toBe(false)
    })
  })

  it('falls back to the per-user cache for a non-Git repository', async () => {
    await withStore(async ({ candidate }) => {
      const repository = candidate('not-git')
      withContentStoreEnv(undefined, () => {
        expect(defaultEditorViewContentStore(repository)).toBe(
          join(homedir(), '.cache', 'effect-utils', 'editor-view-content', 'v1'),
        )
      })
    })
  })
})
