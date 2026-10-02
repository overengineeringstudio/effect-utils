import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type * as CompilerModule from '../../packages/@overeng/effect-rust/src/compiler/mod.ts'

// Generates one Effect service package per adapter crate from its built interop
// products: a single `Context.Service` class whose statics exist only for the
// products supplied (`layerWasm` for a wasm product, `layerNative` for a napi one).
// Serde domain types are imported through the contract compiler: the products
// embed schemars records, the effect-rust importer turns them into Effect codecs.
const actionArguments = process.argv.slice(2)
const options = new Map<string, string>()
for (let index = 0; index < actionArguments.length; index += 2) {
  const key = actionArguments[index]
  const value = actionArguments[index + 1]
  if (key === undefined || value === undefined || key.startsWith('--') === false)
    throw new Error('Expected --key value action arguments')
  options.set(key.slice(2), value)
}
const required = (key: string): string => {
  const value = options.get(key)
  if (value === undefined) throw new Error(`Missing action argument: ${key}`)
  return value
}
const output = resolve(required('output'))
const service = required('service')
const packageName = required('package')
const compiler = resolve(required('compiler'))
const wasmArgument = options.get('wasm')
const napiArgument = options.get('napi')
const wasm = wasmArgument === undefined ? undefined : resolve(wasmArgument)
const napi = napiArgument === undefined ? undefined : resolve(napiArgument)
if (/^[A-Z][A-Za-z0-9]*$/.test(service) === false)
  throw new Error(`Service class names are PascalCase identifiers: ${service}`)
if (wasm === undefined && napi === undefined)
  throw new Error('A service needs at least one wasm or napi product')

type WireArgument = { readonly name: string; readonly type: string }
type ExportError = { readonly name: string; readonly tagKey: string }
type Export = {
  readonly name: string
  readonly rustName: string
  readonly mode: 'sync' | 'async' | 'input_stream' | 'output_stream' | 'borrowed' | 'frame'
  readonly args: readonly WireArgument[]
  readonly returns: string
  readonly error: ExportError | null
  readonly schema?: string
}
type ErrorDefinition = ExportError & {
  readonly variants: readonly { readonly name: string; readonly fields: readonly WireArgument[] }[]
}
type Manifest = {
  readonly version: 1
  readonly exports: readonly Export[]
  readonly errors: readonly ErrorDefinition[]
}
type SchemaRecord = {
  readonly $schema: string
  readonly $vocabulary: Record<string, boolean>
  readonly $defs: Record<string, unknown>
  readonly args: Record<string, unknown>
  readonly returns: unknown
}

const readManifest = async (directory: string): Promise<Manifest> => {
  const manifest = JSON.parse(await readFile(join(directory, 'exports.json'), 'utf8')) as Manifest
  return {
    ...manifest,
    errors: manifest.errors.toSorted((left, right) => left.name.localeCompare(right.name)),
  }
}
const manifests = await Promise.all(
  [wasm, napi].filter((directory) => directory !== undefined).map(readManifest),
)
const manifest = manifests[0]!
// One class per adapter crate: every product must expose the identical surface.
if (manifests.some((other) => isDeepStrictEqual(other, manifest) === false) === true)
  throw new Error(
    'wasm and napi products expose different export manifests; build both from the same adapter crate',
  )
const { exports: exportEntries, errors } = manifest

// Schema records are produced by schemars inside the built product. Prefer the
// sandboxed wasm instance; the native addon is used when no wasm product exists.
// These runtime-selected Buck products expose CommonJS APIs, including native addons.
const require = createRequire(import.meta.url)
const productApi = async (): Promise<Record<string, unknown>> => {
  if (wasm !== undefined) {
    const { name } = JSON.parse(await readFile(join(wasm, 'package.json'), 'utf8')) as {
      name: string
    }
    // eslint-disable-next-line import/no-dynamic-require -- The wasm CommonJS entry point is selected from the runtime-provided Buck product directory and package name.
    return require(join(wasm, 'nodejs', `${name}.js`)) as Record<string, unknown>
  }
  // eslint-disable-next-line import/no-dynamic-require -- The native CommonJS addon wrapper is selected from the runtime-provided Buck product directory.
  return require(join(napi!, 'index.cjs')) as Record<string, unknown>
}
const api =
  exportEntries.some((entry) => entry.schema !== undefined) === true ? await productApi() : {}
