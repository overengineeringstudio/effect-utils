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
assert.ok(
  entries.length > 0,
  'Pass a generated package directory, aggregator directory, glue entry or .node addon',
)
const require = createRequire(import.meta.url)

// Web-target entries export an initializer as default; Node CJS glue and addons are ready on load.
const load = async (absolute) => {
  const api =
    absolute.endsWith('.node') === true
      ? // eslint-disable-next-line import/no-dynamic-require -- Load the native product supplied as a CLI path, not a source dependency.
        require(absolute)
      : // eslint-disable-next-line import/no-dynamic-require -- Import the generated glue supplied as a CLI path, not a source dependency.
        await import(pathToFileURL(absolute).href)
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
  const result = {
    sum: api.add(20, 22),
    upperBoundary: api.add(2147483647, 1),
    lowerBoundary: api.add(-2147483648, -1),
  }
  assert.deepEqual(result, { sum: 42, upperBoundary: 2147483647, lowerBoundary: -2147483648 })
  return result
}

const checkHashModes = async (api) => {
  assert.equal(api.borrowedChecksum(Buffer.from('abc')), 294)
  const hasher = api.hasher()
  hasher.write(Buffer.from('a'))
  hasher.write(Buffer.from('bc'))
  assert.equal(hasher.finish(), checkHash(api))
  assert.throws(() => hasher.finish(), /RUST_INPUT:/)
  hasher.close()
  const paths = []
  const job = api.hashAll(
    async (path) => {
      paths.push(path)
      return Buffer.from(path)
    },
    ['a', 'bc'],
  )
  assert.equal(job._tag, 'RustJob')
  assert.equal(job.mode, 'abortable')
  assert.equal(await job.result, checkHash(api))
  assert.deepEqual(paths, ['a', 'bc'])
  const hostThrow = api.hashAll(() => {
    throw new Error('host throw')
  }, ['a'])
  await assert.rejects(hostThrow.result, /RUST_ERROR:/)
  assert.equal(
    api.sha256Hex(Buffer.from('abc')),
    checkHash(api),
    'host failures must not poison the module',
  )

  let enter
  let unblock
  const entered = new Promise((complete) => {
    enter = complete
  })
  const blocked = new Promise((complete) => {
    unblock = complete
  })
  const reads = []
  const cancelled = api.hashAll(
    async (path) => {
      reads.push(path)
      enter()
      await blocked
      return Buffer.from(path)
    },
    ['first', 'must-not-read'],
  )
  const rejection = cancelled.result.then(
    () => {
      throw new Error('Cancelled Rust job unexpectedly succeeded')
    },
    (error) => {
      assert.match(error.message, /RUST_CANCELLED:|RUST_ERROR:/)
    },
  )
  await entered
  await cancelled.cancel()
  unblock()
  await rejection
  assert.deepEqual(reads, ['first'], 'cancel acknowledgment prevents subsequent host reads')
}

const checkMathModes = (api) => {
  assert.equal(api.checkedDivide(84, 2), 42)
  assert.throws(
    () => api.checkedDivide(84, 0),
    (error) => {
      assert.ok(error.message.startsWith('RUST_ERROR:'))
      assert.deepEqual(JSON.parse(error.message.slice(11)), {
        reason: 'DivideByZero',
        dividend: 84,
      })
      return true
    },
  )
  const chunks = api.chunks(10, 7)
  assert.deepEqual([...chunks.next(3)], [0, 1, 2])
  assert.deepEqual([...chunks.next(3)], [3, 4, 5])
  assert.deepEqual([...chunks.next(3)], [6])
  assert.deepEqual([...chunks.next(3)], [7, 8, 9])
  assert.equal(chunks.next(3), undefined)
  chunks.close()
  assert.throws(() => api.chunks(10, 0), /RUST_ERROR:/)
  const frame = Buffer.alloc(18)
  frame.writeUInt32LE(4026459905, 0)
  frame.writeUInt16LE(1, 4)
  frame.writeUInt32LE(2, 6)
  frame.writeUInt32LE(20, 10)
  frame.writeUInt32LE(22, 14)
  assert.equal(api.sumRows(frame), '42')
  frame.writeUInt16LE(2, 4)
  assert.throws(() => api.sumRows(frame), /RUST_INPUT:/)
  // Contract positions cross as their encoded wire form: u64 as decimal strings, tag-keyed unions.
  const order = {
    id: '9007199254740993',
    sku: 'ABC-1234',
    quantity: 3,
    unitPriceCents: '250',
    placedAt: '2026-10-02T12:00:00.500Z',
    note: 'gift',
  }
  assert.deepEqual(api.quoteOrder(order, { kind: 'percent', percent: 10 }), {
    kind: 'priced',
    note: 'gift',
    receipt: {
      orderId: '9007199254740993',
      placedAt: '2026-10-02T12:00:00.500Z',
      sku: 'ABC-1234',
      totalCents: '675',
    },
  })
  assert.deepEqual(
    api.quoteOrder(
      { ...order, note: null },
      { kind: 'fixed', amountCents: '18446744073709551615' },
    ),
    { kind: 'free', orderId: '9007199254740993' },
  )
  assert.throws(() => api.quoteOrder({ ...order, sku: 'abc' }, { kind: 'none' }), /RUST_INPUT:/)
  assert.throws(
    () =>
      api.quoteOrder(
        { ...order, quantity: 4294967295, unitPriceCents: '18446744073709551615' },
        { kind: 'none' },
      ),
    (error) => {
      assert.deepEqual(JSON.parse(error.message.slice(11)), {
        reason: 'PriceOverflow',
        quantity: 4294967295,
      })
      return true
    },
  )
  const schema = JSON.parse(api['__effect_rust_schema_quoteOrder']())
  assert.deepEqual(Object.keys(schema.args), ['discount', 'order'])
  assert.equal(schema.$defs.Order.properties.id['x-effect-rust-format'], 'u64-decimal')
}

