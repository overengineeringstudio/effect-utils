import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// This action is run by the admitted Bun capability; all child tools are immutable Nix paths.
const [kind, ...arguments_] = process.argv.slice(2)
const options = new Map<string, string>()
for (let index = 0; index < arguments_.length; index += 2) {
  const key = arguments_[index]
  const value = arguments_[index + 1]
  if (key === undefined || value === undefined || !key.startsWith('--')) {
    throw new Error('Expected --key value action arguments')
  }
  options.set(key.slice(2), value)
}
const required = (key: string): string => {
  const value = options.get(key)
  if (value === undefined) throw new Error(`Missing action argument: ${key}`)
  return value
}
const run = (binary: string, args: readonly string[]): void => {
  if (!binary.startsWith('/nix/store/')) throw new Error(`Tool is not an immutable capability: ${binary}`)
  const result = spawnSync(binary, args, { stdio: 'inherit', env: process.env })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${binary} exited with ${result.status}`)
}
const output = required('output')
const input = required('input')
const name = required('name')
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Invalid bindgen output name: ${name}`)
await mkdir(output, { recursive: true })

if (kind === 'napi') {
  await copyFile(input, join(output, `${name}.node`))
  await writeFile(join(output, 'index.cjs'), `module.exports = require('./${name}.node')\n`)
  await writeFile(join(output, 'package.json'), JSON.stringify({
    name: `${name}-native`, private: true, version: '0.0.0', type: 'commonjs',
    main: './index.cjs', exports: { '.': { node: './index.cjs', bun: './index.cjs' } },
  }, undefined, 2) + '\n')
  await writeFile(join(output, 'artifact.json'), JSON.stringify({ kind, panic: 'unwind', bytes: (await stat(input)).size }, undefined, 2) + '\n')
} else if (kind === 'wasm') {
  const bindgen = required('bindgen')
  const wasmOpt = required('wasm-opt')
  const optimizerFlags: unknown = JSON.parse(required('optimizer-flags'))
  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
  if (!isStringArray(optimizerFlags)) throw new Error('Expected pinned optimizer flags')
  const sizes: Record<string, number> = { rustWasm: (await stat(input)).size }
  for (const target of ['nodejs', 'web']) {
    const directory = join(output, target)
    await mkdir(directory, { recursive: true })
    run(bindgen, [input, '--target', target, '--out-dir', directory, '--out-name', name])
    const wasmPath = join(directory, `${name}_bg.wasm`)
    const optimized = join(directory, `${name}_optimized.wasm`)
    sizes[`${target}BeforeOptimize`] = (await stat(wasmPath)).size
    run(wasmOpt, [wasmPath, ...optimizerFlags, '-o', optimized])
    await copyFile(optimized, wasmPath)
    // The intermediate is not part of the emitted package.
    await unlink(optimized)
    sizes[target] = (await stat(wasmPath)).size
  }
  await writeFile(join(output, 'nodejs', 'package.json'), '{"type":"commonjs"}\n')
  const gluePath = join(output, 'web', `${name}.js`)
  const glue = await readFile(gluePath, 'utf8')
  // wasm-bindgen 0.2.127's unused default URL would make bundlers emit a second wasm.
  // Fail on generator drift instead of silently publishing source-coupled glue.
  const defaultUrl = /    if \(module_or_path === undefined\) \{\s*module_or_path = new URL\('[^']+_bg\.wasm', import\.meta\.url\);\s*\}\s*/g
  if (!defaultUrl.test(glue)) throw new Error('Pinned bindgen web glue default URL contract changed')
  defaultUrl.lastIndex = 0
  await writeFile(gluePath, glue.replace(defaultUrl, ''))
  const bytes = (await readFile(join(output, 'web', `${name}_bg.wasm`))).toString('base64')
  await writeFile(join(output, 'web', 'inline.js'), [
    `import init, { initSync } from './${name}.js';`,
    `export * from './${name}.js';`,
    `const encoded = '${bytes}';`,
    `const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));`,
    'export default () => init({ module_or_path: bytes });',
    'export const initializeSync = () => initSync({ module: bytes });',
    '',
  ].join('\n'))
  await writeFile(join(output, 'web', 'inline.d.ts'), [
    `import type { InitOutput } from './${name}.js';`,
    `export * from './${name}.js';`,
    'export default function initialize(): Promise<InitOutput>;',
    'export declare function initializeSync(): InitOutput;',
    '',
  ].join('\n'))
  await writeFile(join(output, 'web', 'url.js'), [
    `import init from './${name}.js';`,
    `export * from './${name}.js';`,
    'export default source => init({ module_or_path: source });',
    '',
  ].join('\n'))
  await writeFile(join(output, 'web', 'url.d.ts'), [
    `import type { InitInput, InitOutput } from './${name}.js';`,
    `export * from './${name}.js';`,
    'export default function initialize(source: InitInput | Promise<InitInput>): Promise<InitOutput>;',
    '',
  ].join('\n'))
  await writeFile(join(output, 'worker.js'), [
    `import module from './web/${name}_bg.wasm';`,
    `import { initSync } from './web/${name}.js';`,
    `export * from './web/${name}.js';`,
    'export default () => initSync({ module });',
    '',
  ].join('\n'))
  await writeFile(join(output, 'package.json'), JSON.stringify({
    name, private: true, version: '0.0.0', type: 'module',
    // Condition order is precedence: Bun also matches `node`, so `bun` must come first.
    exports: {
      '.': { workerd: './worker.js', bun: './web/inline.js', node: `./nodejs/${name}.js`, browser: './web/inline.js', default: './web/inline.js' },
      './url': './web/url.js',
    },
  }, undefined, 2) + '\n')
  await writeFile(join(output, 'artifact.json'), JSON.stringify({
    kind, target: 'wasm32-unknown-unknown',
    profile: { optLevel: required('opt-level'), lto: required('lto'), strip: required('strip') },
    optimizer: { binary: wasmOpt, flags: optimizerFlags },
    generator: bindgen, sizes,
  }, undefined, 2) + '\n')
} else {
  throw new Error(`Unknown interop product kind: ${kind}`)
}
