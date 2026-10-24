import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { projectResolvedCapabilities } from '../packages/@overeng/megarepo/src/buck2-capabilities/capability-projection.ts'
import { publishCapabilities } from './buck2-capability-publish.ts'

const nixStore = process.env.NIX_STORE_BIN ?? 'nix-store'
const temporaryRoots: string[] = []

type PublicationFixture = {
  readonly root: string
  readonly profile: string
  readonly references: string
}

const addToStore = (path: string): string => {
  const result = spawnSync(nixStore, ['--add', path], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`Cannot add publisher fixture to Nix: ${result.stderr}`)
  return result.stdout.trim()
}

const preparePublication = async (): Promise<PublicationFixture> => {
  const scratch = join(import.meta.dir, '..', 'tmp', 'buck2-g1')
  mkdirSync(scratch, { recursive: true })
  const temporaryRoot = mkdtempSync(join(scratch, 'atomic-recovery-'))
  temporaryRoots.push(temporaryRoot)
  const root = join(temporaryRoot, 'worktree')
  const directory = join(temporaryRoot, 'data')
  const projection = join(temporaryRoot, 'projection')
  mkdirSync(root)
  mkdirSync(directory)
  writeFileSync(join(directory, 'data.txt'), 'publisher recovery fixture\n')
  const storeDirectory = addToStore(directory)
  const platform =
    process.platform === 'darwin'
      ? 'aarch64-macos'
      : process.arch === 'arm64'
        ? 'aarch64-linux'
        : 'x86_64-linux'
  const { generation } = await projectResolvedCapabilities({
    projectionPath: projection,
    platform,
    resolved: [
      {
        kind: 'directory',
        capability: {
          toolId: 'fixture-directory',
          protocol: 'fixture/v1',
          flakePackage: 'fixture-directory',
          kind: 'directory',
        },
        nixOutputPath: storeDirectory,
        closureStorePaths: [storeDirectory],
      },
    ],
  })
  const profile = addToStore(projection)
  publishCapabilities({ root, profile, nixStore })
  return {
    root,
    profile,
    references: join(root, '.buck2', 'capability-references', `${generation}.json`),
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('publisher interrupted atomic-write recovery', () => {
  it.each(['capability-references', 'capability-publications', 'capabilities', '.'])(
    'recovers an abandoned candidate in %s before the next publication',
    async (directory) => {
      const { root, profile, references } = await preparePublication()
      const committed = readFileSync(references)
      const candidate = join(root, '.buck2', directory, `.${randomUUID()}.candidate`)
      // SIGKILL after atomicWrite writes its private candidate, before rename:
      // only the candidate exists; the committed reference file is untouched.
      writeFileSync(candidate, committed)
      expect(publishCapabilities({ root, profile, nixStore }).pruningDeferred).toBe(false)
      expect(existsSync(candidate)).toBe(false)
      expect(readFileSync(references).equals(committed)).toBe(true)
    },
  )

  it.each(['notes.txt', '.not-a-uuid.candidate', `.${randomUUID()}.candidate.bak`])(
    'keeps unknown reference entry %s as a hard error',
    async (name) => {
      const { root, profile, references } = await preparePublication()
      const committed = readFileSync(references)
      const unknown = join(root, '.buck2', 'capability-references', name)
      writeFileSync(unknown, 'not publisher-owned')
      expect(() => publishCapabilities({ root, profile, nixStore })).toThrow(
        'Invalid capability reference identity',
      )
      expect(readFileSync(unknown, 'utf8')).toBe('not publisher-owned')
      expect(readFileSync(references).equals(committed)).toBe(true)
    },
  )

  it('does not unlink a symlink masquerading as an atomic-write candidate', async () => {
    const { root, profile, references } = await preparePublication()
    const committed = readFileSync(references)
    const candidate = join(root, '.buck2', 'capability-references', `.${randomUUID()}.candidate`)
    symlinkSync(references, candidate)
    expect(() => publishCapabilities({ root, profile, nixStore })).toThrow(
      'Invalid abandoned capability atomic-write candidate',
    )
    expect(existsSync(candidate)).toBe(true)
    expect(readFileSync(references).equals(committed)).toBe(true)
  })
})