const pascal = (value: string): string =>
  value
    .split(/[_-]/)
    .filter((part) => part !== '')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('')
const definitions: Record<string, unknown> = {}
const synthetic: Record<string, unknown> = {}
let vocabulary: Record<string, boolean> | undefined
// position key -> codec name in the generated contracts module
const codecs = new Map<string, string>()
const positionKey = ({ entry, position }: { entry: Export; position: string }): string =>
  `${entry.name}/${position}`
for (const entry of exportEntries) {
  if (entry.schema === undefined) continue
  const record = api[entry.schema]
  if (typeof record !== 'function')
    throw new Error(`Product lacks schema record ${entry.schema} for ${entry.name}`)
  const schema = JSON.parse(String(record())) as SchemaRecord
  vocabulary ??= schema.$vocabulary
  for (const [name, definition] of Object.entries(schema.$defs)) {
    if (
      Object.hasOwn(definitions, name) === true &&
      isDeepStrictEqual(definitions[name], definition) === false
    ) {
      throw new Error(
        `Contract definition ${name} differs between exports; give distinct Rust types distinct schema names`,
      )
    }
    definitions[name] = definition
  }
  const positions: [string, unknown][] = Object.entries(schema.args)
  if (schema.returns !== null) positions.push(['$returns', schema.returns])
  for (const [position, node] of positions) {
    const reference =
      typeof node === 'object' && node !== null && Object.keys(node).length === 1 && '$ref' in node
        ? node.$ref
        : undefined
    const match =
      typeof reference === 'string'
        ? /^#\/\$defs\/([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(reference)
        : null
    if (match !== null) {
      codecs.set(positionKey({ entry, position }), match[1]!)
      continue
    }
    // Inline positions (e.g. Vec<String>) become named aliases so they get a codec.
    const name = `${pascal(entry.name)}${position === '$returns' ? 'Result' : pascal(position)}`
    synthetic[name] = node
    codecs.set(positionKey({ entry, position }), name)
  }
}
let contracts: string | undefined
let document: unknown
if (codecs.size > 0) {
  for (const name of Object.keys(synthetic)) {
    if (Object.hasOwn(definitions, name) === true)
      throw new Error(`Generated contract name ${name} collides with a Rust contract type`)
  }
  // The importer emits one codec per $defs entry; any boundary codec can serve as the document root.
  // eslint-disable-next-line unicorn/no-array-sort -- This private Map-values array is sorted in place to avoid a redundant copy.
  const root = [...codecs.values()].sort()[0]!
  document = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $vocabulary: vocabulary,
    $defs: { ...definitions, ...synthetic },
    $ref: `#/$defs/${root}`,
  }
  // The compiler is a Buck input directory (package tree with its node_modules), so its path is runtime-selected.
  const { importRustSchema }: typeof CompilerModule = await import(
    // eslint-disable-next-line import/no-dynamic-require -- The compiler module is selected from the runtime-provided Buck input package tree.
    join(compiler, 'src', 'compiler', 'mod.ts')
  )
  contracts = importRustSchema(document, root).source
}
const codec = ({ entry, position }: { entry: Export; position: string }): string | undefined =>
  codecs.get(positionKey({ entry, position }))

const tsType = (wire: string): string => {
  const type = wire.replace(/\s+/g, '')
  if (['bytes', 'Bytes', 'Vec<u8>', '&[u8]'].includes(type) === true) return 'Uint8Array'
  if (['string', 'String', '&str'].includes(type) === true) return 'string'
  if (['u64', 'i64', 'u64_decimal', 'i64_decimal'].includes(type) === true) return 'bigint'
  if (/^(u|i)(8|16|32)$/.test(type) === true || ['number', 'f32', 'f64'].includes(type) === true)
    return 'number'
  if (['bool', 'boolean'].includes(type) === true) return 'boolean'
  if (['unit', '()', 'void'].includes(type) === true) return 'void'
  if (type === 'frame' || type.startsWith('frame<') === true) return 'Uint8Array'
  if (type.startsWith('host::Source') === true) return 'Interop.HostSource'
  if (type === 'json') return 'unknown'
  throw new Error(`Wire type ${wire} has no TypeScript mapping and no contract schema`)
}
const isWide = (wire: string): boolean =>
  ['u64', 'i64', 'u64_decimal', 'i64_decimal'].includes(wire)
