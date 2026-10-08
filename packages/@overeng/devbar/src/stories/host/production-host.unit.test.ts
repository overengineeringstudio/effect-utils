// @vitest-environment node
import react from '@vitejs/plugin-react'
import { build, type Plugin } from 'vite'
import { describe, expect, it } from 'vitest'

import { createStylexVitePlugins } from '@overeng/utils/node/stylex'

const packageRoot = new URL('../../..', import.meta.url).pathname
const fixtureEntry = new URL('./fixture-entry.ts', import.meta.url).pathname
const diagnosticModule =
  /\/@overeng\/(?:devbar\/(?!(?:[^?#]*\/)?src\/stories\/)|meters\/|rpc-devtools\/|effect-rpc-(?:explorer(?:-react)?|observer)\/)/
const diagnosticReference =
  /(?:@overeng\/(?:devbar|meters|rpc-devtools|effect-rpc-(?:explorer(?:-react)?|observer))|devtools[-.]|Host\.LoadProject|child_fibers_active)/

interface EmittedChunk {
  readonly fileName: string
  readonly modules: readonly string[]
  readonly imports: readonly string[]
  readonly dynamicImports: readonly string[]
  readonly code: string
  readonly isEntry: boolean
}

// Inspect the actual generated chunk graph, not a source grep or bundle-size heuristic.
const buildHost = async (diagnostics: boolean): Promise<readonly EmittedChunk[]> => {
  const chunks: EmittedChunk[] = []
  const graph: Plugin = {
    name: 'host-diagnostic-conformance-graph',
    configResolved: (config) => {
      expect(config.mode).toBe('production')
      expect(config.isProduction).toBe(true)
      expect(config.env.DEV).toBe(false)
      expect(config.env.PROD).toBe(true)
    },
    // oxlint-disable-next-line overeng/named-args -- Vite plugin callback shape.
    generateBundle: (_options, bundle) => {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        chunks.push({
          fileName: output.fileName,
          modules: Object.keys(output.modules).map((id) => id.replaceAll('\\', '/')),
          imports: output.imports,
          dynamicImports: output.dynamicImports,
          code: output.code,
          isEntry: output.isEntry,
        })
      }
    },
  }
  // Vitest sets NODE_ENV=test; Vite derives DEV/PROD from NODE_ENV, not its mode.
  const previousNodeEnv = process.env['NODE_ENV']
  process.env['NODE_ENV'] = 'production'
  try {
    await build({
      root: packageRoot,
      configFile: false,
      mode: 'production',
      logLevel: 'silent',
      plugins: [createStylexVitePlugins({ entries: [fixtureEntry] }), react(), graph],
      define: {
        'import.meta.env.VITE_HOST_DIAGNOSTICS': JSON.stringify(
          diagnostics === true ? 'true' : 'false',
        ),
      },
      build: {
        write: false,
        minify: false,
        modulePreload: false,
        rolldownOptions: {
          input: fixtureEntry,
          output: { entryFileNames: 'host.js', chunkFileNames: '[name]-[hash].js' },
        },
      },
    })
  } finally {
    if (previousNodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = previousNodeEnv
  }
  return chunks
}

const staticClosure = (options: {
  readonly chunks: readonly EmittedChunk[]
  readonly entry: EmittedChunk
}): Set<string> => {
  const visited = new Set<string>()
  const pending = [options.entry.fileName]
  while (pending.length > 0) {
    const name = pending.pop()!
    if (visited.has(name) === true) continue
    visited.add(name)
    const chunk = options.chunks.find((candidate) => candidate.fileName === name)
    if (chunk !== undefined) pending.push(...chunk.imports)
  }
  return visited
}

describe('production host enabling boundary', () => {
  it('emits no diagnostic modules, chunks, code or dynamic-import references with the flag off', async () => {
    const chunks = await buildHost(false)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.isEntry).toBe(true)
    expect(
      chunks.flatMap((chunk) => chunk.modules).filter((id) => diagnosticModule.test(id)),
    ).toEqual([])
    expect(chunks.flatMap((chunk) => chunk.dynamicImports)).toEqual([])
    for (const chunk of chunks) {
      expect(chunk.code).not.toMatch(diagnosticReference)
      expect(chunk.code).not.toMatch(/\bimport\s*\(/)
      expect(chunk.fileName).not.toMatch(/devtools/)
    }
  }, 120_000)

  it('detects the real diagnostic chunk in an explicitly enabled production build and keeps explorer UI lazy', async () => {
    const chunks = await buildHost(true)
    const modules = chunks.flatMap((chunk) => chunk.modules)
    // Positive controls for every package prevent an accidentally disconnected fixture from passing.
    for (const name of [
      'devbar',
      'meters',
      'rpc-devtools',
      'effect-rpc-explorer',
      'effect-rpc-observer',
      'effect-rpc-explorer-react',
    ]) {
      expect(modules.some((id) => id.includes(`/@overeng/${name}/`))).toBe(true)
    }
    expect(modules.filter((id) => diagnosticModule.test(id)).length).toBeGreaterThan(0)
    const diagnosticChunk = chunks.find((chunk) =>
      chunk.modules.some((id) => id.endsWith('/stories/host/devtools.tsx')),
    )
    expect(diagnosticChunk).toBeDefined()
    expect(chunks.flatMap((chunk) => chunk.dynamicImports)).toContain(diagnosticChunk!.fileName)

    // Theme tokens may be eager; the explorer component itself must remain behind the panel loader.
    // Buck inserts __package_tree__/package_tree between package identity and src.
    const explorerChunk = chunks.find((chunk) =>
      chunk.modules.some(
        (id) =>
          id.includes('/@overeng/effect-rpc-explorer-react/') === true &&
          id.endsWith('/src/RpcExplorer.tsx') === true,
      ),
    )
    expect(
      explorerChunk,
      JSON.stringify(
        chunks.map((chunk) => ({
          fileName: chunk.fileName,
          dynamicImports: chunk.dynamicImports,
          explorerModules: chunk.modules.filter((id) => id.includes('/effect-rpc-explorer-react/')),
        })),
      ),
    ).toBeDefined()
    expect(staticClosure({ chunks, entry: diagnosticChunk! }).has(explorerChunk!.fileName)).toBe(
      false,
    )
    expect(chunks.flatMap((chunk) => chunk.dynamicImports)).toContain(explorerChunk!.fileName)
  }, 120_000)
})
