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
  readonly resource?: {
    readonly name: string
    readonly type: string
    readonly role: 'constructor' | 'method' | 'close'
    readonly method: string
    readonly concurrency: 'serial'
  }
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
const constructors = exportEntries.filter((entry) => entry.resource?.role === 'constructor')
const topLevelEntries = exportEntries.filter((entry) => entry.resource === undefined || entry.resource.role === 'constructor')
const resourceMethods = (entry: Export): readonly Export[] =>
  exportEntries.filter((method) => method.resource?.role === 'method' && method.resource.name === entry.resource?.name)

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
    const name = `${pascal(entry.name)}${position === '$returns' ? 'Output' : `Input${pascal(position)}`}`
    if (
      Object.hasOwn(synthetic, name) === true &&
      isDeepStrictEqual(synthetic[name], node) === false
    )
      throw new Error(`Generated contract name ${name} collides between inline schemas`)
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
  return tsType(wire)
}
const effectSchema = (wire: string): string => {
  const array = /^(?:Vec|array)<(.+)>$/.exec(wire.replace(/\s+/g, ''))
  if (array !== null) return `Schema.Array(${effectSchema(array[1]!)})`
  const type = tsType(wire)
  if (type === 'string') return 'Schema.String'
  if (type === 'number') {
    const integer = /^(u|i)(8|16|32)$/.exec(wire.replace(/\s+/g, ''))
    if (integer === null) throw new Error(`Error reason field type ${wire} is not representable`)
    const bits = Number(integer[2])
    const signed = integer[1] === 'i'
    const minimum = signed === true ? -(2 ** (bits - 1)) : 0
    const maximum = 2 ** (signed === true ? bits - 1 : bits) - 1
    return `Schema.Int.check(Schema.isBetween({ minimum: ${minimum}, maximum: ${maximum} }))`
  }
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
const syncEntry = (entry: Export): boolean =>
  entry.mode === 'sync' && entry.resource === undefined
const syncEncodes = exportEntries.some((entry) => syncEntry(entry) && entry.args.some((arg) => codec({ entry, position: arg.name }) !== undefined))
const asyncEncodes = exportEntries.some((entry) => !syncEntry(entry) && entry.args.some((arg) => codec({ entry, position: arg.name }) !== undefined))
const syncDecodes = exportEntries.some((entry) => syncEntry(entry) && codec({ entry, position: '$returns' }) !== undefined)
const asyncDecodes = exportEntries.some((entry) => !syncEntry(entry) && codec({ entry, position: '$returns' }) !== undefined)
const sinkDecodes = exportEntries.some(
  (entry) => entry.mode === 'input_stream' && codec({ entry, position: '$returns' }) !== undefined,
)
const usesErrors = exportEntries.some((entry) => entry.error !== null)
const effectImports = [
  'Context',
  'Effect',
  ...(constructors.length === 0 ? [] : ['type Scope']),
  ...(usesErrors === true ? ['Schema'] : []),
  ...(exportEntries.some((entry) => entry.mode === 'input_stream') === true
    ? [sinkDecodes === true ? 'Sink' : 'type Sink']
    : []),
  ...(exportEntries.some((entry) => entry.mode === 'output_stream') === true
    ? ['type Stream']
    : []),
]
const preparations: string[] = []
const source = [
  '// Generated from the compiled effect-rust export manifest and contract schemas. Do not edit.',
  `import { ${effectImports.join(', ')} } from 'effect'`,
  `import { Interop${codecs.size > 0 || usesErrors === true ? ', Direct' : ''}${usesWidthAnnotation === true ? ', EffectRust' : ''} } from '@overeng/effect-rust'`,
  ...(contracts === undefined ? [] : ["import * as Contracts from './contracts.ts'"]),
  '',
  'const decodeBoundary = (operation: string, cause: unknown): Effect.Effect<never, Interop.Input | Interop.Transport> => {',
  '  if (cause instanceof Interop.Input || cause instanceof Interop.Transport) return Effect.fail(cause)',
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
          ...(asyncEncodes ? ['const encodeInput = <A>(operation: string, encode: () => A) => Effect.try({ try: encode, catch: (cause) => new Interop.Input({ operation, message: message(cause), cause }) })'] : []),
          ...(syncEncodes ? ['const encodeInputSync = <A>(operation: string, encode: () => A): A => { try { return encode() } catch (cause) { throw new Interop.Input({ operation, message: message(cause), cause }) } }'] : []),
        ]),
    ...(decoders.size === 0
      ? []
      : [
          ...(asyncDecodes ? ['const decodeOutput = <A>(operation: string, decode: () => A) => Effect.try({ try: decode, catch: (cause) => new Interop.Transport({ operation, message: message(cause), cause }) })'] : []),
          ...(syncDecodes ? ['const decodeOutputSync = <A>(operation: string, decode: () => A): A => { try { return decode() } catch (cause) { throw new Interop.Transport({ operation, message: message(cause), cause }) } }'] : []),
        ]),
  )
  preparations.push(
    ...[...encoders]
      // eslint-disable-next-line unicorn/no-array-sort -- This private Set-values array is sorted in place to avoid a redundant copy.
      .sort()
      .map((name) => `  const encode${name} = Direct.encode(Contracts.${name})`),
    ...[...decoders]
      // eslint-disable-next-line unicorn/no-array-sort -- This private Set-values array is sorted in place to avoid a redundant copy.
      .sort()
      .map((name) => `  const decode${name} = Direct.decode(Contracts.${name})`),
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
    `export class ${definition.name} extends Schema.TaggedError<${definition.name}>()(${JSON.stringify(definition.name)}, { reason: ${definition.name}Reason }) {}`,
  )
  preparations.push(
    `  const decode${definition.name}Reason = Direct.decode(${definition.name}Reason)`,
    `const decode${definition.name} = (cause: unknown): Effect.Effect<never, ${definition.name} | Interop.Input | Interop.Transport> => {`,
    `  if (typeof cause !== 'object' || cause === null || !('rustError' in cause)) return decodeBoundary(${JSON.stringify(definition.name)}, cause)`,
    '  const reason = cause.rustError',
    `  if (typeof reason !== 'object' || reason === null || !(${JSON.stringify(definition.tagKey)} in reason)) return Effect.die(cause)`,
    `  const { ${JSON.stringify(definition.tagKey)}: _tag, ...fields } = reason`,
    '  try {',
    `    return Effect.fail(new ${definition.name}({ reason: decode${definition.name}Reason({ ...fields, _tag }) }))`,
    '  } catch { return Effect.die(cause) }',
    '}',
    '',
  )
}