// Effect-facing types: contract codecs decode to their Type.
const serviceType = ({
  entry,
  position,
  wire,
}: {
  entry: Export
  position: string
  wire: string
}): string => {
  const name = codec({ entry, position })
  return name === undefined ? tsType(wire) : `Contracts.${name}`
}
// Raw product API types: contract positions carry the codec's Encoded form.
const apiType = ({
  entry,
  position,
  wire,
}: {
  entry: Export
  position: string
  wire: string
}): string => {
  const name = codec({ entry, position })
  if (name !== undefined) return 'unknown'
  if (wire.startsWith('host::Source') === true) return 'Interop.SourceCallback'
  return isWide(wire) === true ? 'string' : tsType(wire)
}
const effectSchema = (wire: string): string => {
  const array = /^(?:Vec|array)<(.+)>$/.exec(wire.replace(/\s+/g, ''))
  if (array !== null) return `Schema.Array(${effectSchema(array[1]!)})`
  const type = tsType(wire)
  if (type === 'string') return 'Schema.String'
  if (type === 'number') return 'Schema.Int'
  if (type === 'bigint')
    return wire.startsWith('u') === true
      ? "Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 18446744073709551615n })).annotate({ [EffectRust.width]: 'u64' })"
      : "Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: -9223372036854775808n, maximum: 9223372036854775807n })).annotate({ [EffectRust.width]: 'i64' })"
  if (type === 'boolean') return 'Schema.Boolean'
  throw new Error(`Error reason field type ${wire} is not representable`)
}

