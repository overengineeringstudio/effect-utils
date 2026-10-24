import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  readonly generation: string
  readonly tool: string
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
  const references = join(root, '.buck2', 'capability-references', `${generation}.json`)
  const tools: readonly string[] = JSON.parse(readFileSync(references, 'utf8'))
  return {
    root,
    profile,
    generation,
    tool: tools[0]!,
    references,
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

describe('same-generation legacy symlink migration recovery', () => {
  it.each(['upgraded-root', 'committed-references', 'migration-marker', 'daemon-stop'])(
    'restores tools after abort at %s without regressing the upgraded GC root',
    async (boundary) => {
      const { root, profile, generation, tool, references } = await preparePublication()
      const buck = join(root, '.buck2')
      const cell = join(buck, 'capabilities')
      const rooted = join(buck, 'capability-roots', generation)
      const legacy = join(root, '..', 'legacy')
      const legacyTool = join(legacy, 'generations', generation, ...tool.split('/').slice(1, -1))
      mkdirSync(legacyTool, { recursive: true })
      cpSync(join(profile, tool), legacyTool, { recursive: true, dereference: false })
      cpSync(join(profile, 'defs.bzl'), join(legacy, 'defs.bzl'))
      cpSync(join(profile, 'BUCK'), join(legacy, 'BUCK'))
      const legacyProfile = addToStore(legacy)
      rmSync(cell, { recursive: true })
      symlinkSync(legacyProfile, cell)
      rmSync(rooted)
      const legacyRoot = spawnSync(
        nixStore,
        ['--realise', '--add-root', rooted, '--indirect', legacyProfile],
        { encoding: 'utf8' },
      )
      expect(legacyRoot.status).toBe(0)
      rmSync(references)
      rmSync(join(buck, 'capability-publications', `${generation}.json`))

      const marker = join(buck, 'capabilities.migration')
      if (boundary === 'upgraded-root') {
        // Run the real Nix operation, then report failure immediately after it
        // upgrades the root, before tool installation or reference publication.
        const wrapper = join(root, '..', 'abort-after-root')
        writeFileSync(
          wrapper,
          `#!/bin/sh\n${JSON.stringify(nixStore)} "$@" || exit "$?"\nfor arg do\n  if [ "$arg" = ${JSON.stringify(profile)} ]; then exit 73; fi\ndone\n`,
          { mode: 0o755 },
        )
        expect(() => publishCapabilities({ root, profile, nixStore: wrapper })).toThrow(
          'Nix rooting failed',
        )
        expect(JSON.parse(readFileSync(references, 'utf8'))).toEqual([])
      } else {
        // An unreplaceable marker aborts after roots, tools and references have
        // committed, but before the atomic cell exchange.
        mkdirSync(marker)
        expect(() => publishCapabilities({ root, profile, nixStore })).toThrow()
        expect(JSON.parse(readFileSync(references, 'utf8'))).toEqual([tool])
        rmSync(marker, { recursive: true })
        if (boundary === 'migration-marker') writeFileSync(marker, 'symlink-to-directory\n')
      }
      expect(lstatSync(cell).isSymbolicLink()).toBe(true)
      expect(realpathSync(rooted)).toBe(profile)
      expect(existsSync(join(cell, tool))).toBe(false)
      if (boundary === 'daemon-stop') {
        // Abort after the exchange and defs publication at the lifecycle stop.
        // Isolate Buck's state in HOME; no actual Buck process is started.
        const home = join(root, '..', 'home')
        mkdirSync(join(home, '.buck', 'buckd', realpathSync(root).replace(/^\//u, ''), 'fixture'), {
          recursive: true,
        })
        const failStop = join(root, '..', 'fail-stop')
        writeFileSync(failStop, '#!/bin/sh\nexit 73\n', { mode: 0o755 })
        const aborted = spawnSync(
          process.execPath,
          [
            join(import.meta.dir, 'buck2-capability-publish.ts'),
            '--root',
            root,
            '--profile',
            profile,
            '--nix-store',
            nixStore,
            '--buck2',
            failStop,
          ],
          { encoding: 'utf8', env: { ...process.env, HOME: home } },
        )
        expect(aborted.status).not.toBe(0)
        expect(aborted.stderr).toContain('Buck daemon stop failed during capability cell migration')
        expect(lstatSync(cell).isDirectory()).toBe(true)
        expect(existsSync(marker)).toBe(true)
      }
      expect(publishCapabilities({ root, profile, nixStore }).generation).toBe(generation)
      expect(lstatSync(cell).isDirectory()).toBe(true)
      expect(realpathSync(rooted)).toBe(profile)
      expect(readFileSync(join(cell, tool, 'manifest.json'))).toEqual(
        readFileSync(join(profile, tool, 'manifest.json')),
      )
      expect(existsSync(marker)).toBe(false)
      expect(publishCapabilities({ root, profile, nixStore }).generation).toBe(generation)
    },
  )
})
