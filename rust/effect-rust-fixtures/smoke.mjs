// Usage: node|bun rust/effect-rust-fixtures/smoke.mjs <package-directory|aggregator-directory|glue.js|addon.node> [...]
// The individual adapters export the whole fixture API; an aggregator splits it
// across its eager group (hash_core) and lazy group (math_core).
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtime = process.versions.bun === undefined ? 'node' : 'bun'
const entries = process.argv.slice(2)
assert.ok(entries.length > 0, 'Pass a generated package directory, aggregator directory, glue entry or .node addon')
const require = createRequire(import.meta.url)

// Web-target entries export an initializer as default; Node CJS glue and addons are ready on load.
const load = async (absolute) => {
  const api = absolute.endsWith('.node') ? require(absolute) : await import(pathToFileURL(absolute).href)
  if (typeof api.default === 'function') {
    await api.default()
    return api
  }
  return api.default ?? api
}

const checkHash = (api) => {
  const sha256 = api.sha256Hex(Buffer.from('abc'))
  assert.equal(sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  return sha256
}

const checkArithmetic = (api) => {
  const result = { sum: api.add(20, 22), upperBoundary: api.add(2147483647, 1), lowerBoundary: api.add(-2147483648, -1) }
  assert.deepEqual(result, { sum: 42, upperBoundary: 2147483647, lowerBoundary: -2147483648 })
  return result
}

const checkPackage = async (directory) => {
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // Package self-reference exercises the runtime's own conditional exports resolver.
  const absolute = createRequire(manifestPath).resolve(manifest.name)
  const conditions = manifest.exports['.']
  const expected = resolve(directory, conditions[runtime])
  assert.equal(absolute, expected, `${runtime} must resolve its own export condition`)
  const api = await load(absolute)
  return { entry: relative(directory, absolute), sha256: checkHash(api), ...checkArithmetic(api) }
}

const wasmModules = (directory) =>
  readdirSync(join(directory, 'web')).filter((file) => file.endsWith('.wasm')).map((file) => join(directory, 'web', file))

const checkAggregator = async (directory) => {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest, { eager: ['hash_core'], lazy: ['math_core'] })
  // One wasm per bundle group, each its own module.
  const modules = Object.keys(manifest).map((group) => wasmModules(join(directory, group)))
  assert.deepEqual(modules.map((files) => files.length), [1, 1])
  assert.notDeepEqual(readFileSync(modules[0][0]), readFileSync(modules[1][0]))
  const app = await import(pathToFileURL(join(directory, 'index.ts')).href)
  await app.eager.default()
  const sha256 = checkHash(app.eager)
  assert.equal(app.eager.add, undefined, 'lazy-group exports must not be linked into the eager wasm')
  assert.equal(typeof app.lazy, 'function', 'lazy groups are exposed as dynamic-import loaders')
  const lazy = await app.lazy()
  await lazy.default()
  assert.equal(lazy.sha256Hex, undefined, 'eager-group exports must not be linked into the lazy wasm')
  return { groups: Object.keys(manifest), sha256, ...checkArithmetic(lazy) }
}

const results = []
for (const entry of entries) {
  const absolute = resolve(entry)
  const result = !statSync(absolute).isDirectory()
    ? await load(absolute).then((api) => ({ entry, sha256: checkHash(api), ...checkArithmetic(api) }))
    : existsSync(join(absolute, 'manifest.json'))
      ? await checkAggregator(absolute)
      : await checkPackage(absolute)
  results.push(result)
  console.log(`${entry} (${runtime}): ${JSON.stringify(result)}`)
}
// Buck's build gate declares this output; ordinary CLI/test runs do not write.
const verdictPath = process.env.RUST_INTEROP_SMOKE_OUTPUT
if (verdictPath !== undefined) {
  writeFileSync(verdictPath, JSON.stringify({ passed: true, runtime, results }, undefined, 2) + '\n')
}