const usesWidthAnnotation = errors.some((error) =>
  error.variants.some((variant) => variant.fields.some((field) => isWide(field.type))),
)
// Arguments only encode and results only decode; emit exactly the directions used.
const encoders = new Set(
  exportEntries.flatMap((entry) =>
    entry.args.flatMap((arg) => codec({ entry, position: arg.name }) ?? []),
  ),
)
const decoders = new Set(
  exportEntries.flatMap((entry) => codec({ entry, position: '$returns' }) ?? []),
)
const sinkDecodes = exportEntries.some(
  (entry) => entry.mode === 'input_stream' && codec({ entry, position: '$returns' }) !== undefined,
)
const usesErrors = exportEntries.some((entry) => entry.error !== null)
const effectImports = [
  'Context',
  'Effect',
  ...(usesErrors === true ? ['Schema'] : []),
  ...(exportEntries.some((entry) => entry.mode === 'input_stream') === true
    ? [sinkDecodes === true ? 'Sink' : 'type Sink']
    : []),
  ...(exportEntries.some((entry) => entry.mode === 'output_stream') === true
    ? ['type Stream']
    : []),
]
const source = [
  '// Generated from the compiled effect-rust export manifest and contract schemas. Do not edit.',
  `import { ${effectImports.join(', ')} } from 'effect'`,
  `import { Interop${codecs.size > 0 || usesErrors === true ? ', ContractJson' : ''}${usesWidthAnnotation === true ? ', EffectRust' : ''} } from '@overeng/effect-rust'`,
  ...(contracts === undefined ? [] : ["import * as Contracts from './contracts.ts'"]),
  '',
  'const decodeBoundary = (operation: string, cause: unknown): Effect.Effect<never, Interop.Input | Interop.Transport> => {',
  "  if (cause instanceof Error && cause.message.startsWith('RUST_INPUT:')) return Effect.fail(new Interop.Input({ operation, message: cause.message.slice(11), cause }))",
  "  if (cause instanceof Error && cause.message.startsWith('RUST_TRANSPORT:')) return Effect.fail(new Interop.Transport({ operation, message: cause.message.slice(15), cause }))",
  '  return Effect.die(cause)',
  '}',
]
if (codecs.size > 0) {
  source.push(
    'const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)',
    '// Contract encoding failures are caller input; Rust results violating their contract are transport breaches.',
    ...(encoders.size === 0
      ? []
      : [
          'const encodeInput = <A>(operation: string, encode: () => A) => Effect.try({ try: encode, catch: (cause) => new Interop.Input({ operation, message: message(cause), cause }) })',
        ]),
    ...(decoders.size === 0
      ? []
      : [
          'const decodeOutput = <A>(operation: string, decode: () => A) => Effect.try({ try: decode, catch: (cause) => new Interop.Transport({ operation, message: message(cause), cause }) })',
        ]),
    ...[...encoders]
      // eslint-disable-next-line unicorn/no-array-sort -- This private Set-values array is sorted in place to avoid a redundant copy.
      .sort()
      .map((name) => `const encode${name} = ContractJson.encodeValue(Contracts.${name})`),
    ...[...decoders]
      // eslint-disable-next-line unicorn/no-array-sort -- This private Set-values array is sorted in place to avoid a redundant copy.
      .sort()
      .map((name) => `const decode${name} = ContractJson.decodeValue(Contracts.${name})`),
  )
}
source.push('')
const errorNames = new Set<string>()
for (const entry of exportEntries) {
  if (entry.error === null || errorNames.has(entry.error.name) === true) continue
  errorNames.add(entry.error.name)
  const definition = errors.find((error) => error.name === entry.error!.name)
  if (definition === undefined)
    throw new Error(
      `Missing ExportError metadata for ${entry.error.name}; derive effect_rust::ExportError`,
    )
  const variants = definition.variants.map(
    (variant) =>
      `Schema.Struct({ _tag: Schema.Literal(${JSON.stringify(variant.name)}), ${variant.fields.map((field) => `${JSON.stringify(field.name)}: ${effectSchema(field.type)}`).join(', ')} })`,
  )
  source.push(
    `export const ${definition.name}Reason = ${variants.length === 1 ? variants[0] : `Schema.Union([${variants.join(', ')}])`}`,
    `const decode${definition.name}Reason = ContractJson.decodeValue(${definition.name}Reason)`,
    `export class ${definition.name} extends Schema.TaggedError<${definition.name}>()(${JSON.stringify(definition.name)}, { reason: ${definition.name}Reason }) {}`,
    `const decode${definition.name} = (cause: unknown): Effect.Effect<never, ${definition.name} | Interop.Input | Interop.Transport> => {`,
    `  if (!(cause instanceof Error) || !cause.message.startsWith('RUST_ERROR:')) return decodeBoundary(${JSON.stringify(definition.name)}, cause)`,
    '  return Effect.gen(function* () {',
    '    const reason = yield* Effect.try({ try: () => JSON.parse(cause.message.slice(11)) as unknown, catch: () => cause }).pipe(Effect.orDie)',
    `    if (typeof reason !== 'object' || reason === null || !(${JSON.stringify(definition.tagKey)} in reason)) return yield* Effect.die(cause)`,
    `    const { ${JSON.stringify(definition.tagKey)}: _tag, ...fields } = reason`,
    `    const decoded = yield* Effect.try({ try: () => decode${definition.name}Reason({ ...fields, _tag }), catch: () => cause }).pipe(Effect.orDie)`,
    `    return yield* Effect.fail(new ${definition.name}({ reason: decoded }))`,
    '  })',
    '}',
    '',
  )
}

