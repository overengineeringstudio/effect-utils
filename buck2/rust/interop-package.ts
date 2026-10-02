import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// This action is run by the admitted Bun capability; all child tools are immutable Nix paths.
const [kind, ...arguments_] = process.argv.slice(2)
const options = new Map<string, string>()
for (let index = 0; index < arguments_.length; index += 2) {
  const key = arguments_[index]
  const value = arguments_[index + 1]
  if (key === undefined || value === undefined || key.startsWith('--') === false) {
    throw new Error('Expected --key value action arguments')
  }
  options.set(key.slice(2), value)
}
const required = (key: string): string => {
  const value = options.get(key)
  if (value === undefined) throw new Error(`Missing action argument: ${key}`)
  return value
}
const run = ({
  binary,
  args,
}: {
  readonly binary: string
  readonly args: readonly string[]
}): void => {
  if (binary.startsWith('/nix/store/') === false)
    throw new Error(`Tool is not an immutable capability: ${binary}`)
  const result = spawnSync(binary, args, { stdio: 'inherit', env: process.env })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${binary} exited with ${result.status}`)
}
const output = required('output')
const input = required('input')
const name = required('name')
if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) === false)
  throw new Error(`Invalid bindgen output name: ${name}`)
await mkdir(output, { recursive: true })

type WireArgument = { readonly name: string; readonly type: string }
type ExportError = { readonly name: string; readonly tagKey: string }
type Export = {
  readonly name: string
  readonly rustName: string
  readonly mode: 'sync' | 'async' | 'input_stream' | 'output_stream' | 'borrowed' | 'frame'
  readonly args: readonly WireArgument[]
  readonly returns: string
  readonly error: ExportError | null
  /** JS name of the product's schemars record function for serde domain positions. */
  readonly schema?: string
}
type ErrorDefinition = ExportError & {
  readonly variants: readonly { readonly name: string; readonly fields: readonly WireArgument[] }[]
}

// The proc macro emits these records into a wasm custom section/native exported
// static. Extract before optimizing: wasm-opt may legitimately strip custom sections.
const binary = await readFile(input)
const records = <T>(sentinel: string): T[] => {
  const prefix = Buffer.from(`\0${sentinel}\0`)
  const found: T[] = []
  // The same used static can appear in both wasm data and its custom section.
  const seen = new Set<string>()
  let offset = 0
  while ((offset = binary.indexOf(prefix, offset)) !== -1) {
    offset += prefix.length
    const end = binary.indexOf(0, offset)
    if (end === -1) throw new Error(`Unterminated ${sentinel} manifest record`)
    const json = binary.subarray(offset, end).toString('utf8')
    if (seen.has(json) === false) {
      seen.add(json)
      found.push(JSON.parse(json) as T)
    }
    offset = end + 1
  }
  return found
}
type EmbeddedExport = Omit<Export, 'error'> & {
  readonly error: (ExportError & { readonly tagKeySource: 'explicit' | 'default' }) | null
}
const embeddedExports = records<EmbeddedExport>('EFFECT_RUST_EXPORT')
const errors = records<ErrorDefinition>('EFFECT_RUST_ERROR')
const manifestExports: Export[] = embeddedExports.map((entry) => {
  if (entry.error === null) return entry
  const definition = errors.find((error) => error.name === entry.error!.name)
  if (definition === undefined)
    throw new Error(
      `Missing ExportError metadata for ${entry.error.name}; derive effect_rust::ExportError`,
    )
  if (entry.error.tagKeySource === 'explicit' && definition.tagKey !== entry.error.tagKey) {
    throw new Error(`Export error tag differs from serde enum ${entry.error.name}`)
  }
  return Object.assign({}, entry, { error: { name: entry.error.name, tagKey: definition.tagKey } })
})
if (manifestExports.length === 0)
  throw new Error('Interop crate contains no effect-rust macro export manifest')
manifestExports.sort((left, right) => left.name.localeCompare(right.name))
const exportNames = new Set<string>()
for (const entry of manifestExports) {
  if (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) === false ||
    exportNames.has(entry.name) === true
  ) {
    throw new Error(`Invalid or duplicate macro export: ${entry.name}`)
  }
  exportNames.add(entry.name)
}
await writeFile(
  join(output, 'exports.json'),
  JSON.stringify({ version: 1, exports: manifestExports, errors }, undefined, 2) + '\n',
)
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
if (kind === 'napi') {
  await copyFile(input, join(output, `${name}.node`))
  await writeFile(join(output, 'index.cjs'), `module.exports = require('./${name}.node')\n`)
  await writeFile(
    join(output, 'load.cjs'),
    [
      `const addon = require('./${name}.node');`,
      'exports.load = () => {',
      '  let released = false;',
      '  const api = Object.fromEntries(Object.entries(addon).map(([name, value]) => [name, typeof value === "function" ? (...args) => { if (released) throw new Error("Native instance released"); return value(...args); } : value]));',
      '  return { api, release() { released = true; } };',
      '};',
      '',
    ].join('\n'),
  )
  // Untyped on purpose: the generated service package (interop-service.ts) owns the typed API.
  await writeFile(
    join(output, 'load.d.cts'),
    'export declare const load: () => { api: Readonly<Record<string, unknown>>; release(): void };\n',
  )
  await writeFile(
    join(output, 'package.json'),
    JSON.stringify(
      {
        name: `${name}-native`,
        private: true,
        version: '0.0.0',
        type: 'commonjs',
        main: './index.cjs',
        exports: {
          '.': { node: './index.cjs', bun: './index.cjs' },
          './load': './load.cjs',
          './exports.json': './exports.json',
        },
      },
      undefined,
      2,
    ) + '\n',
  )
  await writeFile(
    join(output, 'artifact.json'),
    JSON.stringify({ kind, panic: 'unwind', bytes: (await stat(input)).size }, undefined, 2) + '\n',
  )
} else if (kind === 'wasm') {
  const bindgen = required('bindgen')
  const wasmOpt = required('wasm-opt')
  const optimizerFlags: unknown = JSON.parse(required('optimizer-flags'))
  if (isStringArray(optimizerFlags) === false) throw new Error('Expected pinned optimizer flags')
  const sizes: Record<string, number> = { rustWasm: (await stat(input)).size }
  for (const target of ['nodejs', 'web']) {
    const directory = join(output, target)
    // eslint-disable-next-line no-await-in-loop -- Create each target directory before bindgen; finish nodejs before starting web.
    await mkdir(directory, { recursive: true })
    run({
      binary: bindgen,
      args: [input, '--target', target, '--out-dir', directory, '--out-name', name],
    })
    const wasmPath = join(directory, `${name}_bg.wasm`)
    const optimized = join(directory, `${name}_optimized.wasm`)
    // eslint-disable-next-line no-await-in-loop -- Measure bindgen output before the synchronous optimizer changes this target.
    sizes[`${target}BeforeOptimize`] = (await stat(wasmPath)).size
    run({ binary: wasmOpt, args: [wasmPath, ...optimizerFlags, '-o', optimized] })
    // eslint-disable-next-line no-await-in-loop -- Install this target's optimized bytes before cleanup or the next target.
    await copyFile(optimized, wasmPath)
    // The intermediate is not part of the emitted package.
    // eslint-disable-next-line no-await-in-loop -- Remove this target's intermediate only after its optimized bytes are installed.
    await unlink(optimized)
    // eslint-disable-next-line no-await-in-loop -- Record final bytes after installation and cleanup, before starting the next target.
    sizes[target] = (await stat(wasmPath)).size
  }
  await writeFile(join(output, 'nodejs', 'package.json'), '{"type":"commonjs"}\n')
  const gluePath = join(output, 'web', `${name}.js`)
  const glue = await readFile(gluePath, 'utf8')
  // wasm-bindgen 0.2.127's unused default URL would make bundlers emit a second wasm.
  // Fail on generator drift instead of silently publishing source-coupled glue.
  const defaultUrl =
    /    if \(module_or_path === undefined\) \{\s*module_or_path = new URL\('[^']+_bg\.wasm', import\.meta\.url\);\s*\}\s*/g
  if (defaultUrl.test(glue) === false)
    throw new Error('Pinned bindgen web glue default URL contract changed')
  defaultUrl.lastIndex = 0
  await writeFile(gluePath, glue.replace(defaultUrl, ''))
  const bytes = (await readFile(join(output, 'web', `${name}_bg.wasm`))).toString('base64')
  // Put *all* bindgen state (wasm, externrefs, caches and closure registries) inside
  // a lexical factory. Creating only a fresh Instance with module-global glue is unsafe.
  const factoryExports: string[] = []
  let factoryBody = glue
    .replace(defaultUrl, '')
    .replace(
      /^export ((?:async )?(?:function|class|const|let)) ([A-Za-z_$][\w$]*)/gm,
      (_match, declaration: string, identifier: string) => {
        factoryExports.push(identifier)
        return `${declaration} ${identifier}`
      },
    )
  factoryBody = factoryBody.replace(/^export \{ initSync, __wbg_init as default \};?$/m, '')
  if (/^\s*(?:import|export)\s/m.test(factoryBody) === true)
    throw new Error('Pinned bindgen lexical factory contract changed')
  if (
    factoryExports.length === 0 ||
    factoryBody.includes('let wasmModule, wasmInstance, wasm;') === false
  )
    throw new Error('Pinned bindgen instance state contract changed')
  await writeFile(
    join(output, 'web', 'factory.js'),
    [
      'export const create = () => {',
      factoryBody,
      `return { api: { ${factoryExports.join(', ')} }, init: __wbg_init, initSync, release() { wasm = undefined; wasmInstance = undefined; wasmModule = undefined; } };`,
      '};',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(output, 'web', 'load.js'),
    [
      "import { create } from './factory.js';",
      `const bytes = Uint8Array.from(atob('${bytes}'), c => c.charCodeAt(0));`,
      'export const load = async (source = bytes) => { const instance = create(); await instance.init({ module_or_path: source }); return { api: instance.api, release: instance.release }; };',
      '',
    ].join('\n'),
  )
  // Untyped on purpose: the generated service package (interop-service.ts) owns the typed API.
  await writeFile(
    join(output, 'web', 'load.d.ts'),
    'export declare const load: (source?: WebAssembly.Module | BufferSource) => Promise<{ api: Readonly<Record<string, unknown>>; release(): void }>;\n',
  )
  await writeFile(
    join(output, 'web', 'inline.js'),
    [
      `import init, { initSync } from './${name}.js';`,
      `export * from './${name}.js';`,
      `const encoded = '${bytes}';`,
      `const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));`,
      'export default () => init({ module_or_path: bytes });',
      'export const initializeSync = () => initSync({ module: bytes });',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(output, 'web', 'inline.d.ts'),
    [
      `import type { InitOutput } from './${name}.js';`,
      `export * from './${name}.js';`,
      'export default function initialize(): Promise<InitOutput>;',
      'export declare function initializeSync(): InitOutput;',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(output, 'web', 'url.js'),
    [
      `import init from './${name}.js';`,
      `export * from './${name}.js';`,
      'export default source => init({ module_or_path: source });',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(output, 'web', 'url.d.ts'),
    [
      `import type { InitInput, InitOutput } from './${name}.js';`,
      `export * from './${name}.js';`,
      'export default function initialize(source: InitInput | Promise<InitInput>): Promise<InitOutput>;',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(output, 'worker.js'),
    [
      `import module from './web/${name}_bg.wasm';`,
      `import { initSync } from './web/${name}.js';`,
      `export * from './web/${name}.js';`,
      'export default () => initSync({ module });',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(output, 'worker-load.js'),
    [
      `import module from './web/${name}_bg.wasm';`,
      "import { create } from './web/factory.js';",
      'export const load = () => { const instance = create(); instance.initSync({ module }); return { api: instance.api, release: instance.release }; };',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(output, 'worker-load.d.ts'),
    'export declare const load: () => { api: Readonly<Record<string, unknown>>; release(): void };\n',
  )
  await writeFile(
    join(output, 'package.json'),
    JSON.stringify(
      {
        name,
        private: true,
        version: '0.0.0',
        type: 'module',
        // Condition order is precedence: Bun also matches `node`, so `bun` must come first.
        exports: {
          '.': {
            workerd: './worker.js',
            bun: './web/inline.js',
            node: `./nodejs/${name}.js`,
            browser: './web/inline.js',
            default: './web/inline.js',
          },
          './url': './web/url.js',
          './load': { workerd: './worker-load.js', default: './web/load.js' },
          './exports.json': './exports.json',
        },
      },
      undefined,
      2,
    ) + '\n',
  )
  await writeFile(
    join(output, 'artifact.json'),
    JSON.stringify(
      {
        kind,
        target: 'wasm32-unknown-unknown',
        profile: {
          optLevel: required('opt-level'),
          lto: required('lto'),
          strip: required('strip'),
        },
        optimizer: { binary: wasmOpt, flags: optimizerFlags },
        generator: bindgen,
        sizes,
      },
      undefined,
      2,
    ) + '\n',
  )
} else {
  throw new Error(`Unknown interop product kind: ${kind}`)
}
