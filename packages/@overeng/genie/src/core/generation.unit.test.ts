import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  addHeaderComment,
  getHeaderComment,
  loadGenieFile,
  pinStagedModuleIdentity,
} from './generation.ts'

type ConcurrencyBoundary = {
  enter: () => Promise<void>
  releaseAll: () => void
  releaseNext: () => void
  waitForEntries: (count: number) => Promise<void>
  readonly maxOverlap: number
}

const makeConcurrencyBoundary = (): ConcurrencyBoundary => {
  let active = 0
  let entries = 0
  let maxOverlap = 0
  const releases: Array<() => void> = []
  const entryWaiters = new Map<number, Array<() => void>>()

  return {
    enter: async () => {
      active += 1
      entries += 1
      maxOverlap = Math.max(maxOverlap, active)
      for (const resolve of entryWaiters.get(entries) ?? []) resolve()
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
    },
    releaseNext: () => releases.shift()?.(),
    releaseAll: () => {
      for (const release of releases.splice(0)) release()
    },
    waitForEntries: (count) => {
      if (entries >= count) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const waiters = entryWaiters.get(count) ?? []
        waiters.push(resolve)
        entryWaiters.set(count, waiters)
      })
    },
    get maxOverlap() {
      return maxOverlap
    },
  }
}

const generatorModule = {
  default: { data: {}, stringify: () => '{}' },
}