source.push(
  `/** Raw product API: contract positions carry their encoded wire form. */`,
  `export interface ${service}Api {`,
)
for (const entry of exportEntries) {
  const args = entry.args
    .map((arg) => `${arg.name}: ${apiType({ entry, position: arg.name, wire: arg.type })}`)
    .join(', ')
  const result = apiType({ entry, position: '$returns', wire: entry.returns })
  const returns =
    entry.mode === 'input_stream'
      ? `Interop.InputHandle<${result}>`
      : entry.mode === 'output_stream'
        ? 'Interop.OutputHandle'
        : entry.mode === 'async'
          ? `Interop.RustJob<${result}>`
          : result
  source.push(`  readonly ${entry.name}: (${args}) => ${returns}`)
}
source.push('}', '', `export interface ${service}Service {`)
for (const entry of exportEntries) {
  const args = entry.args
    .map((arg) => `${arg.name}: ${serviceType({ entry, position: arg.name, wire: arg.type })}`)
    .join(', ')
  const result = serviceType({ entry, position: '$returns', wire: entry.returns })
  const error = [entry.error?.name, 'Interop.Input', 'Interop.Transport']
    .filter((type) => type !== undefined)
    .join(' | ')
  const returns =
    entry.mode === 'input_stream'
      ? `Sink.Sink<${result}, Uint8Array, never, ${error}>`
      : entry.mode === 'output_stream'
        ? `Stream.Stream<Uint8Array, ${error}>`
        : `Effect.Effect<${result}, ${error}>`
  source.push(`  readonly ${entry.name}: (${args}) => ${returns}`)
}
source.push(
  '}',
  '',
  `export const make${service} = (runtime: Interop.Runtime<${service}Api>): ${service}Service => ({`,
)
for (const entry of exportEntries) {
  const operation = JSON.stringify(entry.name)
  const args = entry.args
    .map((arg) => `${arg.name}: ${serviceType({ entry, position: arg.name, wire: arg.type })}`)
    .join(', ')
  const sources = entry.args.filter((arg) => arg.type.startsWith('host::Source'))
  const encoded = entry.args.filter((arg) => codec({ entry, position: arg.name }) !== undefined)
  // Encoded contract arguments are bound as `<name>Wire` before the Rust call.
  const values = entry.args
    .map((arg) =>
      sources.includes(arg) === true
        ? `read_${arg.name}`
        : encoded.includes(arg) === true
          ? `${arg.name}Wire`
          : isWide(arg.type) === true
            ? `${arg.name}.toString()`
            : arg.name,
    )
    .join(', ')
  const callOptions = `{ decodeError: ${entry.error === null ? `(cause: unknown) => decodeBoundary(${operation}, cause)` : `decode${entry.error.name}`} }`
  const method =
    entry.mode === 'input_stream'
      ? 'inputSink'
      : entry.mode === 'output_stream'
        ? 'outputStream'
        : 'call'
  const resultCodec = codec({ entry, position: '$returns' })
  const start =
    sources.length === 0
      ? [`runtime.${method}(({ api }) => api.${entry.name}(${values}), ${callOptions})`]
      : [
          `runtime.call(({ api, signal }): Interop.RustJob<${apiType({ entry, position: '$returns', wire: entry.returns })}> => {`,
          '    const pending = new Set<Promise<Uint8Array>>()',
          ...sources.flatMap((sourceArgument) => {
            const mode =
              sourceArgument.type.includes('SettleOnly') === true ? 'settle-only' : 'abortable'
            return [
              `    if (${sourceArgument.name}.mode !== ${JSON.stringify(mode)}) throw new Error(${JSON.stringify(`RUST_INPUT:${sourceArgument.name} requires ${mode} cancellation`)})`,
              `    const read_${sourceArgument.name}: Interop.SourceCallback = (request) => {`,
              `      const operation = ${sourceArgument.name}.call(signal, request)`,
              '      pending.add(operation)',
              '      void operation.then(() => pending.delete(operation), () => pending.delete(operation))',
              '      return operation',
              '    }',
            ]
          }),
          `    const job = api.${entry.name}(${values})`,
          "    if (job.mode === 'settle-only') return job",
          '    return { ...job, cancel: async () => { await job.cancel(); await Promise.allSettled(pending) } }',
          `  }, ${callOptions})`,
        ]
  const decode =
    resultCodec !== undefined
      ? method === 'call'
        ? `.pipe(Effect.flatMap((result) => decodeOutput(${operation}, () => decode${resultCodec}(result))))`
        : method === 'inputSink'
          ? `.pipe(Sink.mapEffect((result) => decodeOutput(${operation}, () => decode${resultCodec}(result))))`
          : ''
      : isWide(entry.returns) === true && method === 'call'
        ? '.pipe(Effect.map(BigInt))'
        : ''
  if (encoded.length === 0) {
    source.push(`  ${entry.name}: (${args}) => ${start.join('\n')}${decode},`)
  } else if (method === 'call') {
    source.push(
      `  ${entry.name}: (${args}) => Effect.gen(function* () {`,
      ...encoded.map(
        (arg) =>
          `    const ${arg.name}Wire = yield* encodeInput(${operation}, () => encode${codec({ entry, position: arg.name })}(${arg.name}))`,
      ),
      `    return yield* ${start.join('\n')}${decode}`,
      '  }),',
    )
  } else {
    throw new Error(
      `${entry.name}: contract arguments are supported for call exports; streams take bytes`,
    )
  }
}
source.push('})', '')

