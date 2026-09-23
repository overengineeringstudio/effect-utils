import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