const load = ({
  cwd,
  genieFilePath,
  compiledBinaryImportGraphLoader,
}: {
  cwd: string
  genieFilePath: string
  compiledBinaryImportGraphLoader?: () => Effect.Effect<typeof generatorModule>
}) =>
  Effect.runPromise(
    loadGenieFile({ cwd, genieFilePath, compiledBinaryImportGraphLoader }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  )

describe('compiled binary import graph scheduling', () => {
  it('serializes concurrent loadGenieFile staging and builds in compiled binaries', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'genie-compiled-concurrency-'))
    const originalArgv1 = process.argv[1]
    const boundary = makeConcurrencyBoundary()
    let scheduled = 0
    let signalBothScheduled: (() => void) | undefined
    const bothScheduled = new Promise<void>((resolve) => {
      signalBothScheduled = resolve
    })
    const compiledBinaryImportGraphLoader = () => {
      scheduled += 1
      if (scheduled === 2) signalBothScheduled?.()
      return Effect.promise(() => boundary.enter()).pipe(Effect.as(generatorModule))
    }
    const firstPath = path.join(tempRoot, 'first.json.genie.ts')
    const secondPath = path.join(tempRoot, 'second.json.genie.ts')
    await Promise.all([writeFile(firstPath, ''), writeFile(secondPath, '')])

    process.argv[1] = '/$bunfs/genie'
    try {
      const first = load({
        cwd: tempRoot,
        genieFilePath: firstPath,
        compiledBinaryImportGraphLoader,
      })
      const second = load({
        cwd: tempRoot,
        genieFilePath: secondPath,
        compiledBinaryImportGraphLoader,
      })
      await bothScheduled
      await boundary.waitForEntries(1)

      expect(boundary.maxOverlap).toBe(1)

      boundary.releaseNext()
      await boundary.waitForEntries(2)
      boundary.releaseNext()
      await Promise.all([first, second])
      expect(boundary.maxOverlap).toBe(1)
    } finally {
      boundary.releaseAll()
      if (originalArgv1 === undefined) process.argv.splice(1, 1)
      else process.argv[1] = originalArgv1
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('keeps concurrent loadGenieFile imports unbounded outside compiled binaries', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'genie-source-concurrency-'))
    const originalArgv1 = process.argv[1]
    const boundary = makeConcurrencyBoundary()
    const boundaryKey = `__genieConcurrencyBoundary${Date.now()}`
    const globals = globalThis as typeof globalThis & Record<string, unknown>
    const source = [
      `await (globalThis as typeof globalThis & Record<string, { enter: () => Promise<void> }>)[${JSON.stringify(boundaryKey)}]!.enter()`,
      `export default { data: {}, stringify: () => '{}' }`,
    ].join('\n')
    const firstPath = path.join(tempRoot, 'first.json.genie.ts')
    const secondPath = path.join(tempRoot, 'second.json.genie.ts')
    globals[boundaryKey] = boundary
    await Promise.all([writeFile(firstPath, source), writeFile(secondPath, source)])

    process.argv[1] = '/usr/bin/genie.ts'
    try {
      const first = load({ cwd: tempRoot, genieFilePath: firstPath })
      const second = load({ cwd: tempRoot, genieFilePath: secondPath })

      await boundary.waitForEntries(2)
      expect(boundary.maxOverlap).toBe(2)

      boundary.releaseNext()
      boundary.releaseNext()
      await Promise.all([first, second])
    } finally {
      boundary.releaseAll()
      if (originalArgv1 === undefined) process.argv.splice(1, 1)
      else process.argv[1] = originalArgv1
      delete globals[boundaryKey]
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})

describe('compiled binary import graph pile-cache isolation', () => {
  it('stages a new member pin beyond the key of a seeded old-pin transform', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'genie-pile-cache-'))
    const oldMemberRoot = path.join(tempRoot, 'members/old')
    const newMemberRoot = path.join(tempRoot, 'members/new')
    const entryPath = path.join(tempRoot, 'project/config.genie.ts')
    const bunHome = path.join(tempRoot, 'bun-home')
    const runnerPath = path.join(
      process.cwd(),
      `.genie-pile-cache-runner-${Date.now().toString()}.ts`,
    )
    const stagingRoots: string[] = []
    const stagedPathFor = (sourcePath: string, stageRoot: string) =>
      path.join(stageRoot, sourcePath.replace(/^(?:[A-Za-z]:)?[\\/]+/, ''))
    const pileKey = (sourceCode: string) => createHash('sha256').update(sourceCode).digest('hex')
    const stage = (memberRoot: string): { tempRoot: string; value: string } => {
      const output = execFileSync('bun', [runnerPath, entryPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          BUN_INSTALL: path.join(bunHome, '.bun'),
          GENIE_MEMBER_OVERRIDE_MAP: JSON.stringify({ member: memberRoot }),
          HOME: bunHome,
        },
      })
      return JSON.parse(output) as { tempRoot: string; value: string }
    }

    try {
      await Promise.all([
        mkdir(oldMemberRoot, { recursive: true }),
        mkdir(newMemberRoot, { recursive: true }),
        mkdir(path.dirname(entryPath), { recursive: true }),
        mkdir(bunHome, { recursive: true }),
      ])
      await writeFile(
        runnerPath,
        [
          `import { NodeServices } from '@effect/platform-node'`,
          `import { Effect } from 'effect'`,
          `import { pathToFileURL } from 'node:url'`,
          `import { stageCompiledBinaryImportGraph } from './src/core/generation.ts'`,
          `const entryPath = process.argv[2]`,
          `if (entryPath === undefined) throw new Error('Expected an entry path')`,
          `const staged = await Effect.runPromise(stageCompiledBinaryImportGraph({ entryPath }).pipe(Effect.provide(NodeServices.layer)))`,
          `const loaded = await import(\`${'${'}pathToFileURL(staged.stagePath).href}?import=${'${'}Date.now()}\`)`,
          `console.log(JSON.stringify({ tempRoot: staged.tempRoot, value: loaded.default.value }))`,
          '',
        ].join('\n'),
      )
      const carrierSource = [
        `import { label } from './label.ts'`,
        `export const value = label`,
        '',
      ].join('\n')
      await Promise.all([
        writeFile(path.join(oldMemberRoot, 'label.ts'), `export const label = 'old'\n`),
        writeFile(path.join(newMemberRoot, 'label.ts'), `export const label = 'new'\n`),
        writeFile(path.join(oldMemberRoot, 'mod.ts'), carrierSource),
        writeFile(path.join(newMemberRoot, 'mod.ts'), carrierSource),
        writeFile(
          entryPath,
          [`import { value } from '#mr/member/mod.ts'`, `export default { value }`, ''].join('\n'),
        ),
      ])

      const oldPin = stage(oldMemberRoot)
      stagingRoots.push(oldPin.tempRoot)
      const oldStagedCarrier = await readFile(
        stagedPathFor(path.join(oldMemberRoot, 'mod.ts'), oldPin.tempRoot),
        'utf8',
      )
      const seededPileCache = new Map([[pileKey(oldStagedCarrier), 'old-pin transform']])

      const newPin = stage(newMemberRoot)
      stagingRoots.push(newPin.tempRoot)
      const newStagedCarrier = await readFile(
        stagedPathFor(path.join(newMemberRoot, 'mod.ts'), newPin.tempRoot),
        'utf8',
      )
      const newStagedEntry = await readFile(stagedPathFor(entryPath, newPin.tempRoot), 'utf8')

      expect(seededPileCache.get(pileKey(newStagedCarrier))).toBeUndefined()
      expect(newStagedEntry).toMatch(/from ['"]\.\.\/members\/new\/mod\.ts['"]/)
      expect(newStagedEntry).not.toContain(newMemberRoot)
      expect(newPin.value).toBe('new')
    } finally {
      await Promise.all([
        rm(runnerPath, { force: true }),
        ...stagingRoots.map((stagingRoot) => rm(stagingRoot, { recursive: true, force: true })),
        rm(tempRoot, { recursive: true, force: true }),
      ])
    }
  }, 120_000)
})

