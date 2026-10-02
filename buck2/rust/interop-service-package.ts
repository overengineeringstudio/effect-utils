import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Compile the generator's actual sources, including declaration emission. The private
// compilation view is a Buck output, never a source-tree package or editor workaround.
const args = process.argv.slice(2)
const options = new Map<string, string>()
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]
  const value = args[index + 1]
  if (key === undefined || value === undefined || options.has(key)) throw new Error('Invalid package arguments')
  options.set(key, value)
}
const required = (key: string): string => {
  const value = options.get(key)
  if (value === undefined) throw new Error(`Missing ${key}`)
  return resolve(value)
}
const source = required('--source')
const output = required('--output')
const compiler = required('--compiler')
const runtimeDist = required('--runtime-dist')
const tsgo = required('--tsgo')
await cp(source, output, { recursive: true })
const view = join(output, '.compile')
await cp(source, view, { recursive: true })
await mkdir(join(view, 'node_modules', '@overeng', 'effect-rust'), { recursive: true })
await cp(join(compiler, 'node_modules', 'effect'), join(view, 'node_modules', 'effect'), { recursive: true, dereference: true })
await cp(runtimeDist, join(view, 'node_modules', '@overeng', 'effect-rust', 'dist'), { recursive: true })
await writeFile(join(view, 'node_modules', '@overeng', 'effect-rust', 'package.json'), JSON.stringify({
  name: '@overeng/effect-rust', type: 'module', exports: {
    '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
    './runtime': { types: './dist/src/runtime/interop.d.ts', default: './dist/src/runtime/interop.js' },
    './schema': { types: './dist/src/schema/mod.d.ts', default: './dist/src/schema/mod.js' },
  },
}))
await writeFile(join(view, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    skipLibCheck: true, declaration: true, rewriteRelativeImportExtensions: true,
    rootDir: '.', outDir: '../dist', lib: ['ES2024', 'DOM'],
  },
  include: ['service.ts', 'contracts.ts'],
}))
const compilation = Bun.spawn([tsgo, '--project', join(view, 'tsconfig.json')], { stdout: 'inherit', stderr: 'inherit' })
if (await compilation.exited !== 0) throw new Error('Generated service package compilation failed')
for (const product of ['wasm', 'native']) {
  if (existsSync(join(source, product)) === false) continue
  await cp(join(source, product), join(output, 'dist', product), { recursive: true })
}
for (const declaration of ['wasm/web/load.d.ts', 'wasm/worker-load.d.ts', 'native/load.d.cts']) {
  const file = join(output, 'dist', declaration)
  if (existsSync(file) === false) continue
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('service.ts', 'service.js'))
}
await cp(join(view, 'node_modules'), join(output, 'node_modules'), { recursive: true })
const manifest: { exports: Record<string, string | { types: string; default: string }> } = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'))
for (const [name, entry] of Object.entries(manifest.exports)) {
  if (typeof entry === 'string' && entry.endsWith('.ts')) {
    const stem = entry.slice(2, -3)
    manifest.exports[name] = { types: `./dist/${stem}.d.ts`, default: `./dist/${stem}.js` }
  }
}
await writeFile(join(output, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
await rm(view, { recursive: true })