// Generated loaders import lazily: declaring the class never loads a product, and
// each runtime resolves only the platform-specific product it constructs (the
// native addon does not exist in browsers or Workers).
const loaders: string[] = []
if (wasm !== undefined) {
  source.push(
    `const wasmLoaders: Interop.WasmLoaders<${service}Api> = {`,
    "  node: () => import('./wasm/web/load.js').then((module) => module.load()),",
    "  bun: () => import('./wasm/web/load.js').then((module) => module.load()),",
    "  browser: () => import('./wasm/web/load.js').then((module) => module.load()),",
    "  worker: () => import('./wasm/worker-load.js').then((module) => module.load()),",
    '}',
  )
  loaders.push('wasm: wasmLoaders')
}
if (napi !== undefined) {
  source.push(
    `const nativeLoaders: Interop.NativeLoaders<${service}Api> = {`,
    "  node: () => import('./native/load.cjs').then((module) => module.load()),",
    "  bun: () => import('./native/load.cjs').then((module) => module.load()),",
    '}',
  )
  loaders.push('native: nativeLoaders')
}
source.push(
  '',
  '/** Generic escape hatch: fresh lexical instances per call, for a consumer-owned tag with `Interop.wasmLayer` / `Interop.nativeLayer`. */',
  `export const load = { ${loaders
    .map((entry) => entry.split(':')[0])
    .map((key) => `${key}: ${key}Loaders`)
    .join(', ')} } as const`,
  '',
  `export class ${service} extends Context.Service<${service}, ${service}Service>()(${JSON.stringify(`${packageName}/${service}`)}) {`,
  ...(wasm === undefined
    ? []
    : [
        `  static readonly layerWasm: Interop.WasmLayers<${service}> = Interop.defineStatics(${service}, { make: make${service}, wasm: wasmLoaders }).layerWasm`,
      ]),
  ...(napi === undefined
    ? []
    : [
        `  static readonly layerNative: Interop.NativeLayers<${service}> = Interop.defineStatics(${service}, { make: make${service}, native: nativeLoaders }).layerNative`,
      ]),
  '}',
  '',
)

await mkdir(output, { recursive: true })
await writeFile(join(output, 'service.ts'), source.join('\n'))
await writeFile(join(output, 'exports.json'), JSON.stringify(manifest, undefined, 2) + '\n')
if (contracts !== undefined) {
  await writeFile(join(output, 'contracts.ts'), contracts)
  await writeFile(
    join(output, 'contracts.schema.json'),
    JSON.stringify(document, undefined, 2) + '\n',
  )
}
const packageExports: Record<string, string> = {
  '.': './service.ts',
  './exports.json': './exports.json',
}
if (contracts !== undefined)
  Object.assign(packageExports, {
    './contracts': './contracts.ts',
    './contracts.schema.json': './contracts.schema.json',
  })
if (wasm !== undefined) {
  // Products are copied, not linked: the typed declarations below replace the products' untyped ones.
  await cp(wasm, join(output, 'wasm'), { recursive: true, dereference: true })
  const instance = `{ api: ${service}Api; release(): void }`
  await writeFile(
    join(output, 'wasm', 'web', 'load.d.ts'),
    `import type { ${service}Api } from '../../service.ts';\nexport declare const load: (source?: WebAssembly.Module | BufferSource) => Promise<${instance}>;\n`,
  )
  await writeFile(
    join(output, 'wasm', 'worker-load.d.ts'),
    `import type { ${service}Api } from '../service.ts';\nexport declare const load: () => ${instance};\n`,
  )
}
if (napi !== undefined) {
  await cp(napi, join(output, 'native'), { recursive: true, dereference: true })
  await writeFile(
    join(output, 'native', 'load.d.cts'),
    `import type { ${service}Api } from '../service.ts';\nexport declare const load: () => { api: ${service}Api; release(): void };\n`,
  )
}
await writeFile(
  join(output, 'package.json'),
  JSON.stringify(
    { name: packageName, private: true, version: '0.0.0', type: 'module', exports: packageExports },
    undefined,
    2,
  ) + '\n',
)