describe('compiled binary import graph staging', () => {
  it('leaves an entry-level non-analyzable #mr import to the absolute-path rewrite', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'genie-staging-json-member-'))
    const memberRoot = path.join(tempRoot, 'members/json-member')
    const entryPath = path.join(tempRoot, 'project/config.genie.ts')
    const bunHome = path.join(tempRoot, 'bun-home')
    const runnerPath = path.join(
      process.cwd(),
      `.genie-staging-json-member-runner-${Date.now().toString()}.ts`,
    )
    const stagingRoots: string[] = []
    const stagedPathFor = (sourcePath: string, stageRoot: string) =>
      path.join(stageRoot, sourcePath.replace(/^(?:[A-Za-z]:)?[\\/]+/, ''))
    const stage = (): { tempRoot: string; value: string } => {
      const output = execFileSync('bun', [runnerPath, entryPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          BUN_INSTALL: path.join(bunHome, '.bun'),
          GENIE_MEMBER_OVERRIDE_MAP: JSON.stringify({ member: memberRoot }),
          HOME: bunHome,
        },
      })
      return JSON.parse(output) as { tempRoot: string; value: string }
    }

    try {
      await Promise.all([
        mkdir(memberRoot, { recursive: true }),
        mkdir(path.dirname(entryPath), { recursive: true }),
        mkdir(bunHome, { recursive: true }),
      ])
      await writeFile(
        runnerPath,
        [
          `import { NodeServices } from '@effect/platform-node'`,
          `import { Effect } from 'effect'`,
          `import { pathToFileURL } from 'node:url'`,
          `import { stageCompiledBinaryImportGraph } from './src/core/generation.ts'`,
          `const entryPath = process.argv[2]`,
          `if (entryPath === undefined) throw new Error('Expected an entry path')`,
          `const staged = await Effect.runPromise(stageCompiledBinaryImportGraph({ entryPath }).pipe(Effect.provide(NodeServices.layer)))`,
          `const loaded = await import(\`${'${'}pathToFileURL(staged.stagePath).href}?import=${'${'}Date.now()}\`)`,
          `console.log(JSON.stringify({ tempRoot: staged.tempRoot, value: loaded.default.value }))`,
          '',
        ].join('\n'),
      )
      await Promise.all([
        writeFile(
          path.join(memberRoot, 'data.json'),
          `${JSON.stringify({ value: 'json-member' })}\n`,
        ),
        writeFile(
          entryPath,
          [
            `import data from '#mr/member/data.json'`,
            `export default { value: data.value }`,
            '',
          ].join('\n'),
        ),
      ])

      const staged = stage()
      stagingRoots.push(staged.tempRoot)
      const stagedEntry = await readFile(stagedPathFor(entryPath, staged.tempRoot), 'utf8')

      expect(staged.value).toBe('json-member')
      expect(stagedEntry).toContain(path.join(memberRoot, 'data.json'))
    } finally {
      await Promise.all([
        rm(runnerPath, { force: true }),
        ...stagingRoots.map((stagingRoot) => rm(stagingRoot, { recursive: true, force: true })),
        rm(tempRoot, { recursive: true, force: true }),
      ])
    }
  }, 120_000)

  it('removes the staging root when staging fails', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'genie-staging-failure-'))
    const entryPath = path.join(tempRoot, 'project/config.genie.ts')
    const bunHome = path.join(tempRoot, 'bun-home')
    const stagingTmp = path.join(tempRoot, 'staging-tmp')
    const runnerPath = path.join(
      process.cwd(),
      `.genie-staging-failure-runner-${Date.now().toString()}.ts`,
    )

    try {
      await Promise.all([
        mkdir(path.dirname(entryPath), { recursive: true }),
        mkdir(bunHome, { recursive: true }),
        mkdir(stagingTmp, { recursive: true }),
      ])
      await writeFile(
        runnerPath,
        [
          `import { NodeServices } from '@effect/platform-node'`,
          `import { Effect } from 'effect'`,
          `import { stageCompiledBinaryImportGraph } from './src/core/generation.ts'`,
          `const entryPath = process.argv[2]`,
          `if (entryPath === undefined) throw new Error('Expected an entry path')`,
          `const exit = await Effect.runPromiseExit(stageCompiledBinaryImportGraph({ entryPath }).pipe(Effect.provide(NodeServices.layer)))`,
          `console.log(JSON.stringify({ succeeded: exit._tag === 'Success' }))`,
          '',
        ].join('\n'),
      )
      await writeFile(
        entryPath,
        [
          // A specifier that resolves nowhere fails the bundle after the staging root exists,
          // which is exactly the window whose cleanup this regression pins.
          `import { missing } from './missing.ts'`,
          `export default { value: missing }`,
          '',
        ].join('\n'),
      )

      const output = execFileSync('bun', [runnerPath, entryPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          BUN_INSTALL: path.join(bunHome, '.bun'),
          HOME: bunHome,
          TMPDIR: stagingTmp,
        },
      })

      expect(JSON.parse(output)).toEqual({ succeeded: false })
      const stagingLeftovers = (await readdir(stagingTmp)).filter((entry) =>
        entry.startsWith('genie-import-'),
      )
      expect(stagingLeftovers).toEqual([])
    } finally {
      await Promise.all([
        rm(runnerPath, { force: true }),
        rm(tempRoot, { recursive: true, force: true }),
      ])
    }
  }, 120_000)
})