const checkManifest = ({ directory, names }) => {
  const manifest = JSON.parse(readFileSync(join(directory, 'exports.json'), 'utf8'))
  assert.equal(manifest.version, 1)
  assert.deepEqual(
    manifest.exports.map(({ name }) => name),
    names.toSorted(),
  )
  const divide = manifest.exports.find(({ name }) => name === 'checkedDivide')
  if (divide !== undefined) {
    assert.deepEqual(divide.error, { name: 'ArithmeticError', tagKey: 'reason' })
    assert.deepEqual(
      manifest.errors
        .find(({ name }) => name === 'ArithmeticError')
        .variants.map(({ name }) => name),
      ['DivideByZero', 'Overflow', 'InvalidChunkSize', 'PriceOverflow'],
    )
    assert.equal(
      manifest.exports.find(({ name }) => name === 'quoteOrder').schema,
      '__effect_rust_schema_quoteOrder',
    )
  }
}

const hashExports = ['sha256Hex', 'hasher', 'hashAll', 'borrowedChecksum']
const mathExports = ['add', 'checkedDivide', 'chunks', 'sumRows', 'panicTest', 'quoteOrder']

const checkPackage = async (directory) => {
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // Package self-reference exercises the runtime's own conditional exports resolver.
  const absolute = createRequire(manifestPath).resolve(manifest.name)
  const conditions = manifest.exports['.']
  const expected = resolve(directory, conditions[runtime])
  assert.equal(absolute, expected, `${runtime} must resolve its own export condition`)
  const api = await load(absolute)
  await checkHashModes(api)
  checkMathModes(api)
  checkManifest({ directory, names: [...hashExports, ...mathExports] })
  const result = {
    entry: relative(directory, absolute),
    sha256: checkHash(api),
    ...checkArithmetic(api),
  }
  const loadPath = join(directory, manifest.type === 'commonjs' ? 'load.cjs' : 'web/load.js')
  // eslint-disable-next-line import/no-dynamic-require -- Exercise the generated product's fresh-instance loader selected by its package type.
  const { load: fresh } = await import(pathToFileURL(loadPath).href)
  const first = await fresh()
  const second = await fresh()
  assert.notEqual(first.api, second.api)
  assert.throws(
    () => first.api.panicTest(),
    (cause) =>
      cause instanceof WebAssembly.RuntimeError ||
      (cause instanceof Error && cause.message.startsWith('RUST_PANIC:')),
  )
  assert.equal(
    second.api.add(20, 22),
    42,
    'panic in one lexical wasm instance must not poison the next',
  )
  first.release()
  second.release()
  return result
}

const wasmModules = (directory) =>
  readdirSync(join(directory, 'web'))
    .filter((file) => file.endsWith('.wasm'))
    .map((file) => join(directory, 'web', file))

const checkAggregator = async (directory) => {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest, { eager: ['hash_core'], lazy: ['math_core'] })
  // One wasm per bundle group, each its own module.
  const modules = Object.keys(manifest).map((group) => wasmModules(join(directory, group)))
  assert.deepEqual(
    modules.map((files) => files.length),
    [1, 1],
  )
  assert.notDeepEqual(readFileSync(modules[0][0]), readFileSync(modules[1][0]))
  // eslint-disable-next-line import/no-dynamic-require -- Load the aggregator product from the caller-supplied build directory.
  const app = await import(pathToFileURL(join(directory, 'index.ts')).href)
  await app.eager.default()
  const sha256 = checkHash(app.eager)
  await checkHashModes(app.eager)
  checkManifest({ directory: join(directory, 'eager'), names: hashExports })
  assert.equal(
    app.eager.add,
    undefined,
    'lazy-group exports must not be linked into the eager wasm',
  )
  assert.equal(typeof app.lazy, 'function', 'lazy groups are exposed as dynamic-import loaders')
  const lazy = await app.lazy()
  await lazy.default()
  assert.equal(
    lazy.sha256Hex,
    undefined,
    'eager-group exports must not be linked into the lazy wasm',
  )
  checkMathModes(lazy)
  checkManifest({ directory: join(directory, 'lazy'), names: mathExports })
  const result = { groups: Object.keys(manifest), sha256, ...checkArithmetic(lazy) }
  assert.throws(() => lazy.panicTest(), WebAssembly.RuntimeError)
  return result
}

const results = []
for (const entry of entries) {
  const absolute = resolve(entry)
  const result =
    statSync(absolute).isDirectory() === false
      ? // eslint-disable-next-line no-await-in-loop -- Finish each product smoke before loading the next; a failure must prevent subsequent product initialization.
        await load(absolute).then((api) => ({
          entry,
          sha256: checkHash(api),
          ...checkArithmetic(api),
        }))
      : existsSync(join(absolute, 'manifest.json')) === true
        ? // eslint-disable-next-line no-await-in-loop -- Aggregator initialization and panic checks must finish before the next product starts.
          await checkAggregator(absolute)
        : // eslint-disable-next-line no-await-in-loop -- Package initialization and panic checks must finish before the next product starts.
          await checkPackage(absolute)
  results.push(result)
  console.log(`${entry} (${runtime}): ${JSON.stringify(result)}`)
}
// Buck's build gate declares this output; ordinary CLI/test runs do not write.
const verdictPath = process.env.RUST_INTEROP_SMOKE_OUTPUT
if (verdictPath !== undefined) {
  writeFileSync(
    verdictPath,
    JSON.stringify({ passed: true, runtime, results }, undefined, 2) + '\n',
  )
}
