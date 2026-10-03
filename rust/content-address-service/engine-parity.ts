// Run: bun (or node --experimental-transform-types) engine-parity.ts <generated-service-dir> <result.json>
// Console output is the standalone parity verdict and benchmark report.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { loadavg } from 'node:os'
import { resolve } from 'node:path'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { ContentAddressCore } from './service/service.ts'
import { Effect, FileSystem, Layer, Schema, Stream } from 'effect'

import { ContractJson } from '@overeng/effect-rust'

import {
  ContentAddressEngine,
  ContentDescriptor,
  ContentManifest,
  canonicalJsonBytes,
  descriptorForBytes,
  getBytes,
  hashBytes,
  makeFileSystemContentStore,
  putBytes,
  verifyDescriptor,
} from './dist/src/mod.js'
import { descriptorVectors, hashVectors } from './dist/src/vectors.js'

const [directoryArgument, output] = process.argv.slice(2)
assert.ok(
  directoryArgument !== undefined &&
    directoryArgument.length > 0 &&
    output !== undefined &&
    output.length > 0,
  'Pass generated service directory and result JSON path',
)
const directory = resolve(directoryArgument)
const require = createRequire(import.meta.url)
// oxlint-disable-next-line import/no-commonjs, import/no-dynamic-require -- Inspect the actual runtime-selected generated CommonJS native product.
const native = require(`${directory}/native/index.cjs`)
// oxlint-disable-next-line import/no-commonjs, import/no-dynamic-require -- Read the actual generated wasm package metadata, not a fixture copy.
const wasmMetadata = require(`${directory}/wasm/package.json`)
// oxlint-disable-next-line import/no-commonjs, import/no-dynamic-require -- The generated Node wasm-bindgen entry point is CommonJS.
const wasm = require(`${directory}/wasm/nodejs/${wasmMetadata.name}.js`)
const runtime = process.versions.bun === undefined ? 'node' : 'bun'
const layers = [
  ['js', ContentAddressEngine.layerJs],
  [
    'wasm',
    ContentAddressEngine.layerRust(ContentAddressCore).pipe(
      Layer.provide(ContentAddressCore.layerWasm[runtime]()),
    ),
  ],
  [
    'native',
    ContentAddressEngine.layerRust(ContentAddressCore).pipe(
      Layer.provide(ContentAddressCore.layerNative[runtime]()),
    ),
  ],
] as const
const decodeDescriptor = Schema.decodeUnknownSync(ContentDescriptor, { onExcessProperty: 'error' })
const decodeContractDescriptor = ContractJson.decodeValue(ContentDescriptor)
let descriptorChecks = 0
for (const vector of descriptorVectors) {
  if (vector.accept === true) {
    const expected = decodeDescriptor(vector.input)
    assert.deepEqual(decodeContractDescriptor(expected), expected, vector.name)
    assert.deepEqual(native.validateDescriptor(expected), expected, vector.name)
    assert.deepEqual(wasm.validateDescriptor(expected), expected, vector.name)
  } else {
    assert.throws(() => decodeDescriptor(vector.input), vector.name)
    // Send rejected inputs independently to Rust, not merely through the TS validator.
    assert.throws(() => native.validateDescriptor(vector.input), vector.name)
    assert.throws(() => wasm.validateDescriptor(vector.input), vector.name)
  }
  descriptorChecks++
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  const fixture = `${root}/fixture`
  yield* fs.makeDirectory(`${fixture}/nested`, { recursive: true })
  yield* fs.writeFileString(`${fixture}/abc`, 'abc')
  yield* fs.writeFile(`${fixture}/nested/random`, hashVectors[3].bytes)
  yield* fs.writeFileString(`${fixture}/\ue000`, 'bmp')
  yield* fs.writeFileString(`${fixture}/\u{10000}`, 'astral')
  yield* fs.symlink('abc', `${fixture}/link`)
  yield* fs.chmod(fixture, 0o755)
  yield* fs.chmod(`${fixture}/nested`, 0o755)
  yield* fs.chmod(`${fixture}/abc`, 0o640)
  const realTree = resolve('rust/effect-rust-fixtures')
  const trees = [fixture, realTree]
  const treeExpected: string[] = []
  const results: Array<{
    backend: string
    hashMs: Record<string, number>
    treeMs: number
    treeDigest: string
    fixtureDigest: string
  }> = []
  const benchmarkBytes = [1024, 1024 * 1024, 100 * 1024 * 1024].map((size) =>
    new Uint8Array(size).fill(97),
  )
  let hashChecks = 0
  for (const [backend, layer] of layers) {
    const result = yield* Effect.gen(function* () {
      const engine = yield* ContentAddressEngine
      for (const vector of hashVectors) {
        const expected = vector.expected
        assert.equal(engine.hashBytes(vector.bytes), expected, `${backend}/${vector.name}`)
        const chunks = [
          vector.bytes.subarray(0, 7),
          vector.bytes.subarray(7, 8193),
          vector.bytes.subarray(8193),
        ]
        assert.equal(
          yield* Stream.fromIterable(chunks).pipe(Stream.run(engine.hasher())),
          expected,
          `${backend}/${vector.name}/incremental`,
        )
        assert.deepEqual(
          engine.descriptorForBytes({
            bytes: vector.bytes,
            mediaType: 'application/octet-stream',
            codec: 'raw',
            schemaVersion: 1,
          }),
          descriptorForBytes({
            bytes: vector.bytes,
            mediaType: 'application/octet-stream',
            codec: 'raw',
            schemaVersion: 1,
          }),
        )
        hashChecks++
      }
      // Public descriptors are JS data, not the narrower UTF-8/I-JSON wire.
      for (const mediaType of ['text/plain', '\ud800', '\u0085x\u0085']) {
        const options = {
          bytes: hashVectors[1].bytes,
          mediaType,
          codec: undefined,
          schemaVersion: 1,
        }
        assert.deepEqual(
          Reflect.apply(engine.descriptorForBytes, undefined, [options]),
          Reflect.apply(descriptorForBytes, undefined, [options]),
          `${backend}/metadata-string-semantics`,
        )
      }
      assert.throws(() =>
        engine.descriptorForBytes({ bytes: hashVectors[1].bytes, mediaType: ' text/plain' }),
      )
      const manifest = {
        _tag: 'ContentManifest' as const,
        schemaVersion: 1 as const,
        role: 'engine-parity',
        entries: [
          {
            descriptor: descriptorForBytes({
              bytes: hashVectors[1].bytes,
              mediaType: 'text/plain',
            }),
            logicalPath: 'abc',
          },
        ],
      }
      const manifestBytes = canonicalJsonBytes({ schema: ContentManifest, value: manifest })
      assert.equal(engine.hashBytes(manifestBytes), hashBytes(manifestBytes), `${backend}/manifest`)
      const store = makeFileSystemContentStore({ root: `${root}/store-${backend}` })
      const descriptor = yield* putBytes({
        store,
        bytes: hashVectors[1].bytes,
        mediaType: 'text/plain',
      })
      assert.deepEqual(yield* getBytes({ store, descriptor }), hashVectors[1].bytes)
      yield* verifyDescriptor({ descriptor, bytes: hashVectors[1].bytes })
      const digests: string[] = []
      let treeMs = 0
      for (const [index, tree] of trees.entries()) {
        const start = performance.now()
        const digest = yield* engine.hashTree(tree)
        if (index === 1) treeMs = performance.now() - start
        if (backend === 'js') treeExpected[index] = digest
        else assert.equal(digest, treeExpected[index], `${backend}/tree-${index}`)
        digests.push(digest)
      }
      // Mode and literal symlink target are identity, not just file contents.
      const initial = digests[0]!
      yield* fs.chmod(`${fixture}/abc`, 0o600)
      const modeChanged = yield* engine.hashTree(fixture)
      assert.notEqual(modeChanged, initial)
      yield* fs.chmod(`${fixture}/abc`, 0o640)
      yield* fs.remove(`${fixture}/link`)
      yield* fs.symlink('nested/random', `${fixture}/link`)
      assert.notEqual(yield* engine.hashTree(fixture), initial)
      yield* fs.remove(`${fixture}/link`)
      yield* fs.symlink('abc', `${fixture}/link`)
      const hashMs: Record<string, number> = {}
      for (const bytes of benchmarkBytes) {
        const expected = hashBytes(bytes)
        const iterations = bytes.length <= 1024 ? 1000 : bytes.length <= 1024 * 1024 ? 10 : 2
        engine.hashBytes(bytes) // warm the JIT and backend copy/allocator paths
        const start = performance.now()
        let digest = ''
        for (let index = 0; index < iterations; index++) digest = engine.hashBytes(bytes)
        hashMs[String(bytes.length)] = (performance.now() - start) / iterations
        assert.equal(digest, expected, `${backend}/benchmark-${bytes.length}`)
      }
      return { backend, hashMs, treeMs, fixtureDigest: digests[0]!, treeDigest: digests[1]! }
    }).pipe(Effect.provide(layer))
    results.push(result)
  }
  const result = {
    runtime,
    runtimeVersion: process.versions.bun ?? process.versions.node,
    hashChecks,
    descriptorChecks,
    treeChecks: trees.length * layers.length,
    disagreements: 0,
    load: loadavg(),
    results,
  }
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result)
  yield* fs.writeFileString(output, encoded)
  console.log(encoded)
})
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer), Effect.scoped))