describe('getHeaderComment', () => {
  it.each(['BUCK', 'defs.bzl', 'tooling.bxl'])(
    'uses Starlark comments for %s',
    (targetFilePath) => {
      expect(
        getHeaderComment({
          targetFilePath,
          sourceFile: `${targetFilePath}.genie.ts`,
        }),
      ).toBe(`# Generated file - DO NOT EDIT\n# Source: ${targetFilePath}.genie.ts\n\n`)
    },
  )

  it('uses Buck config comments for .buckconfig', () => {
    expect(
      getHeaderComment({
        targetFilePath: '.buckconfig',
        sourceFile: '.buckconfig.genie.ts',
      }),
    ).toBe('# Generated file - DO NOT EDIT\n# Source: .buckconfig.genie.ts\n\n')
  })

  it('uses Nix comments for Nix expressions', () => {
    expect(
      getHeaderComment({
        targetFilePath: 'nix/buck2-products/from-source-products.nix',
        sourceFile: 'from-source-products.nix.genie.ts',
      }),
    ).toBe('# Generated file - DO NOT EDIT\n# Source: from-source-products.nix.genie.ts\n\n')
  })

  it('uses shell comments for shell scripts', () => {
    expect(
      getHeaderComment({
        targetFilePath: 'genie/ci-scripts/run-with-nix-gc-race-retry.sh',
        sourceFile: 'run-with-nix-gc-race-retry.sh.genie.ts',
      }),
    ).toBe('# Generated file - DO NOT EDIT\n# Source: run-with-nix-gc-race-retry.sh.genie.ts\n\n')
  })
})

