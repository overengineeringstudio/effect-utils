import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createClosureAnalyzer } from './closure-analyzer.ts'
import type { ClosureAnalyzer, ClosureModuleAnalysis } from './closure-analyzer.ts'
import { accountSourceGraph } from './input-manifest.ts'

type SourceModule =
  Parameters<typeof accountSourceGraph>[0]['graph'] extends ReadonlyMap<string, infer TModule>
    ? TModule
    : never

const mutations = [
  ['fs import', 'import fs from "fs"', 'capability-import'],
  ['node fs import', 'import fs from "node:fs"', 'capability-import'],
  ['child process', 'export * from "child_process"', 'capability-import'],
  ['network', 'import "node:net"', 'capability-import'],
  ['workers', 'require("worker_threads")', 'capability-import'],
  ['Bun spawn', 'Bun.spawn(["echo"])', 'ambient-access'],
  ['Bun file', 'Bun.file("input")', 'ambient-access'],
  ['environment', 'process.env.MODE', 'ambient-access'],
  ['dynamic import', 'const name = "./helper.ts"; import(name)', 'dynamic-import'],
  ['eval', 'eval("1 + 1")', 'eval'],
  ['new Function', 'new Function("return 1")', 'Function'],
  ['Function call', 'Function("return 1")', 'Function'],
  ['dynamic require', 'const name = "./helper.ts"; require(name)', 'dynamic-require'],
  [
    'createRequire',
    'import { createRequire } from "node:module"; createRequire("file:///entry.ts")',
    'createRequire',
  ],
  ['computed global', 'globalThis["fetch"]', 'computed-ambient-access'],
  ['computed process', 'process["env"]', 'computed-ambient-access'],
  ['computed Bun', 'Bun["file"]', 'computed-ambient-access'],
  ['computed Deno', 'Deno["readFile"]', 'computed-ambient-access'],
  ['with', 'with ({ value: 1 }) { value }', 'with'],
  [
    'dynamic resolve',
    'const name = "./helper.ts"; import.meta.resolve(name)',
    'import-meta-resolve',
  ],
  ['WASM', 'WebAssembly.compile(new Uint8Array())', 'WebAssembly'],
  ['WASM import', 'import "./plugin.wasm"', 'native-loading'],
  ['native addon', 'require("./plugin.node")', 'native-loading'],
  ['native loader', 'process.dlopen({}, "./plugin.node")', 'ambient-access'],
  ['network global', 'fetch("https://example.invalid")', 'unknown-global'],
  ['time', 'Date.now()', 'unknown-global'],
  ['random', 'Math.random()', 'ambient-state'],
  [
    'global alias',
    'const host = globalThis; host.fetch("https://example.invalid")',
    'ambient-reference',
  ],
  [
    'constructor escape',
    'const construct = (() => {}).constructor; construct("return process")()',
    'reflection',
  ],
  ['computed escape', 'const key = "constructor"; (() => {})[key]', 'computed-access'],
  ['shorthand global', 'export const api = { fetch }', 'unknown-global'],
  [
    'declared capability',
    'declare const read: () => string; export const value = read()',
    'ambient-declaration',
  ],
  ['aliased randomness', 'const math = Math; math.random()', 'ambient-reference'],
  [
    'destructured constructor',
    'const { constructor: F } = () => {}; F("return process")()',
    'reflection',
  ],
  [
    'computed destructuring',
    'const key = "constructor"; const { [key]: F } = () => {}; F("return process")()',
    'computed-access',
  ],
  [
    'implicit global receiver',
    'function host() { return this }; host().fetch("https://example.invalid")',
    'ambient-this',
  ],
  ['computed locale', '"input"["localeCompare"]("other")', 'ambient-state'],
  [
    'sibling binding contamination',
    'function local(fetch: () => number) { return fetch() }; fetch("https://example.invalid")',
    'unknown-global',
  ],
] as const

