import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  type BigIntStats,
  accessSync,
  constants,
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
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { classifyEditorViewProcessCandidates } from './editor-view-readers.ts'
import {
  type EditorViewContentSharing,
  collectEditorViewContentStore,
  repairEditorViewContentStore,
  defaultEditorViewContentStore,
  editorViewStagingCreatorIdentity,
  shareSnapshotFiles,
} from './editor-view-sharing.ts'

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const bun = requireTool('BUN_BIN')
const ps = requireTool('PS_BIN')
const sharingModule = new URL('./editor-view-sharing.ts', import.meta.url)

const crossDeviceDirectories = ['/dev/shm', '/tmp', '/var/tmp'].filter((directory) => {
  try {
    const canonical = realpathSync(directory)
    const status = lstatSync(canonical)
    accessSync(canonical, constants.W_OK | constants.X_OK)
    return status.isDirectory() === true && status.dev !== lstatSync(realpathSync(tmpdir())).dev
  } catch {
    return false
  }
})

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

/**
 * The persistent flock file is the only lock artifact. It is never unlinked, so
 * an idle store keeps it as a private regular file and no transient controls.
 */
const expectIdleStoreLock = (contentStore: string): void => {
  const lock = lstatSync(`${contentStore}.flock`)
  expect(lock.isFile() === true).toBe(true)
  expect(lock.uid).toBe(process.getuid?.())
  expect(lock.nlink).toBe(1)
  expect(lock.mode & 0o7777).toBe(0o600)
  const base = basename(contentStore)
  expect(
    readdirSync(dirname(contentStore)).filter(
      (name) =>
        name === `${base}.lock` ||
        name.startsWith(`${base}.lock.`) === true ||
        name.startsWith(`.${base}.blob-`) === true,
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

type CrashedInstall = {
  readonly pid: number
  readonly blob: string
  readonly temporary: string
  readonly preparedCopy?: string
}

const fail = (message: string): never => {
  throw new Error(message)
}

/**
 * Runs one real publisher in a Bun child that parks inside its install batch,
 * right after the canonical CAS link, then SIGKILLs it. The kernel closes its
 * flock descriptor; repair evidence (writable shard, shard temp, staging inode)
 * stays exactly as the crashed process left it.
 */
const crashAtBlobInstall = async ({
  root,
  candidate,
  contentStore,
}: {
  readonly root: string
  readonly candidate: string
  readonly contentStore: string
}): Promise<CrashedInstall> => {
  const script = join(root, 'crash-at-blob-install.ts')
  writeFileSync(
    script,
    [
      `import { shareSnapshotFiles } from ${JSON.stringify(sharingModule.href)}`,
      'const [candidate, contentStore] = process.argv.slice(2)',
      'await shareSnapshotFiles({',
      '  candidate,',
      '  contentStore,',
      '  afterBlobInstall: async (installed) => {',
      // The parent's open stdin pipe keeps the event loop alive until SIGKILL.
      '    process.stdin.resume()',
      '    process.stdout.write(`${JSON.stringify(installed)}\\n`)',
      '    await Promise.withResolvers().promise',
      '  },',
      '})',
      '',
    ].join('\n'),
  )
  const child = spawn(bun, [script, candidate, contentStore], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
  const installed = Promise.withResolvers<Omit<CrashedInstall, 'pid'>>()
  child.once('error', (error) => {
    exited.reject(error)
    installed.reject(error)
  })
  child.once('exit', (code, signal) => {
    exited.resolve({ code, signal })
    // A no-op once the install barrier was reached.
    installed.reject(
      new Error(`publisher exited before its blob-install barrier: ${code ?? signal}`),
    )
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
    const newline = output.indexOf('\n')
    if (newline === -1) return
    try {
      installed.resolve(JSON.parse(output.slice(0, newline)))
    } catch (error) {
      installed.reject(error)
    }
  })
  try {
    const install = await installed.promise
    const pid = child.pid ?? fail('publisher child has no pid')
    const identity = editorViewStagingCreatorIdentity({ pid })
    expect(identity).toMatch(/^(linux-[a-f0-9]{32}-[0-9]+|darwin-[a-f0-9]{64})$/)
    if (install.preparedCopy !== undefined)
      expect(basename(install.preparedCopy).startsWith(`${pid}-${identity}-`)).toBe(true)
    expect(child.kill('SIGKILL')).toBe(true)
    expect(await exited.promise).toEqual({ code: null, signal: 'SIGKILL' })
    const afterExit = editorViewStagingCreatorIdentity({ pid })
    expect(afterExit).not.toBe('unknown')
    expect(afterExit).not.toBe(identity)
    return { pid, ...install }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited.promise.catch(() => undefined)
  }
}

/** A writable store directory left behind by an interrupted metadata transaction. */
const isWritable = (path: string): boolean => (lstatSync(path).mode & 0o222) !== 0

/** Real directory on another device than the store fixture, for genuine EXDEV publishing. */
const withCrossDeviceRoot = async (
  root: string,
  run: (alternateRoot: string) => Promise<void>,
): Promise<void> => {
  let alternateRoot: string | undefined
  const sourceDevice = lstatSync(root).dev
  for (const directory of crossDeviceDirectories) {
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
  if (alternateRoot === undefined)
    throw new Error('The admitted cross-device filesystem became unavailable before its probe')
  try {
    await run(alternateRoot)
  } finally {
    removeOwnedTree(alternateRoot)
  }
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
  it('keeps staging creator identity invariant across caller timezones and locales', async () => {
    await withStore(async ({ root }) => {
      const script = join(root, 'probe-staging-identity.ts')
      writeFileSync(
        script,
        [
          `import { editorViewStagingCreatorIdentity } from ${JSON.stringify(sharingModule.href)}`,
          'const pid = Number(process.argv[2])',
          "console.log(JSON.stringify({ native: editorViewStagingCreatorIdentity({ pid }), macOS: editorViewStagingCreatorIdentity({ pid, platform: 'darwin', ps: process.argv[3] }) }))",
        ].join('\n'),
      )
      const probe = (timezone: string, locale: string): { native: string; macOS: string } => {
        const result = spawnSync(bun, [script, String(process.pid), ps], {
          encoding: 'utf8',
          env: { ...process.env, TZ: timezone, LC_ALL: locale },
        })
        expect(result.status).toBe(0)
        const parsed: unknown = JSON.parse(result.stdout.trim())
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('native' in parsed) ||
          typeof parsed.native !== 'string' ||
          !('macOS' in parsed) ||
          typeof parsed.macOS !== 'string'
        )
          throw new Error('invalid process identity probe output')
        return { native: parsed.native, macOS: parsed.macOS }
      }
      const western = probe('Pacific/Honolulu', 'en_US.UTF-8')
      const eastern = probe('Asia/Tokyo', 'de_DE.UTF-8')
      expect(western).toEqual(eastern)
      // Invoke the real ps fallback even on Linux so this regression is not
      // silently skipped on hosts without a macOS or cross-device filesystem.
      expect(western.macOS).toMatch(/^darwin-[a-f0-9]{64}$/)
      if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
        const starttime = stat
          .slice(stat.lastIndexOf(')') + 2)
          .trim()
          .split(/\s+/)[19]
        expect(western.native).toMatch(new RegExp(`^linux-[a-f0-9]{32}-${starttime}$`))
      }
    })
  })

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
      // The flock file persists across acquisitions; releasing never unlinks it.
      const lock = inode(`${contentStore}.flock`)
      for (const directory of [sibling, otherWorktree]) {
        expect(await shareSnapshotFiles({ candidate: directory, contentStore })).toEqual({
          linkedFiles: 1,
          copiedFiles: 0,
          copiedBytes: 0,
          createdBlobs: 0,
        })
      }
      expect(inode(`${contentStore}.flock`)).toBe(lock)
      const blob = blobPath(contentStore, 'same payload')
      for (const path of [firstFile, renamed, siblingFile, otherFile]) {
        expect(inode(path)).toBe(inode(blob))
        expect(mode(path)).toBe(0o444)
      }
      expect(lstatSync(blob).nlink).toBe(5)
      expect(regularFiles(contentStore)).toEqual([blob])
      expectReadonlyStore(contentStore)
      expectIdleStoreLock(contentStore)
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
      expectIdleStoreLock(contentStore)
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
        expectIdleStoreLock(contentStore)
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
      expectIdleStoreLock(contentStore)
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
      expectIdleStoreLock(contentStore)
    })
  })

  it('does not read incident receipts or add a census to healthy collection', async () => {
    await withStore(async ({ root, contentStore, candidate }) => {
      const directory = candidate('snapshot')
      payload(directory, 'data', 'healthy linked data')
      await shareSnapshotFiles({ candidate: directory, contentStore })
      const blob = blobPath(contentStore, 'healthy linked data')
      const target = payload(root, 'untouched-incident-target', 'not a receipt')
      symlinkSync(target, `${contentStore}.incident.json`)
      const readdir = vi.spyOn(fsPromises, 'readdir')
      try {
        expect(await collectEditorViewContentStore({ contentStore })).toEqual({
          removedBlobs: 0,
          removedBytes: 0,
        })
        expect(readdir.mock.calls.filter(([path]) => String(path) === dirname(blob))).toHaveLength(
          1,
        )
      } finally {
        readdir.mockRestore()
      }
      expect(readFileSync(target, 'utf8')).toBe('not a receipt')
      expect(lstatSync(`${contentStore}.incident.json`).isSymbolicLink()).toBe(true)
      expectReadonlyStore(contentStore)
    })
  })

  it('records a bounded first-observed metadata-only incident and reuses it on repeated refusals', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const directory = candidate('snapshot')
      const bytes = Array.from({ length: 12 }, (_, index) => `incident payload ${index}`)
      for (const [index, value] of bytes.entries()) payload(directory, `file-${index}`, value)
      await shareSnapshotFiles({ candidate: directory, contentStore })
      const blobs = bytes.map((value) => blobPath(contentStore, value))
      for (const blob of blobs) chmodSync(blob, 0o644)
      const before = blobs.map((blob) => lstatSync(blob, { bigint: true }))
      const originalOpen = fsPromises.open
      const openedPayloads: string[] = []
      const open = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
        if (typeof args[0] === 'string' && blobs.includes(args[0]) === true)
          openedPayloads.push(args[0])
        return originalOpen(...args)
      })
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      try {
        await expect(collectEditorViewContentStore({ contentStore })).rejects.toMatchObject({
          name: 'WritableBlobTrustError',
        })
        const alertPath = `${contentStore}.incident.json`
        const receiptBytes = readFileSync(alertPath, 'utf8')
        const receipt = JSON.parse(receiptBytes)
        expect(receipt).toMatchObject({
          schema: 'editor-view.content-store.integrity-incident.v1',
          writableBlobCount: 12,
        })
        expect(Number.isFinite(Date.parse(receipt.observedAt))).toBe(true)
        expect(receipt.examplePaths).toHaveLength(8)
        expect(receipt.examplePaths.every((path: string) => blobs.includes(path))).toBe(true)
        expect(receipt.repairCommand).toContain('repair-content --repo-root')
        expect(receipt.repairCommand).toContain(`--content-store '${contentStore}'`)
        expect(receipt.repairCommand).toContain('--quiesced true')
        expect(mode(alertPath)).toBe(0o600)
        expect(lstatSync(alertPath).nlink).toBe(1)
        expect(lstatSync(alertPath).uid).toBe(process.getuid?.())
        expect(stderr).toHaveBeenCalledWith(
          `${JSON.stringify({
            event: 'editor-view.content-store.integrity-incident',
            writableBlobCount: 12,
            observedAt: receipt.observedAt,
            alertPath,
          })}\n`,
        )
        // A subsequent failure must not recensus every shard. It still performs
        // the collector's normal bounded admission before refusing the first blob.
        const readdir = vi.spyOn(fsPromises, 'readdir')
        try {
          await expect(collectEditorViewContentStore({ contentStore })).rejects.toThrow(
            'writable blob is not trusted',
          )
          const scannedShards = new Set(
            readdir.mock.calls
              .map(([path]) => String(path))
              .filter((path) => blobs.some((blob) => dirname(blob) === path)),
          )
          expect(scannedShards.size).toBe(1)
        } finally {
          readdir.mockRestore()
        }
        expect(readFileSync(alertPath, 'utf8')).toBe(receiptBytes)
        expect(openedPayloads).toEqual([])
        for (const [index, blob] of blobs.entries()) {
          expect(lstatSync(blob, { bigint: true })).toEqual(before[index])
          expect(readFileSync(blob, 'utf8')).toBe(bytes[index])
        }
      } finally {
        open.mockRestore()
        stderr.mockRestore()
      }
      expect(
        (await repairEditorViewContentStore({ contentStore, quiesced: true })).repairedBlobs,
      ).toBe(12)
      expect(exists(`${contentStore}.incident.json`)).toBe(false)
      expectReadonlyStore(contentStore)
    })
  })

  it('reports writable blobs rejected during the initial dirty-store repair', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const directory = candidate('snapshot')
      payload(directory, 'data', 'dirty incident')
      await shareSnapshotFiles({ candidate: directory, contentStore })
      const blob = blobPath(contentStore, 'dirty incident')
      chmodSync(blob, 0o644)
      writeFileSync(`${contentStore}.flock`, '1')
      let entered = false
      await expect(
        collectEditorViewContentStore({
          contentStore,
          afterStoreLock: () => {
            entered = true
          },
        }),
      ).rejects.toThrow('writable blob is not trusted')
      expect(entered).toBe(false)
      expect(JSON.parse(readFileSync(`${contentStore}.incident.json`, 'utf8'))).toMatchObject({
        writableBlobCount: 1,
        examplePaths: [blob],
      })
      expect(mode(blob)).toBe(0o644)
    })
  })

  it.each(['symlink', 'hardlink', 'public'] as const)(
    'does not write through or replace an unsafe %s incident receipt',
    async (kind) => {
      await withStore(async ({ root, contentStore, candidate }) => {
        const directory = candidate('snapshot')
        payload(directory, 'data', 'unsafe receipt')
        await shareSnapshotFiles({ candidate: directory, contentStore })
        const blob = blobPath(contentStore, 'unsafe receipt')
        chmodSync(blob, 0o644)
        const target = payload(root, 'receipt-target', 'do not overwrite', 0o600)
        const alertPath = `${contentStore}.incident.json`
        if (kind === 'symlink') symlinkSync(target, alertPath)
        else if (kind === 'hardlink') linkSync(target, alertPath)
        else {
          writeFileSync(alertPath, 'do not overwrite', { mode: 0o644 })
          chmodSync(alertPath, 0o644)
        }
        const before = lstatSync(alertPath, { bigint: true })
        await expect(collectEditorViewContentStore({ contentStore })).rejects.toMatchObject({
          name: 'WritableBlobTrustError',
        })
        expect(lstatSync(alertPath, { bigint: true })).toEqual(before)
        expect(readFileSync(target, 'utf8')).toBe('do not overwrite')
        expect(readFileSync(alertPath, 'utf8')).toBe('do not overwrite')
        expect(mode(blob)).toBe(0o644)
      })
    },
  )

  it('repairs archive chmod poisoning of shared data and executable blobs only after hashing their addresses', async () => {
    await withStore(async ({ root, contentStore, candidate }) => {
      const directory = candidate('worktree')
      payload(directory, 'data', 'shared data')
      payload(directory, 'executable', 'shared executable', 0o755)
      await shareSnapshotFiles({ candidate: directory, contentStore })
      const originalInode = inode(join(directory, 'data'))
      // Simulate an unsafe recursive unlock during worktree archival, then move it.
      // Hardlinks, unlike symlinks, propagate this chmod into the shared CAS.
      for (const path of [
        directory,
        ...readdirSync(directory).map((name) => join(directory, name)),
      ])
        chmodSync(path, lstatSync(path).mode | 0o200)
      const archive = join(root, 'archived-worktree')
      renameSync(directory, archive)
      const data = join(archive, 'data')
      const executable = join(archive, 'executable')
      await expect(collectEditorViewContentStore({ contentStore })).rejects.toThrow(
        'writable blob is not trusted',
      )
      expect(JSON.parse(readFileSync(`${contentStore}.incident.json`, 'utf8'))).toMatchObject({
        writableBlobCount: 2,
      })
      expect(await repairEditorViewContentStore({ contentStore, quiesced: true })).toEqual({
        repairedBlobs: 2,
        verifiedBlobs: 2,
        checkedBlobInodes: 2,
        writableBlobs: 0,
        mismatchedBlobs: [],
        quarantined: [],
      })
      expect(exists(`${contentStore}.incident.json`)).toBe(false)
      expect(inode(data)).toBe(originalInode)
      expect(mode(data)).toBe(0o444)
      expect(mode(executable)).toBe(0o555)
      expectReadonlyStore(contentStore)
      expectIdleStoreLock(contentStore)
      expect(await repairEditorViewContentStore({ contentStore, quiesced: true })).toEqual({
        repairedBlobs: 0,
        verifiedBlobs: 0,
        checkedBlobInodes: 2,
        writableBlobs: 0,
        mismatchedBlobs: [],
        quarantined: [],
      })
    })
  })

  it('quarantines corrupted writable blobs without trusting or changing linked snapshot bytes', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const directory = candidate('snapshot')
      const data = payload(directory, 'data', 'original data')
      await shareSnapshotFiles({ candidate: directory, contentStore })
      const blob = blobPath(contentStore, 'original data')
      chmodSync(data, 0o644)
      writeFileSync(data, 'corrupted data')
      await expect(collectEditorViewContentStore({ contentStore })).rejects.toThrow(
        'writable blob is not trusted',
      )
      expect(exists(`${contentStore}.incident.json`)).toBe(true)
      const result = await repairEditorViewContentStore({ contentStore, quiesced: true })
      expect(result.repairedBlobs).toBe(0)
      expect(result.quarantined).toHaveLength(1)
      const quarantined = result.quarantined[0]!
      expect(quarantined.path).toBe(blob)
      expect(quarantined.digest).toBe(createHash('sha256').update('corrupted data').digest('hex'))
      expect(exists(blob)).toBe(false)
      expect(inode(quarantined.quarantine)).toBe(inode(data))
      expect(readFileSync(quarantined.quarantine, 'utf8')).toBe('corrupted data')
      expect(mode(data)).toBe(0o644)
      expectReadonlyStore(contentStore)
      expectIdleStoreLock(contentStore)
      expect(exists(`${contentStore}.incident.json`)).toBe(true)
    })
  })

  it('requires explicit CLI quiescence and reports repaired counts', async () => {
    await withStore(async ({ root, contentStore, candidate }) => {
      const directory = candidate('snapshot')
      const data = payload(directory, 'data', 'cli recovery')
      await shareSnapshotFiles({ candidate: directory, contentStore })
      chmodSync(data, 0o644)
      await expect(collectEditorViewContentStore({ contentStore })).rejects.toThrow(
        'writable blob is not trusted',
      )
      const receipt = readFileSync(`${contentStore}.incident.json`, 'utf8')
      const args = [
        fileURLToPath(new URL('./editor-view.ts', import.meta.url)),
        'repair-content',
        '--repo-root',
        root,
        '--content-store',
        contentStore,
      ]
      const refused = spawnSync(bun, args, { encoding: 'utf8' })
      expect(refused.status).not.toBe(0)
      expect(refused.stderr).toContain('repair-content requires --quiesced true')
      expect(mode(data)).toBe(0o644)
      expect(readFileSync(`${contentStore}.incident.json`, 'utf8')).toBe(receipt)
      const dryRun = spawnSync(bun, [...args, '--dry-run', 'true'], { encoding: 'utf8' })
      expect(dryRun.status).toBe(0)
      expect(dryRun.stdout).toContain('"verifiedBlobs":1')
      expect(dryRun.stdout).toContain('"writableBlobs":1')
      expect(dryRun.stdout).toContain('"repairedBlobs":0')
      expect(mode(data)).toBe(0o644)
      expect(readFileSync(`${contentStore}.incident.json`, 'utf8')).toBe(receipt)
      const repaired = spawnSync(bun, [...args, '--quiesced', 'true'], { encoding: 'utf8' })
      expect(repaired.status).toBe(0)
      expect(repaired.stdout).toContain('"repairedBlobs":1')
      expect(repaired.stdout).toContain('"checkedBlobInodes":1')
      expect(repaired.stdout).toContain('"writableBlobs":0')
      expect(mode(data)).toBe(0o444)
      expect(exists(`${contentStore}.incident.json`)).toBe(false)
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
      expect(exists(`${contentStore}.flock`) === true).toBe(false)
      expect(exists(`${contentStore}.incident.json`)).toBe(false)
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
        expect(exists(`${contentStore}.incident.json`)).toBe(kind === 'writable')
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
        expectIdleStoreLock(contentStore)
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
      expectIdleStoreLock(contentStore)
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
      expectIdleStoreLock(contentStore)
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
      const gcContended = Promise.withResolvers<void>()
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
      try {
        await reachBarrier(entered.promise, publication)
        expectReadonlyStore(contentStore)
        expect(lstatSync(`${contentStore}.flock`).isFile() === true).toBe(true)
        collection = collectEditorViewContentStore({
          contentStore,
          afterStoreLockContended: () => gcContended.resolve(),
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
        await reachBarrier(gcContended.promise, collection)
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
        expect(gcEntered).toBe(false)
        expect(gcSettled).toBe(false)
        expect(lstatSync(blob).nlink).toBe(1)
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
        expectIdleStoreLock(contentStore)
      } finally {
        proceed.resolve()
        await Promise.allSettled([publication, ...(collection === undefined ? [] : [collection])])
      }
    })
  })

  it('blocks a contending publisher on the held flock and serializes two independent publishers', async () => {
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
      const secondContended = Promise.withResolvers<void>()
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
      try {
        await reachBarrier(entered.promise, firstPublication)
        secondPublication = shareSnapshotFiles({
          candidate: second,
          contentStore,
          afterStoreLockContended: () => secondContended.resolve(),
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
        await reachBarrier(secondContended.promise, secondPublication)
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
        expect(acquisitions).toEqual(['first'])
        expect(secondSettled).toBe(false)
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
        expectIdleStoreLock(contentStore)
      } finally {
        proceed.resolve()
        await Promise.allSettled([
          firstPublication,
          ...(secondPublication === undefined ? [] : [secondPublication]),
        ])
      }
    })
  })

  it.each([0o600, 0o444])('keeps live staging mode %o during repair', async (stageMode) => {
    await withStore(async ({ contentStore, candidate }) => {
      const seed = candidate('seed')
      payload(seed, 'payload', 'seed bytes')
      await shareSnapshotFiles({ candidate: seed, contentStore })
      const lock = inode(`${contentStore}.flock`)
      const identity = editorViewStagingCreatorIdentity({ pid: process.pid })
      expect(identity).toMatch(/^(linux-[a-f0-9]{32}-[0-9]+|darwin-[a-f0-9]{64})$/)
      const staging = join(contentStore, '.staging')
      chmodSync(contentStore, 0o755)
      mkdirSync(staging)
      const stage = payload(
        staging,
        `${process.pid}-${identity}-00000000-0000-0000-0000-000000000001.tmp`,
        'live staging bytes',
        stageMode,
      )
      chmodSync(staging, 0o555)
      chmodSync(contentStore, 0o555)
      const before = lstatSync(stage, { bigint: true })
      let inspectedBeforeCallback = false
      expect(
        await collectEditorViewContentStore({
          contentStore,
          afterStoreLock: () => {
            const after = lstatSync(stage, { bigint: true })
            expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
            expect(after.mode).toBe(before.mode)
            expect(after.mtimeNs).toBe(before.mtimeNs)
            expect(readFileSync(stage, 'utf8')).toBe('live staging bytes')
            expectReadonlyDirectories(contentStore)
            inspectedBeforeCallback = true
          },
        }),
      ).toEqual({ removedBlobs: 0, removedBytes: 0 })
      expect(inspectedBeforeCallback).toBe(true)
      expect(inode(`${contentStore}.flock`)).toBe(lock)
      expectIdleStoreLock(contentStore)
    })
  })

  it('repairs a publisher SIGKILLed mid-batch on the next acquisition before any callback', async () => {
    await withStore(async ({ root, contentStore, candidate }) => {
      const seed = candidate('seed')
      payload(seed, 'payload', 'seed bytes')
      await shareSnapshotFiles({ candidate: seed, contentStore })
      const lock = inode(`${contentStore}.flock`)
      const crashed = candidate('crashed')
      const crashedFile = payload(crashed, 'payload', 'crashed bytes')
      const install = await crashAtBlobInstall({ root, candidate: crashed, contentStore })
      expect(install.blob).toBe(blobPath(contentStore, 'crashed bytes'))
      expect(install.preparedCopy).toBeUndefined()
      expect(dirname(install.temporary)).toBe(dirname(install.blob))
      expect(basename(install.temporary)).toMatch(/^\.tmp-/)
      // The crash left real repair work: a writable shard and a linked shard temp.
      expect(inode(install.temporary)).toBe(inode(install.blob))
      expect(isWritable(dirname(install.blob))).toBe(true)
      let repairedBeforeCallback = false
      expect(
        await collectEditorViewContentStore({
          contentStore,
          afterStoreLockContended: () => fail('the SIGKILLed publisher retained the store lock'),
          afterStoreLock: () => {
            expect(exists(install.temporary) === true).toBe(false)
            expectReadonlyStore(contentStore)
            repairedBeforeCallback = true
          },
        }),
      ).toEqual({ removedBlobs: 0, removedBytes: 0 })
      expect(repairedBeforeCallback).toBe(true)
      expect(inode(crashedFile)).toBe(inode(install.blob))
      expect(readFileSync(install.blob, 'utf8')).toBe('crashed bytes')
      expect(inode(`${contentStore}.flock`)).toBe(lock)
      expectIdleStoreLock(contentStore)
      removeOwnedTree(crashed)
      expect(await collectEditorViewContentStore({ contentStore })).toEqual({
        removedBlobs: 1,
        removedBytes: Buffer.byteLength('crashed bytes'),
      })
      expectReadonlyStore(contentStore)
      expectIdleStoreLock(contentStore)
    })
  })

  it('releases the flock when directory restoration fails and repairs on the next acquisition', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const seed = candidate('seed')
      payload(seed, 'payload', 'seed bytes')
      await shareSnapshotFiles({ candidate: seed, contentStore })
      const directory = candidate('next')
      const file = payload(directory, 'payload', 'restoration bytes')
      const failure = new Error('injected content-store directory restoration failure')
      const inStore = (path: unknown): path is string =>
        typeof path === 'string' &&
        (path === contentStore || path.startsWith(`${contentStore}/`) === true)
      let unrestored: string | undefined
      const originalOpen = fsPromises.open
      // Fault only the first readonly restoration of a store directory handle.
      const open = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args)
        const path = args[0]
        if (inStore(path) === true) {
          const originalChmod = handle.chmod.bind(handle)
          vi.spyOn(handle, 'chmod').mockImplementation(async (next) => {
            if (unrestored === undefined && next === 0o555) {
              unrestored = path
              throw failure
            }
            return originalChmod(next)
          })
        }
        return handle
      })
      try {
        await expect(shareSnapshotFiles({ candidate: directory, contentStore })).rejects.toThrow()
      } finally {
        open.mockRestore()
      }
      const failedDirectory =
        unrestored ?? fail('no content-store directory restoration was faulted')
      expect(isWritable(failedDirectory)).toBe(true)
      let repairedBeforeCallback = false
      expect(
        await collectEditorViewContentStore({
          contentStore,
          afterStoreLockContended: () => fail('failed restoration retained the store lock'),
          afterStoreLock: () => {
            expect(mode(failedDirectory)).toBe(0o555)
            expectReadonlyStore(contentStore)
            repairedBeforeCallback = true
          },
        }),
      ).toEqual({ removedBlobs: 0, removedBytes: 0 })
      expect(repairedBeforeCallback).toBe(true)
      await shareSnapshotFiles({ candidate: directory, contentStore })
      expect(inode(file)).toBe(inode(blobPath(contentStore, 'restoration bytes')))
      expectReadonlyStore(contentStore)
      expectIdleStoreLock(contentStore)
    })
  })

  it('refuses a symbolic-link flock without following or replacing it', async () => {
    await withStore(async ({ contentStore, candidate }) => {
      const seed = candidate('seed')
      payload(seed, 'payload', 'seed')
      await shareSnapshotFiles({ candidate: seed, contentStore })
      const lock = `${contentStore}.flock`
      const target = payload(candidate('external'), 'lock-target', 'external bytes', 0o600)
      const before = lstatSync(target, { bigint: true })
      unlinkSync(lock)
      symlinkSync(target, lock)
      const next = candidate('next')
      payload(next, 'payload', 'next')
      await expect(shareSnapshotFiles({ candidate: next, contentStore })).rejects.toThrow()
      expect(readlinkSync(lock)).toBe(target)
      const after = lstatSync(target, { bigint: true })
      expect(after.ino).toBe(before.ino)
      expect(after.mode).toBe(before.mode)
      expect(after.mtimeNs).toBe(before.mtimeNs)
      expect(readFileSync(target, 'utf8')).toBe('external bytes')
      expectReadonlyStore(contentStore)
    })
  })

  it.skipIf(crossDeviceDirectories.length === 0)(
    'uses real cross-device readonly copies or reflinks and accounts every fallback file and byte',
    async () => {
      await withStore(async ({ root, contentStore }) => {
        await withCrossDeviceRoot(root, async (alternateRoot) => {
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
          expectIdleStoreLock(contentStore)
        })
      })
    },
  )

  it.skipIf(crossDeviceDirectories.length === 0)(
    'removes the orphaned EXDEV staging inode of a SIGKILLed publisher so GC can collect its blob',
    async () => {
      await withStore(async ({ root, contentStore, candidate }) => {
        await withCrossDeviceRoot(root, async (alternateRoot) => {
          const crashed = join(alternateRoot, 'crashed')
          mkdirSync(crashed)
          const crashedFile = payload(crashed, 'payload', 'staged bytes')
          const install = await crashAtBlobInstall({ root, candidate: crashed, contentStore })
          const lock = inode(`${contentStore}.flock`)
          const staging =
            install.preparedCopy ?? fail('cross-device publisher did not stage a copy')
          expect(install.blob).toBe(blobPath(contentStore, 'staged bytes'))
          expect(dirname(staging)).toBe(join(contentStore, '.staging'))
          expect(basename(staging).startsWith(`${install.pid}-`)).toBe(true)
          expect(basename(staging).endsWith('.tmp')).toBe(true)
          // The canonical key already shares the staged inode; only repair can drop the orphan.
          expect(inode(staging)).toBe(inode(install.blob))
          expect(inode(crashedFile)).not.toBe(inode(install.blob))
          expect(lstatSync(install.blob).nlink).toBeGreaterThan(1)
          const next = candidate('next')
          payload(next, 'payload', 'next bytes')
          let repairedBeforeCallback = false
          expect(
            await shareSnapshotFiles({
              candidate: next,
              contentStore,
              afterStoreLockContended: () =>
                fail('the SIGKILLed publisher retained the store lock'),
              afterStoreLock: () => {
                expect(readdirSync(dirname(staging))).toEqual([])
                expect(exists(install.temporary) === true).toBe(false)
                expect(readFileSync(install.blob, 'utf8')).toBe('staged bytes')
                expect(mode(install.blob)).toBe(0o444)
                expect(inode(`${contentStore}.flock`)).toBe(lock)
                expectReadonlyStore(contentStore)
                repairedBeforeCallback = true
              },
            }),
          ).toEqual({ linkedFiles: 1, copiedFiles: 0, copiedBytes: 0, createdBlobs: 1 })
          expect(repairedBeforeCallback).toBe(true)
          expect(lstatSync(install.blob).nlink).toBe(1)
          expect(await collectEditorViewContentStore({ contentStore })).toEqual({
            removedBlobs: 1,
            removedBytes: Buffer.byteLength('staged bytes'),
          })
          expect(exists(install.blob) === true).toBe(false)
          expect(readFileSync(crashedFile, 'utf8')).toBe('staged bytes')
          expect(mode(crashedFile)).toBe(0o444)
          expect(inode(`${contentStore}.flock`)).toBe(lock)
          expectReadonlyStore(contentStore)
          expectIdleStoreLock(contentStore)
        })
      })
    },
  )
})

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'positive editor-view directory readers',
  () => {
    for (const pathKind of ['store', 'unknown-child', 'known-generation'] as const) {
      it.each(['cwd', 'fd', 'cwd-and-fd'] as const)(
        `scopes ${pathKind} protection from a real %s reader`,
        async (reference) => {
          await withStore(async ({ root, candidate }) => {
            const editorRoot = candidate('editor')
            const first = candidate('editor', '.store', 'generation-one')
            const second = candidate('editor', '.store', 'generation-one-other')
            const otherRoot = candidate('other-editor')
            const other = candidate('other-editor', '.store', 'generation-one')
            const directory =
              pathKind === 'store'
                ? dirname(first)
                : pathKind === 'unknown-child'
                  ? candidate('editor', '.store', 'unidentified', 'child')
                  : candidate('editor', '.store', 'generation-one', 'node_modules')
            const script = join(root, 'directory-reader.ts')
            writeFileSync(
              script,
              [
                "import { openSync, closeSync } from 'node:fs'",
                'const [directory, reference] = process.argv.slice(2)',
                'if (reference !== "fd") process.chdir(directory)',
                'const fd = reference === "cwd" ? undefined : openSync(directory, "r")',
                'process.stdin.resume()',
                'process.stdin.once("data", () => {',
                '  if (fd !== undefined) closeSync(fd)',
                '  process.exit(0)',
                '})',
                'process.stdout.write("ready\\n")',
              ].join('\n'),
            )
            const child = spawn(bun, [script, directory, reference], {
              cwd: root,
              stdio: ['pipe', 'pipe', 'pipe'],
            })
            const ready = Promise.withResolvers<void>()
            const exited = Promise.withResolvers<{
              readonly code: number | null
              readonly signal: NodeJS.Signals | null
            }>()
            let output = ''
            let stderr = ''
            child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
              output += chunk
              if (output.includes('ready\n') === true) ready.resolve()
            })
            child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
              stderr += chunk
            })
            child.once('error', (error) => {
              ready.reject(error)
              exited.reject(error)
            })
            child.once('exit', (code, signal) => {
              exited.resolve({ code, signal })
              ready.reject(
                new Error(`directory reader exited before readiness: ${code ?? signal}; ${stderr}`),
              )
            })
            void ready.promise.catch(() => undefined)
            void exited.promise.catch(() => undefined)
            try {
              await ready.promise
              // cwd-and-fd observes the known path twice in the same census:
              // holding it once must not widen the next reference to its root.
              const evidence = classifyEditorViewProcessCandidates({
                candidates: [
                  { key: 'first', editorRoot, snapshotRoot: first, linkedInodes: [] },
                  { key: 'second', editorRoot, snapshotRoot: second, linkedInodes: [] },
                  {
                    key: 'other',
                    editorRoot: otherRoot,
                    snapshotRoot: other,
                    linkedInodes: [],
                  },
                ],
                processIds: [process.pid, child.pid!],
              })
              // Enumerate only the fixture owners; all references remain real
              // cwd/descriptor observations rather than synthetic evidence.
              expect(
                new Set(
                  [...evidence]
                    .filter(([, observation]) => observation.state === 'held')
                    .map(([key]) => key),
                ),
              ).toEqual(new Set(pathKind === 'known-generation' ? ['first'] : ['first', 'second']))
            } finally {
              if (child.exitCode === null && child.signalCode === null) child.stdin.end('release\n')
              expect(await exited.promise).toEqual({ code: 0, signal: null })
            }
          })
        },
      )
    }
  },
)

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
