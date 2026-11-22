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

import generatedRoots from '../nix/buck2-generated-worktree-roots.json'
import { projectResolvedCapabilities } from '../packages/@overeng/megarepo/src/buck2-capabilities/capability-projection.ts'
import { publishCapabilities } from './buck2-capability-publish.ts'

const realNixStore = process.env.NIX_STORE_BIN ?? 'nix-store'
const buck2Native = process.env.BUCK2_NATIVE_BIN
if (buck2Native === undefined) throw new Error('required declared native Buck: BUCK2_NATIVE_BIN')
const nixOperationTimeoutMs = 30_000
const startupAndCleanupMs = 2000
const nixInvocationBudgetMs = nixOperationTimeoutMs + startupAndCleanupMs
// This CLI case reroots one retained generation before the deliberately failing stop.
const publisherCliTimeoutMs = nixInvocationBudgetMs + startupAndCleanupMs
const temporaryRoots: string[] = []
let publicationInFlight: Promise<void> | undefined
const publisherCliGroups = new Set<number>()

const retirePublisherCliGroups = async () => {
  for (const pid of publisherCliGroups) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
    // spawnSync reaped the direct CLI, not its Nix descendants. As in the
    // cache-posture fixtures, only ESRCH proves the whole owned group is gone.
    // Non-child descendants expose no awaitable exit; real OS reaping cannot use fake time.
    const deadline = performance.now() + startupAndCleanupMs
    for (;;) {
      try {
        process.kill(-pid, 0)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break
        if (
          process.platform !== 'darwin' ||
          !(error instanceof Error && 'code' in error && error.code === 'EPERM')
        )
          throw error
      }
      if (performance.now() >= deadline)
        throw new Error(`Publisher CLI process group ${pid} was not reaped; preserving fixtures`)
      await Bun.sleep(10)
    }
    publisherCliGroups.delete(pid)
  }
}

describe('generated worktree roots contract', () => {
  it('matches consumer output paths and publisher generation roots without following links', () => {
    const consumer = readFileSync(
      new URL('../nix/buck2-products/consumer-root.nix', import.meta.url),
      'utf8',
    )
    const publisher = readFileSync(
      new URL('./buck2-capability-publish.ts', import.meta.url),
      'utf8',
    )
    expect(generatedRoots.schemaVersion).toBe(1)
    expect(generatedRoots.producer).toBe('effect-utils/buck2')
    expect(generatedRoots.roots.map(({ id }) => id)).toEqual([
      'buck2-rules-projection',
      'buck2-capabilities-consumer-projection',
      'buck2-capabilities-cell',
      'buck2-capabilities-legacy-projection',
      'buck2-capability-generation-roots',
    ])
    const hash = '0'.repeat(32)
    for (const entry of generatedRoots.roots) {
      expect(entry.follow).toBe('never')
      expect(entry.gcRoot).toBe(false)
      if (entry.regeneratedBy.includes('mkConsumerBuckRoot') === true) {
        expect(entry.kind).toBe('symlink-into-nix-store')
        expect(consumer).toContain(`"$out/${entry.path}"`)
        expect(consumer).toContain(`"$out/${entry.path}/"`)
        const target = new RegExp(entry.targetPattern!)
        expect(target.test(`/nix/store/${hash}-fixture-buck2-root/${entry.path}`)).toBe(true)
        expect(target.test(`/nix/store/${hash}-fix\nture-buck2-root/${entry.path}`)).toBe(false)
        expect(target.test(`/nix/store/${hash}-fix ture-buck2-root/${entry.path}`)).toBe(false)
        expect(target.test(`/nix/store/${'e'.repeat(32)}-fixture-buck2-root/${entry.path}`)).toBe(
          false,
        )
      } else {
        expect(entry.regeneratedBy).toBe('scripts/buck2-capability-publish.ts')
        expect(publisher).toContain(`join(buckDirectory, '${entry.path.slice('.buck2/'.length)}')`)
      }
    }
    const cell = generatedRoots.roots.find(({ id }) => id === 'buck2-capabilities-cell')!
    expect(cell.path).toBe('.buck2/capabilities')
    expect(cell.kind).toBe('directory')
    expect(publisher).toContain('const migrating = existing?.isSymbolicLink() === true')
    const legacy = generatedRoots.roots.find(
      ({ id }) => id === 'buck2-capabilities-legacy-projection',
    )!
    expect(legacy.path).toBe(cell.path)
    expect(legacy.kind).toBe('symlink-into-nix-store')
    const roots = generatedRoots.roots.find(({ id }) => id === 'buck2-capability-generation-roots')!
    expect(roots.path).toBe('.buck2/capability-roots')
    expect(roots.kind).toBe('directory')
    expect(roots.children?.kind).toBe('symlink-into-nix-store')
    expect(roots.children?.gcRoot).toBe('indirect')
    expect(publisher).toContain(`const generationPattern = /${roots.children?.namePattern}/u`)
    expect(publisher).toContain("['--realise', '--add-root', root, '--indirect', profile]")
    expect(roots.children?.targetPattern).toBe(legacy.targetPattern)
    const target = new RegExp(legacy.targetPattern!)
    expect(target.test(`/nix/store/${hash}-buck2-capabilities`)).toBe(true)
    expect(target.test(`/nix/store/${'e'.repeat(32)}-buck2-capabilities`)).toBe(false)
    expect(target.test(`/nix/store/${hash}-buck2-capabilities/defs.bzl`)).toBe(false)
  })
})
type PublicationFixture = {
  readonly root: string
  readonly profile: string
  readonly generation: string
  readonly tool: string
  readonly references: string
  readonly nixStore: string
}