describe('getExpectedContent', () => {
  it('keeps shell shebangs before generated provenance', () => {
    expect(
      addHeaderComment({
        header: '# Generated file - DO NOT EDIT\n# Source: run.sh.genie.ts\n\n',
        content: '#!/usr/bin/env bash\nexit 0\n',
      }),
    ).toBe(
      [
        '#!/usr/bin/env bash',
        '# Generated file - DO NOT EDIT',
        '# Source: run.sh.genie.ts',
        '',
        'exit 0',
        '',
      ].join('\n'),
    )
  })

  it('keeps non-shell shebangs before generated provenance', () => {
    // A hashbang is only legal as the very first bytes of a file, so a banner emitted ahead of it
    // turns a `.mjs` into a SyntaxError rather than merely mis-executing it.
    expect(
      addHeaderComment({
        header: '// Generated file - DO NOT EDIT\n// Source: tool.mjs.genie.ts\n',
        content: '#!/usr/bin/env node\nexport const run = () => {}\n',
      }),
    ).toBe(
      [
        '#!/usr/bin/env node',
        '// Generated file - DO NOT EDIT',
        '// Source: tool.mjs.genie.ts',
        'export const run = () => {}',
        '',
      ].join('\n'),
    )
  })

  it('prepends the banner when there is no shebang', () => {
    expect(
      addHeaderComment({
        header: '// Generated file - DO NOT EDIT\n// Source: mod.ts.genie.ts\n',
        content: 'export const x = 1\n',
      }),
    ).toBe('// Generated file - DO NOT EDIT\n// Source: mod.ts.genie.ts\nexport const x = 1\n')
  })
})

describe('pinStagedModuleIdentity', () => {
  let tempRoot = ''

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'genie-pin-identity-'))
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  const identitySourcePath = () => path.join(tempRoot, 'generators/identity.json.genie.ts')
  const pin = async (
    sourceCode: string,
    sourcePath: string = identitySourcePath(),
  ): Promise<string> => {
    await mkdir(path.dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, sourceCode)
    return pinStagedModuleIdentity({ sourceCode, sourcePath })
  }

  it('pins each identity field to the original source location', async () => {
    const sourcePath = identitySourcePath()
    expect(await pin('export const id = import.meta.url')).toBe(
      `export const id = ${JSON.stringify(pathToFileURL(sourcePath).href)}`,
    )
    expect(await pin('export const dir = import.meta.dirname')).toBe(
      `export const dir = ${JSON.stringify(path.dirname(sourcePath))}`,
    )
    expect(await pin('export const file = import.meta.filename')).toBe(
      `export const file = ${JSON.stringify(sourcePath)}`,
    )
  })

  it('pins accesses written with arbitrary whitespace and interleaved comments', async () => {
    const sourcePath = identitySourcePath()
    expect(await pin('export const id = import\n  . meta\n  . url')).toBe(
      `export const id = ${JSON.stringify(pathToFileURL(sourcePath).href)}`,
    )
    expect(await pin('export const dir = import . /* here */ meta . dirname')).toBe(
      `export const dir = ${JSON.stringify(path.dirname(sourcePath))}`,
    )
  })

  it('leaves comments and string literals byte-identical', async () => {
    // Genie generates TypeScript, so a generator legitimately documents or emits the very text
    // being pinned. A textual rewrite corrupts exactly these bytes.
    const sourceCode = [
      '// derives identity from import.meta.url',
      '/* also import . meta . dirname */',
      `const emitted = "const here = import.meta.filename"`,
      "const single = 'import.meta.url'",
      'const template = `emits import.meta.dirname verbatim`',
      'export const emit = () => [emitted, single, template]',
    ].join('\n')

    expect(await pin(sourceCode)).toBe(sourceCode)
  })

  it('pins interpolations inside a template literal without touching its raw text', async () => {
    const sourcePath = identitySourcePath()
    expect(await pin('const t = `import.meta.url is ${import.meta.url}`')).toBe(
      `const t = \`import.meta.url is \${${JSON.stringify(pathToFileURL(sourcePath).href)}}\``,
    )
  })

  it('leaves other import.meta members and same-named property accesses alone', async () => {
    const sourceCode = [
      'const resolved = import.meta.resolve("./sibling.ts")',
      'const shadowed = { url: 1 }.url',
      'const meta = import.meta',
    ].join('\n')

    expect(await pin(sourceCode)).toBe(sourceCode)
  })

  it('returns the input unchanged when there is no identity access', async () => {
    const sourceCode = 'export const value = 1\n'
    expect(await pin(sourceCode)).toBe(sourceCode)
  })

  it('pins identity in TSX sources', async () => {
    const sourcePath = path.join(tempRoot, 'generators/view.genie.tsx')
    expect(await pin('export const view = () => <div title={import.meta.url} />', sourcePath)).toBe(
      `export const view = () => <div title={${JSON.stringify(pathToFileURL(sourcePath).href)}} />`,
    )
  })
})