for (const constructor of constructors) {
  const type = constructor.resource!.type
  source.push(`export interface ${type}Api extends Interop.ResourceHandle {`)
  for (const entry of resourceMethods(constructor)) {
    const args = entry.args.map((arg) => `${arg.name}: ${apiType({ entry, position: arg.name, wire: arg.type })}`).join(', ')
    source.push(`  readonly ${entry.resource!.method}: (${args}) => ${apiType({ entry, position: '$returns', wire: entry.returns })}`)
  }
  source.push('}', `export interface ${type} {`, '  readonly close: Effect.Effect<void>')
  for (const entry of resourceMethods(constructor)) {
    const args = entry.args.map((arg) => `${arg.name}: ${serviceType({ entry, position: arg.name, wire: arg.type })}`).join(', ')
    const error = [entry.error?.name, 'Interop.Input', 'Interop.Transport'].filter((value) => value !== undefined).join(' | ')
    source.push(`  readonly ${entry.resource!.method}: (${args}) => Effect.Effect<${serviceType({ entry, position: '$returns', wire: entry.returns })}, ${error}>`)
  }
  source.push('}', '')
}
source.push(
  `/** Raw product API: contract positions carry their encoded wire form. */`,
  `export interface ${service}Api {`,
)
for (const entry of topLevelEntries) {
  const args = entry.args
    .map((arg) => `${arg.name}: ${apiType({ entry, position: arg.name, wire: arg.type })}`)
    .join(', ')
  const result = entry.resource?.role === 'constructor' ? `${entry.resource.type}Api` : apiType({ entry, position: '$returns', wire: entry.returns })
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
for (const entry of topLevelEntries) {
  const args = entry.args
    .map((arg) => `${arg.name}: ${serviceType({ entry, position: arg.name, wire: arg.type })}`)
    .join(', ')
  const result = entry.resource?.role === 'constructor' ? entry.resource.type : serviceType({ entry, position: '$returns', wire: entry.returns })
  const error = [entry.error?.name, 'Interop.Input', 'Interop.Transport']
    .filter((type) => type !== undefined)
    .join(' | ')
  const returns =
    entry.resource?.role === 'constructor'
      ? `Effect.Effect<${result}, never, Scope.Scope>`
      : entry.mode === 'input_stream'
      ? `Sink.Sink<${result}, Uint8Array, never, ${error}>`
      : entry.mode === 'output_stream'
        ? `Stream.Stream<Uint8Array, ${error}>`
        : `Effect.Effect<${result}, ${error}>`
  source.push(`  readonly ${entry.name}: (${args}) => ${returns}`)
}
source.push('}', '')
const implementations = new Map<string, string[]>()
for (const entry of exportEntries) {
  if (entry.resource?.role === 'constructor' || entry.resource?.role === 'close') continue
  const methodSource: string[] = []
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
          : arg.name,
    )
    .join(', ')
  const callOptions = `options_${entry.name}`
  preparations.push(`  const ${callOptions} = { decodeError: ${entry.error === null ? `(cause: unknown) => decodeBoundary(${operation}, cause)` : `decode${entry.error.name}`} }`)
  const method =
    entry.mode === 'input_stream'
      ? 'inputSink'
      : entry.mode === 'output_stream'
        ? 'outputStream'
        : 'call'
  const resultCodec = codec({ entry, position: '$returns' })
  // Validate the original number before wasm-bindgen/napi can narrow the ABI.
  // Reject negative zero, just as the canonical decimal integer boundary does.
  const scalarChecks = entry.args.flatMap((arg) => {
    const width = /^(u|i)(8|16|32)$/.exec(arg.type)
    if (width === null) return []
    const bits = Number(width[2])
    const signed = width[1] === 'i'
    const minimum = signed === true ? -(2 ** (bits - 1)) : 0
    const maximum = 2 ** (signed === true ? bits - 1 : bits) - 1
    return [
      `if (!Number.isInteger(${arg.name}) || Object.is(${arg.name}, -0) || ${arg.name} < ${minimum} || ${arg.name} > ${maximum}) throw new Error(${JSON.stringify(`RUST_INPUT:${arg.name} must be a canonical ${arg.type} integer`)})`,
    ]
  })
  const start =
    sources.length === 0
      ? [
          scalarChecks.length === 0
            ? `${entry.resource?.role === 'method' ? 'resource' : 'runtime'}.${method}(({ api }) => api.${entry.resource?.method ?? entry.name}(${values}), ${callOptions})`
            : `${entry.resource?.role === 'method' ? 'resource' : 'runtime'}.${method}(({ api }) => { ${scalarChecks.join('; ')}; return api.${entry.resource?.method ?? entry.name}(${values}) }, ${callOptions})`,
        ]
      : [
          `runtime.call(({ api, signal }): Interop.RustJob<${apiType({ entry, position: '$returns', wire: entry.returns })}> => {`,
          ...scalarChecks.map((check) => `    ${check}`),
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
      : ''
  const sync = method === 'call' && entry.mode !== 'async' && entry.resource?.role !== 'method'
  if (sync) {
    methodSource.push(
      `  ${entry.name}: (${args}) => runtime.callSync((api) => {`,
      ...encoded.map((arg) => `    const ${arg.name}Wire = encodeInputSync(${operation}, () => encode${codec({ entry, position: arg.name })}(${arg.name}))`),
      resultCodec === undefined
        ? `    return api.${entry.name}(${values})`
        : `    const result = api.${entry.name}(${values})`,
      ...(resultCodec === undefined ? [] : [`    return decodeOutputSync(${operation}, () => decode${resultCodec}(result))`]),
      `  }, ${callOptions}),`,
    )
  } else if (encoded.length === 0) {
    methodSource.push(`  ${entry.resource?.method ?? entry.name}: (${args}) => ${start.join('\n')}${decode},`)
  } else if (method === 'call') {
    methodSource.push(
      `  ${entry.resource?.method ?? entry.name}: (${args}) => Effect.gen(function* () {`,
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
  implementations.set(entry.name, methodSource)
}
source.push(`export const make${service} = (runtime: Interop.Runtime<${service}Api>): ${service}Service => {`, '  Interop.assertEffectCohort(Effect)', ...preparations, '  return {')
for (const entry of topLevelEntries) {
  if (entry.resource?.role !== 'constructor') {
    source.push(...implementations.get(entry.name)!)
    continue
  }
  const args = entry.args.map((arg) => `${arg.name}: ${serviceType({ entry, position: arg.name, wire: arg.type })}`).join(', ')
  const encoded = entry.args.filter((arg) => codec({ entry, position: arg.name }) !== undefined)
  const values = entry.args.map((arg) => encoded.includes(arg) ? `${arg.name}Wire` : arg.name).join(', ')
  source.push(
    `  ${entry.name}: (${args}) => Effect.gen(function* () {`,
    ...encoded.map((arg) => `    const ${arg.name}Wire = yield* encodeInput(${JSON.stringify(entry.name)}, () => encode${codec({ entry, position: arg.name })}(${arg.name})).pipe(Effect.orDie)`),
    `    const resource = yield* runtime.resource(({ api }) => api.${entry.name}(${values}))`,
    '    return {',
    '      close: resource.close,',
    ...resourceMethods(entry).flatMap((method) => implementations.get(method.name)!),
    '    }',
    '  }),',
  )
}
source.push('  }', '}', '')

// Generated loaders import lazily: declaring the class never loads a product, and
// each runtime resolves only the platform-specific product it constructs (the
// native addon does not exist in browsers or Workers).
const loaders: string[] = []
if (wasm !== undefined) {
  source.push(
    `const wasmLoaders: Interop.WasmLoaders<${service}Api> = {`,
    "  node: () => import('./wasm/web/inline-load.js').then((module) => module.load()),",
    "  bun: () => import('./wasm/web/inline-load.js').then((module) => module.load()),",
    "  browser: () => import('./wasm/web/load.js').then((module) => module.load()),",
    "  browserWorker: () => import('./wasm/web/load.js').then((module) => module.load()),",
    "  workerd: () => import('./wasm/workerd-load.js').then((module) => module.load()),",
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
  const instance = `{ api: ${service}Api; release(): void; observePanic(observer: (cause: unknown) => void): () => void }`
  await writeFile(
    join(output, 'wasm', 'web', 'load.d.ts'),
    `import type { ${service}Api } from '../../service.ts';\ntype Source = WebAssembly.Module | BufferSource | RequestInfo | URL | Response;\nexport declare const load: (source?: Source | Promise<Source>) => Promise<${instance}>;\n`,
  )
  await writeFile(
    join(output, 'wasm', 'web', 'inline-load.d.ts'),
    `import type { ${service}Api } from '../../service.ts';\nexport declare const load: (source?: WebAssembly.Module | BufferSource) => Promise<${instance}>;\n`,
  )
  await writeFile(
    join(output, 'wasm', 'workerd-load.d.ts'),
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