const addToStore = ({
  path,
  nixStore,
}: {
  readonly path: string
  readonly nixStore: string
}): string => {
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
  const nixStore = join(temporaryRoot, 'nix-store-deadline')
  // The existing injectable executable still performs the real Nix operation.
  // SIGKILL bounds and reaps that operation even when it ignores termination.
  writeFileSync(
    nixStore,
    `#!${process.execPath}
import { spawnSync } from 'node:child_process'
const result = spawnSync(${JSON.stringify(realNixStore)}, process.argv.slice(2), {
  stdio: 'inherit',
  timeout: ${nixOperationTimeoutMs},
  killSignal: 'SIGKILL',
})
if (result.error !== undefined) console.error(result.error)
if (result.signal !== null) process.kill(process.pid, result.signal)
else process.exit(result.status ?? 1)
`,
    { mode: 0o700 },
  )
  mkdirSync(root)
  mkdirSync(directory)
  writeFileSync(join(directory, 'data.txt'), 'publisher recovery fixture\n')
  const storeDirectory = addToStore({ path: directory, nixStore })
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
  const profile = addToStore({ path: projection, nixStore })
  publishCapabilities({ root, profile, nixStore, buck2Native })
  const references = join(root, '.buck2', 'capability-references', `${generation}.json`)
  const tools: readonly string[] = JSON.parse(readFileSync(references, 'utf8'))
  return {
    root,
    profile,
    generation,
    tool: tools[0]!,
    references,
    nixStore,
  }
}

const realNixCases = ({
  cases,
  name,
  additionalNixOperations,
  publisherCliOperations = () => 0,
  run,
}: {
  readonly cases: readonly string[]
  readonly name: (value: string) => string
  readonly additionalNixOperations: (value: string) => number
  readonly publisherCliOperations?: (value: string) => number
  readonly run: (fixture: PublicationFixture & { readonly value: string }) => void | Promise<void>
}) => {
  // Setup always adds two paths and roots the initial publication. Registration
  // owns setup too, so no real-Nix case inherits Bun's implicit five-second limit.
  for (const value of cases)
    it(
      name(value),
      () => {
        publicationInFlight = (async () => run({ ...(await preparePublication()), value }))()
        return publicationInFlight
      },
      Math.max(
        5000,
        (3 + additionalNixOperations(value)) * nixInvocationBudgetMs +
          publisherCliOperations(value) * publisherCliTimeoutMs +
          startupAndCleanupMs,
      ),
    )
}