/** Native AST acquisition is integration I/O; all fixtures share one real compiler process. */
describe('static native closure analysis', () => {
  let root: string
  let analyzer: ClosureAnalyzer
  let sequence = 0
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'genie-closure-ast-'))
    writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { allowJs: true, noEmit: true, target: 'ESNext', module: 'ESNext' },
        include: ['**/*'],
      }),
    )
    analyzer = createClosureAnalyzer({ cwd: root, cacheDirectory: false })
  })
  afterAll(async () => {
    try {
      await analyzer?.close()
    } finally {
      if (root !== undefined) rmSync(root, { recursive: true, force: true })
    }
  })
  const analyze = async (source: string, name = 'fixture.ts'): Promise<ClosureModuleAnalysis> => {
    const filename = path.join(root, `${sequence++}-${name}`)
    writeFileSync(filename, source)
    return analyzer.analyze({ source, filename })
  }

  it.each(mutations)(
    'fails closed for %s and affects only transitive importers',
    async (_name, source, operation) => {
      const analysis = await analyze(source)
      expect(analysis.reasons.some((reason) => reason.operation === operation)).toBe(true)
      const graph = new Map<string, SourceModule>([
        ['a.ts', { module: 'a.ts', children: ['shared.ts'], reasons: [] }],
        ['b.ts', { module: 'b.ts', children: ['bridge.ts'], reasons: [] }],
        ['bridge.ts', { module: 'bridge.ts', children: ['shared.ts'], reasons: [] }],
        ['peer.ts', { module: 'peer.ts', children: [], reasons: [] }],
        [
          'shared.ts',
          {
            module: 'shared.ts',
            children: [],
            reasons: analysis.reasons.map((reason) => ({
              code: 'unknown-capability',
              operation: reason.operation,
              detail: reason.detail,
              source: { module: 'shared.ts', line: reason.line },
              evidence: 'unproven',
            })),
          },
        ],
      ])
      const reasons = accountSourceGraph({
        entries: ['a.ts', 'b.ts', 'peer.ts'].map((module) => ({ module, generator: module })),
        graph,
      })
      expect(reasons.length).toBeGreaterThan(0)
      for (const reason of reasons) {
        expect(reason.code).toBe('unknown-capability')
        expect(reason.source.module).toBe('shared.ts')
        expect(reason.generators).toEqual(['a.ts', 'b.ts'])
      }
    },
  )

  it('accounts for ordinary pure code and ignores types, comments, and strings', async () => {
    expect(
      await analyze(`
      type Result = { value: number }
      // process.env, eval, and Bun.file in comments are not capabilities.
      const text = 'require(name); new Function(); fetch()'
      const double = <T extends number>(value: T): number => value * 2
      export const values: Result[] = [1, 2].map(value => ({ value: double(value) }))
      export const first = values[0]
      export const result = JSON.stringify({ text, values })
    `),
    ).toEqual({ imports: [], reasons: [] })
  })

  it('retains runtime edges and excludes every type-only import/re-export form', async () => {
    const source = [
      'import type { A } from "./types.ts"',
      'import { type B } from "./more-types.ts"',
      'export type { C } from "./export-types.ts"',
      'export { type D } from "./other-types.ts"',
      'import "./side-effect.ts"',
      'import {} from "./empty.ts"',
      'import { type T, value } from "./mixed.ts"',
      'export * from "./reexport.ts"',
      'export * as helpers from "./namespace.ts"',
      'export { value } from "./named.ts"',
      'require("./required.ts")',
      'import(`./dynamic.ts`)',
      'import alias = require("./alias.ts")',
      'import type TypeAlias = require("./type-alias.ts")',
    ].join('\n')
    const analysis = await analyze(source)
    expect(analysis.imports).toEqual([
      { path: './side-effect.ts', line: 5 },
      { path: './empty.ts', line: 6 },
      { path: './mixed.ts', line: 7 },
      { path: './reexport.ts', line: 8 },
      { path: './namespace.ts', line: 9 },
      { path: './named.ts', line: 10 },
      { path: './required.ts', line: 11 },
      { path: './dynamic.ts', line: 12 },
      { path: './alias.ts', line: 13 },
    ])
    expect(analysis.reasons).toEqual([])
  })

  it('includes literal resolver edges but rejects module-location metadata', async () => {
    const analysis = await analyze('import.meta.resolve("./helper.ts"); import.meta.url')
    expect(analysis.imports).toEqual([{ path: './helper.ts', line: 1 }])
    expect(analysis.reasons.some((reason) => reason.operation === 'import-meta')).toBe(true)
  })

  it('rejects unsupported JSX constructs instead of treating the absence of deny hits as proof', async () => {
    expect(
      (await analyze('export const view = <div />', 'view.tsx')).reasons.some(
        (reason) => reason.operation === 'unknown-syntax',
      ),
    ).toBe(true)
  })

  it('retains native parser errors as unproven syntax', async () => {
    expect(
      (await analyze('export const =')).reasons.some((reason) => reason.operation === 'syntax'),
    ).toBe(true)
  })

  it('never exempts engine or validation code and retains its source line', async () => {
    for (const filename of ['validation.ts', 'engine.ts', 'helper.ts']) {
      expect((await analyze('\nprocess.env.UNRECORDED', filename)).reasons).toContainEqual({
        operation: 'ambient-access',
        detail: 'process.env is not accounted for.',
        line: 2,
      })
    }
  })

  it('uses byte/version/grammar identity, independent of source location', async () => {
    const source = 'export const cacheIdentityFixture = 123456789'
    const first = await analyze(source, 'first.ts')
    expect(await analyze(source, 'second.ts')).toBe(first)
    expect(await analyze(`${source}; process.env.MODE`)).not.toBe(first)
    const otherVersion = createClosureAnalyzer({
      cwd: root,
      cacheDirectory: false,
      analyzerVersion: 'different-version',
    })
    const filename = path.join(root, 'version.ts')
    writeFileSync(filename, source)
    try {
      expect(await otherVersion.analyze({ source, filename })).not.toBe(first)
    } finally {
      await otherVersion.close()
    }
    expect(await analyze(source, 'different.tsx')).not.toBe(first)
  })
})