afterEach(async () => {
  // Bun can time out while projection awaits filesystem I/O. Join the complete
  // owning continuation (including its assertions) before removing its inputs.
  await publicationInFlight?.catch(() => undefined)
  publicationInFlight = undefined
  await retirePublisherCliGroups()
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('publisher interrupted atomic-write recovery', () => {
  realNixCases({
    cases: ['capability-references', 'capability-publications', 'capabilities', '.'],
    name: (directory) => `recovers an abandoned candidate in ${directory} before the next publication`,
    additionalNixOperations: () => 1,
    run: ({ root, profile, references, nixStore, value: directory }) => {
      const committed = readFileSync(references)
      const candidate = join(root, '.buck2', directory, `.${randomUUID()}.candidate`)
      // SIGKILL after atomicWrite writes its private candidate, before rename:
      // only the candidate exists; the committed reference file is untouched.
      writeFileSync(candidate, committed)
      expect(publishCapabilities({ root, profile, nixStore, buck2Native }).pruningDeferred).toBe(
        false,
      )
      expect(existsSync(candidate)).toBe(false)
      expect(readFileSync(references).equals(committed)).toBe(true)
    },
  })

  realNixCases({
    cases: ['notes.txt', '.not-a-uuid.candidate', `.${randomUUID()}.candidate.bak`],
    name: (name) => `keeps unknown reference entry ${name} as a hard error`,
    additionalNixOperations: () => 0,
    run: ({ root, profile, references, nixStore, value: name }) => {
      const committed = readFileSync(references)
      const unknown = join(root, '.buck2', 'capability-references', name)
      writeFileSync(unknown, 'not publisher-owned')
      expect(() => publishCapabilities({ root, profile, nixStore, buck2Native })).toThrow(
        'Invalid capability reference identity',
      )
      expect(readFileSync(unknown, 'utf8')).toBe('not publisher-owned')
      expect(readFileSync(references).equals(committed)).toBe(true)
    },
  })

  realNixCases({
    cases: ['does not unlink a symlink masquerading as an atomic-write candidate'],
    name: (name) => name,
    additionalNixOperations: () => 0,
    run: ({ root, profile, references, nixStore }) => {
      const committed = readFileSync(references)
      const candidate = join(root, '.buck2', 'capability-references', `.${randomUUID()}.candidate`)
      symlinkSync(references, candidate)
      expect(() => publishCapabilities({ root, profile, nixStore, buck2Native })).toThrow(
        'Invalid abandoned capability atomic-write candidate',
      )
      expect(existsSync(candidate)).toBe(true)
      expect(readFileSync(references).equals(committed)).toBe(true)
    },
  })
})

describe('same-generation legacy symlink migration recovery', () => {
  realNixCases({
    cases: ['upgraded-root', 'committed-references', 'migration-marker', 'daemon-stop'],
    name: (boundary) =>
      `restores tools after abort at ${boundary} without regressing the upgraded GC root`,
    // Add/root legacy: 2; aborted upgrade: 2; recovery: 2 at upgraded-root,
    // otherwise 1; idempotent publication: 1. The CLI owns its separate root.
    additionalNixOperations: (boundary) => (boundary === 'upgraded-root' ? 7 : 6),
    publisherCliOperations: (boundary) => (boundary === 'daemon-stop' ? 1 : 0),
    run: async ({ root, profile, generation, tool, references, nixStore, value: boundary }) => {
      const buck = join(root, '.buck2')
      const cell = join(buck, 'capabilities')
      const rooted = join(buck, 'capability-roots', generation)
      const legacy = join(root, '..', 'legacy')
      const legacyTool = join(legacy, 'generations', generation, ...tool.split('/').slice(1, -1))
      mkdirSync(legacyTool, { recursive: true })
      cpSync(join(profile, tool), legacyTool, { recursive: true, dereference: false })
      cpSync(join(profile, 'defs.bzl'), join(legacy, 'defs.bzl'))
      cpSync(join(profile, 'BUCK'), join(legacy, 'BUCK'))
      const legacyProfile = addToStore({ path: legacy, nixStore })
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
        expect(() =>
          publishCapabilities({ root, profile, nixStore: wrapper, buck2Native }),
        ).toThrow('Nix rooting failed')
        expect(JSON.parse(readFileSync(references, 'utf8'))).toEqual([])
      } else {
        // An unreplaceable marker aborts after roots, tools and references have
        // committed, but before the atomic cell exchange.
        mkdirSync(marker)
        expect(() => publishCapabilities({ root, profile, nixStore, buck2Native })).toThrow()
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
            '--buck2-native',
            buck2Native,
          ],
          {
            encoding: 'utf8',
            env: { ...process.env, HOME: home },
            detached: true,
            timeout: publisherCliTimeoutMs,
            killSignal: 'SIGKILL',
          },
        )
        // Do not settle the owning continuation on a mere kill request.
        if (aborted.pid > 0) publisherCliGroups.add(aborted.pid)
        try {
          await retirePublisherCliGroups()
        } catch (error) {
          if (aborted.error !== undefined)
            throw new AggregateError(
              [aborted.error, error],
              'Publisher timeout and group cleanup failed',
              { cause: aborted.error },
            )
          throw error
        }
        if (aborted.error !== undefined) throw aborted.error
        expect(aborted.status).not.toBe(0)
        expect(aborted.stderr).toContain('Buck daemon stop failed during capability cell migration')
        expect(lstatSync(cell).isDirectory()).toBe(true)
        expect(existsSync(marker)).toBe(true)
      }
      expect(publishCapabilities({ root, profile, nixStore, buck2Native }).generation).toBe(
        generation,
      )
      expect(lstatSync(cell).isDirectory()).toBe(true)
      expect(realpathSync(rooted)).toBe(profile)
      expect(readFileSync(join(cell, tool, 'manifest.json'))).toEqual(
        readFileSync(join(profile, tool, 'manifest.json')),
      )
      expect(existsSync(marker)).toBe(false)
      expect(publishCapabilities({ root, profile, nixStore, buck2Native }).generation).toBe(
        generation,
      )
    },
  })
})
