import { SchemaRepresentation as R } from 'effect'

import { assertPortablePattern } from '../schema/pattern.ts'
import { reject, type ContractIR, type Definition, type Type, type Width } from './ir.ts'
import { EFFECT_RUST_VOCABULARY } from './json-schema.ts'

const referencesType = ({ type, name }: { type: Type; name: string }): boolean => {
  switch (type.kind) {
    case 'ref':
      return type.name === name
    case 'array':
      return referencesType({ type: type.item, name })
    case 'nullable':
    case 'patch':
      return referencesType({ type: type.inner, name })
    case 'record':
      return referencesType({ type: type.key, name }) || referencesType({ type: type.value, name })
    default:
      return false
  }
}

const collect = ({ type, refs }: { type: Type; refs: Set<string> }): void => {
  switch (type.kind) {
    case 'ref':
      refs.add(type.name)
      break
    case 'nullable':
    case 'patch':
      collect({ type: type.inner, refs })
      break
    case 'array':
      collect({ type: type.item, refs })
      break
    case 'record':
      collect({ type: type.key, refs })
      collect({ type: type.value, refs })
      break
  }
}

const semantic = ({
  runtime,
  Type,
  parameters = [],
}: {
  runtime: string
  Type: string
  parameters?: readonly R.Representation[]
}): R.Declaration => ({
  _tag: 'Declaration',
  checks: [],
  typeParameters: parameters,
  annotations: {
    toCode: ({ typeParameters }: R.Generation.DeclarationInput) => ({
      runtime: runtime.replaceAll('$inner', typeParameters[0]?.runtime ?? ''),
      Type: Type.replaceAll('$inner', typeParameters[0]?.Type ?? ''),
    }),
  },
})

const filter = (runtime: string): R.Check => ({
  _tag: 'Filter',
  aborted: false,
  annotations: { toCode: () => ({ runtime }) },
})

const recursiveRuntime = (runtime: string): string =>
  runtime.replace(/Schema\.Codec<([A-Za-z_$][A-Za-z0-9_$]*)>/gu, 'Schema.Codec<$1, unknown>')

type Node = Record<string, unknown>
const metadata: Readonly<Record<string, true>> = {
  title: true,
  description: true,
  $comment: true,
  default: true,
  examples: true,
  deprecated: true,
  readOnly: true,
  writeOnly: true,
}
const documentKeys: Readonly<Record<string, true>> = {
  $schema: true,
  $id: true,
  $vocabulary: true,
  $defs: true,
  definitions: true,
}
const ranges: Readonly<Record<Width, readonly [number, number]>> = {
  u8: [0, 255],
  u16: [0, 65535],
  u32: [0, 4294967295],
  i32: [-2147483648, 2147483647],
}
const formats: Readonly<Record<string, Width>> = {
  uint8: 'u8',
  uint16: 'u16',
  uint32: 'u32',
  int32: 'i32',
}
const object = ({ value, path }: { value: unknown; path: string }): Node => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true)
    return reject(path, 'boolean or malformed schema', 'Use an explicit portable schema object')
  return value as Node
}
const token = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1')
const allowed = ({
  node,
  keys,
  path,
}: {
  node: Node
  keys: readonly string[]
  path: string
}): void => {
  for (const key of Object.keys(node)) {
    if (Object.hasOwn(metadata, key) === false && keys.includes(key) === false)
      reject(
        `${path}/${token(key)}`,
        `unsupported keyword ${key}`,
        'Remove this feature or supply a reviewed lossless lowering; constraints are never silently discarded',
      )
  }
}
const namePattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u
const reserved: Readonly<Record<string, true>> = {
  Schema: true,
  Wire: true,
  decode: true,
  encode: true,
  await: true,
  break: true,
  case: true,
  catch: true,
  class: true,
  const: true,
  continue: true,
  debugger: true,
  default: true,
  delete: true,
  do: true,
  else: true,
  enum: true,
  export: true,
  extends: true,
  false: true,
  finally: true,
  for: true,
  function: true,
  if: true,
  import: true,
  in: true,
  instanceof: true,
  new: true,
  null: true,
  return: true,
  super: true,
  switch: true,
  this: true,
  throw: true,
  true: true,
  try: true,
  typeof: true,
  var: true,
  void: true,
  while: true,
  with: true,
  yield: true,
  implements: true,
  interface: true,
  let: true,
  package: true,
  private: true,
  protected: true,
  public: true,
  static: true,
  arguments: true,
  eval: true,
  type: true,
  any: true,
  unknown: true,
  never: true,
  string: true,
  number: true,
  boolean: true,
  bigint: true,
  symbol: true,
  object: true,
  undefined: true,
}

/** Strict schemars admission with path/remedy failures, followed by Effect's representation renderer.
 * Generated modules export the renderer's normalized schema names and strict Wire.decode/encode entry points.
 * Recursive decoded types are preserved; their encoded view is unknown because Wire transforms differ from the
 * decoded view assumed by the upstream suspension renderer. Validation and wire codecs remain fully enforced.
 */
// eslint-disable-next-line overeng/named-args -- Preserve the public importRustSchema positional SDK signature.
export const importRustSchema = (
  document: unknown,
  importName?: string,
): { readonly ir: ContractIR; readonly source: string } => {
  const doc = object({ value: document, path: '$' })
  const rootName = importName ?? (typeof doc.title === 'string' ? doc.title : 'Contract')
  const defs: Record<string, Definition> = Object.create(null)
  const inputDefs: Record<string, unknown> = Object.create(null)
  const names = new Set<string>()
  const discriminatorDefinitions = new Set<string>()
  const validateName = ({ value, path }: { value: string; path: string }): void => {
    const emitted = value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
    if (
      namePattern.test(value) === false ||
      Object.hasOwn(reserved, value) === true ||
      emitted === 'Schema' ||
      emitted === 'Wire'
    )
      reject(
        path,
        `invalid Effect export identifier ${value}`,
        'Use a JavaScript identifier that is not a reserved word or a generated import name (Schema or Wire)',
      )
  }
  validateName({ value: rootName, path: '$/title' })
  names.add(rootName)
  for (const container of ['$defs', 'definitions']) {
    if (doc[container] === undefined) continue
    for (const [key, value] of Object.entries(
      object({ value: doc[container], path: `$/${container}` }),
    )) {
      validateName({ value: key, path: `$/${container}/${token(key)}` })
      if (Object.hasOwn(inputDefs, key) === true)
        reject(
          `$/${container}/${token(key)}`,
          'duplicate definition',
          'Use one definition namespace',
        )
      inputDefs[key] = value
      names.add(key)
    }
  }
  if (
    doc.$schema !== undefined &&
    [
      'https://json-schema.org/draft/2020-12/schema',
      'http://json-schema.org/draft-07/schema#',
      'https://json-schema.org/draft-07/schema',
    ].includes(String(doc.$schema)) === false
  )
    reject(
      '$/$schema',
      'unsupported schema dialect',
      'Export schemars 1.x Draft 2020-12 JSON Schema',
    )
  if (doc.$vocabulary !== undefined) {
    for (const [uri, required] of Object.entries(
      object({ value: doc.$vocabulary, path: '$/$vocabulary' }),
    )) {
      if (
        typeof required !== 'boolean' ||
        (uri !== EFFECT_RUST_VOCABULARY &&
          [
            'https://json-schema.org/draft/2020-12/vocab/core',
            'https://json-schema.org/draft/2020-12/vocab/applicator',
            'https://json-schema.org/draft/2020-12/vocab/validation',
            'https://json-schema.org/draft/2020-12/vocab/meta-data',
            'https://json-schema.org/draft/2020-12/vocab/format-annotation',
          ].includes(uri) === false)
      )
        reject(
          `$/$vocabulary/${token(uri)}`,
          'unknown vocabulary',
          `Use ${EFFECT_RUST_VOCABULARY} and the supported Draft 2020-12 vocabularies`,
        )
    }
  }
  const allocate = (seed: string): string => {
    let candidate = seed.replace(/[^A-Za-z0-9_$]/gu, '_')
    if (/^[A-Za-z_$]/u.test(candidate) === false) candidate = `_${candidate}`
    if (Object.hasOwn(reserved, candidate) === true) candidate = `_${candidate}`
    let suffix = 0
    const base = candidate
    while (names.has(candidate) === true) candidate = `${base}_${++suffix}`
    names.add(candidate)
    return candidate
  }
  const named = ({
    definition,
    path,
    preferred,
  }: {
    definition: Definition
    path: string
    preferred?: string
  }): Type => {
    const key = preferred ?? allocate(`${rootName}_${path.split('/').at(-1) ?? 'Value'}`)
    defs[key] = definition
    return { kind: 'ref', name: key }
  }
  const admitsNull = ({
    type,
    seen = new Set<string>(),
  }: {
    type: Type
    seen?: Set<string>
  }): boolean => {
    if (type.kind === 'null' || type.kind === 'nullable') return true
    if (type.kind !== 'ref' || seen.has(type.name) === true) return false
    seen.add(type.name)
    const definition = defs[type.name]
    return definition?.kind === 'alias' && admitsNull({ type: definition.type, seen })
  }
  const lower = ({
    input,
    path,
    preferred,
    property = false,
  }: {
    input: unknown
    path: string
    preferred?: string
    property?: boolean
  }): Type => {
    const node = object({ value: input, path })
    if (node['x-effect-rust-patch'] !== undefined) {
      if (node['x-effect-rust-patch'] !== true || property === false)
        return reject(
          `${path}/x-effect-rust-patch`,
          'Patch requires an object property',
          'Mark an omittable nullable object property with x-effect-rust-patch:true',
        )
      const copy = { ...node }
      delete copy['x-effect-rust-patch']
      const lowered = lower({ input: copy, path, preferred: undefined })
      if (lowered.kind !== 'nullable')
        return reject(
          path,
          'Patch wire schema must admit null and a value',
          'Use anyOf:[{type:"null"}, valueSchema] plus x-effect-rust-patch:true',
        )
      if (admitsNull({ type: lowered.inner }) === true)
        return reject(
          path,
          'Patch value overlaps its explicit Null state',
          'Use a nonnullable inner value schema so Null and Value remain distinguishable',
        )
      return { kind: 'patch', inner: lowered.inner }
    }
    if (node.$ref !== undefined) {
      allowed({ node, keys: ['$ref'], path })
      if (typeof node.$ref !== 'string')
        return reject(`${path}/$ref`, 'malformed reference', 'Use a local definition JSON Pointer')
      if (node.$ref === '#') return { kind: 'ref', name: rootName }
      const match = /^#\/(?:\$defs|definitions)\/([^/]+)$/u.exec(node.$ref)
      if (match === null)
        return reject(
          `${path}/$ref`,
          'external or deep reference',
          'Use #/$defs/Name or #/definitions/Name',
        )
      let key: string
      try {
        key = decodeURIComponent(match[1]!).replaceAll('~1', '/').replaceAll('~0', '~')
      } catch {
        return reject(`${path}/$ref`, 'invalid URI escape', 'Use a valid JSON Pointer fragment')
      }
      if (Object.hasOwn(inputDefs, key) === false)
        return reject(
          `${path}/$ref`,
          `missing definition ${key}`,
          'Include the referenced definition in $defs',
        )
      return { kind: 'ref', name: key }
    }
    if (node.allOf !== undefined) {
      allowed({ node, keys: ['allOf'], path })
      if (Array.isArray(node.allOf) === false || node.allOf.length !== 1)
        return reject(
          `${path}/allOf`,
          'general intersection',
          'Export one direct schema; only schemars single-reference allOf wrappers are supported',
        )
      return lower({ input: node.allOf[0], path: `${path}/allOf/0`, preferred, property })
    }
    if (Array.isArray(node.type) === true) {
      if (
        node.type.length !== 2 ||
        node.type.includes('null') === false ||
        node.type.every((type) => type === 'null') === true
      )
        return reject(
          `${path}/type`,
          'non-nullable type union',
          'Use a discriminated object union or exactly [valueType,"null"]',
        )
      return {
        kind: 'nullable',
        inner: lower({
          input: { ...node, type: node.type.find((type) => type !== 'null') },
          path,
          preferred: preferred === undefined ? undefined : allocate(`${preferred}_Value`),
        }),
      }
    }
    const unionKey =
      node.anyOf !== undefined ? 'anyOf' : node.oneOf !== undefined ? 'oneOf' : undefined
    if (unionKey !== undefined) {
      allowed({ node, keys: [unionKey, 'x-effect-rust-non-exhaustive'], path })
      const branches = node[unionKey]
      if (Array.isArray(branches) === false || branches.length < 2)
        return reject(
          `${path}/${unionKey}`,
          'empty or singleton union',
          'Use a direct schema or at least two discriminated branches',
        )
      const nullIndex = branches.findIndex(
        (branch) =>
          typeof branch === 'object' &&
          branch !== null &&
          !Array.isArray(branch) &&
          (branch as Node).type === 'null',
      )
      if (branches.length === 2 && nullIndex !== -1) {
        if (node['x-effect-rust-non-exhaustive'] !== undefined)
          return reject(
            path,
            'non-exhaustive marker on nullable value',
            'Apply this marker only to a struct or discriminated enum',
          )
        lower({ input: branches[nullIndex], path: `${path}/${unionKey}/${nullIndex}` })
        return {
          kind: 'nullable',
          inner: lower({
            input: branches[1 - nullIndex],
            path: `${path}/${unionKey}/${1 - nullIndex}`,
            preferred: preferred === undefined ? undefined : allocate(`${preferred}_Value`),
          }),
        }
      }
      const variants = branches.map((branch, index) =>
        lower({ input: branch, path: `${path}/${unionKey}/${index}` }),
      )
      const structs = variants.map((variant, index) => {
        const definition = variant.kind === 'ref' ? defs[variant.name] : undefined
        if (variant.kind !== 'ref' || definition?.kind !== 'struct')
          return reject(
            `${path}/${unionKey}/${index}`,
            'union branch is not a discriminated struct',
            'Use an internally tagged serde enum with one required string literal discriminator per variant',
          )
        return { ref: variant.name, definition }
      })
      const literalTag = (type: Type): string | undefined => {
        const definition = type.kind === 'ref' ? defs[type.name] : undefined
        return definition?.kind === 'literals' && definition.values.length === 1
          ? definition.values[0]
          : undefined
      }
      const first = structs[0]!
      const candidate = first.definition.fields.find(
        (field) =>
          field.presence === 'required' &&
          literalTag(field.type) !== undefined &&
          structs.every((struct) =>
            struct.definition.fields.some(
              (other) =>
                other.wire === field.wire &&
                other.presence === 'required' &&
                literalTag(other.type) !== undefined,
            ),
          ),
      )
      if (candidate === undefined)
        return reject(
          path,
          'union has no required literal discriminator',
          'Use #[serde(tag = "kind")] with distinct string tags',
        )
      const tags = structs.map((struct, index) => {
        const discriminatorField = struct.definition.fields.find(
          (field) => field.wire === candidate.wire,
        )!
        const literals =
          discriminatorField.type.kind === 'ref' ? defs[discriminatorField.type.name] : undefined
        if (literals?.kind !== 'literals')
          return reject(path, 'invalid discriminator', 'Use a required string literal')
        if (
          discriminatorField.type.kind === 'ref' &&
          Object.hasOwn(inputDefs, discriminatorField.type.name) === false
        )
          discriminatorDefinitions.add(discriminatorField.type.name)
        const body: Definition = {
          ...struct.definition,
          fields: struct.definition.fields.filter((field) => field.wire !== candidate.wire),
        }
        const hint = object({ value: branches[index], path: `${path}/${unionKey}/${index}` }).title
        const existing = typeof hint === 'string' ? defs[hint] : undefined
        let ref = struct.ref
        if (
          typeof hint === 'string' &&
          Object.hasOwn(inputDefs, hint) === true &&
          existing?.kind === 'struct' &&
          existing.fields.some((field) => field.wire === candidate.wire) === false
        ) {
          if (JSON.stringify(body) !== JSON.stringify(existing))
            return reject(
              `${path}/${unionKey}/${index}`,
              'variant body disagrees with its named definition',
              'Keep the inline discriminator branch and its reusable named body identical',
            )
          ref = hint
          delete defs[struct.ref]
        } else if (Object.hasOwn(inputDefs, struct.ref) === true) {
          ref = allocate(`${struct.ref}_Body`)
          defs[ref] = body
        } else defs[ref] = body
        return { tag: literals.values[0]!, ref }
      })
      if (new Set(tags.map((tag) => tag.tag)).size !== tags.length)
        return reject(path, 'overlapping discriminator tags', 'Give every variant a unique tag')
      return named({
        definition: {
          kind: 'taggedUnion',
          tagField: candidate.wire,
          variants: tags,
          ...nonExhaustive({ node, path }),
        },
        path,
        preferred,
      })
    }
    if (node.enum !== undefined || node.const !== undefined) {
      allowed({ node, keys: ['type', 'enum', 'const'], path })
      const values = node.enum ?? [node.const]
      if (node.enum !== undefined && node.const !== undefined)
        return reject(
          path,
          'simultaneous enum and const constraints',
          'Export one literal constraint',
        )
      if (node.type !== undefined && node.type !== 'string')
        return reject(`${path}/type`, 'non-string literals', 'Use string enum variants')
      if (
        Array.isArray(values) === false ||
        values.length === 0 ||
        values.some((value) => typeof value !== 'string') === true
      )
        return reject(path, 'non-string or empty enum', 'Use a nonempty string enum')
      return named({
        definition: { kind: 'literals', values: [...new Set(values as string[])] },
        path,
        preferred,
      })
    }
    switch (node.type) {
      case 'null':
        allowed({ node, keys: ['type'], path })
        return { kind: 'null' }
      case 'boolean':
        allowed({ node, keys: ['type'], path })
        return { kind: 'bool' }
      case 'integer': {
        allowed({
          node,
          keys: ['type', 'format', 'minimum', 'maximum', 'x-effect-rust-width'],
          path,
        })
        const width =
          node['x-effect-rust-width'] ??
          (typeof node.format === 'string' ? formats[node.format] : undefined)
        if (
          node.format !== undefined &&
          (typeof node.format !== 'string' || formats[node.format] === undefined)
        )
          return reject(
            `${path}/format`,
            'lossy or unsupported integer format',
            'Use uint8, uint16, uint32 or int32; 64-bit integers require canonical string Wire codecs',
          )
        const inferred =
          width ??
          Object.keys(ranges).find((key) => {
            const range = ranges[key as Width]
            return node.minimum === range[0] && node.maximum === range[1]
          })
        if (typeof inferred !== 'string' || Object.hasOwn(ranges, inferred) === false)
          return reject(
            path,
            'unbounded or noncanonical integer bounds',
            'Declare a supported x-effect-rust-width or exact uint8/uint16/uint32/int32 bounds; use Wire.U64/I64 for wider values',
          )
        const result = inferred as Width
        const [minimum, maximum] = ranges[result]
        if (
          (node.minimum !== undefined && node.minimum !== minimum) ||
          (node.maximum !== undefined && node.maximum !== maximum) ||
          (node.format !== undefined && formats[String(node.format)] !== result)
        )
          return reject(
            path,
            'integer bounds or format disagree with wire width',
            'Use the exact canonical width range; narrower refinements need an explicit IR lowering',
          )
        return { kind: 'int', width: result }
      }
      case 'string': {
        allowed({
          node,
          keys: [
            'type',
            'format',
            'pattern',
            'minLength',
            'maxLength',
            'x-effect-rust-width',
            'x-effect-rust-format',
            'x-effect-rust-pattern',
            'x-effect-rust-pattern-flags',
          ],
          path,
        })
        const semanticFormat = node['x-effect-rust-format']
        if (semanticFormat !== undefined || node['x-effect-rust-width'] !== undefined) {
          const codec = semanticFormat ?? `${String(node['x-effect-rust-width'])}-decimal`
          if (['u64-decimal', 'i64-decimal', 'date-time-millis'].includes(String(codec)) === false)
            return reject(
              `${path}/x-effect-rust-format`,
              'unknown semantic codec',
              'Use u64-decimal, i64-decimal or date-time-millis',
            )
          const kind =
            codec === 'date-time-millis' ? 'dateTime' : codec === 'u64-decimal' ? 'u64' : 'i64'
          const canonicalPattern = kind === 'u64' ? '^(0|[1-9][0-9]*)$' : '^(0|-?[1-9][0-9]*)$'
          if (
            (node.format !== undefined && !(kind === 'dateTime' && node.format === 'date-time')) ||
            (node['x-effect-rust-width'] !== undefined && node['x-effect-rust-width'] !== kind) ||
            node.minLength !== undefined ||
            node.maxLength !== undefined ||
            node['x-effect-rust-pattern'] !== undefined ||
            node['x-effect-rust-pattern-flags'] !== undefined ||
            (node.pattern !== undefined &&
              (kind === 'dateTime' || node.pattern !== canonicalPattern))
          )
            return reject(
              path,
              'semantic codec with conflicting refinements',
              'Use the canonical Wire codec alone, without additional lossy constraints',
            )
          return { kind }
        }
        if (node.format !== undefined)
          return reject(
            `${path}/format`,
            'unregistered string format',
            'Declare x-effect-rust-format for a supported semantic Wire codec',
          )
        const pattern = node['x-effect-rust-pattern'] ?? node.pattern
        if (
          node.pattern !== undefined &&
          node['x-effect-rust-pattern'] !== undefined &&
          node.pattern !== node['x-effect-rust-pattern']
        )
          return reject(
            `${path}/pattern`,
            'conflicting patterns',
            'Use one identical portable pattern',
          )
        const flags = node['x-effect-rust-pattern-flags'] ?? 'u'
        if (flags !== 'u' && flags !== 'iu')
          return reject(
            `${path}/x-effect-rust-pattern-flags`,
            'nonportable regex flags',
            'Use u or iu',
          )
        if (pattern === undefined && node['x-effect-rust-pattern-flags'] !== undefined)
          return reject(
            path,
            'regex flags without a pattern',
            'Supply a portable pattern or remove flags',
          )
        if (pattern !== undefined) {
          if (typeof pattern !== 'string')
            return reject(`${path}/pattern`, 'malformed pattern', 'Use a string pattern')
          try {
            assertPortablePattern(pattern, flags)
          } catch (cause) {
            return reject(
              `${path}/pattern`,
              String(cause),
              'Use the portable effect-rust regex grammar',
            )
          }
        }
        for (const key of ['minLength', 'maxLength'])
          if (
            node[key] !== undefined &&
            (typeof node[key] !== 'number' ||
              Number.isSafeInteger(node[key]) === false ||
              Number(node[key]) < 0)
          )
            return reject(
              `${path}/${key}`,
              'invalid Unicode code-point bound',
              'Use a nonnegative safe integer',
            )
        if (
          node.minLength !== undefined &&
          node.maxLength !== undefined &&
          Number(node.minLength) > Number(node.maxLength)
        )
          return reject(path, 'inverted string bounds', 'Set minLength <= maxLength')
        if (
          pattern === undefined &&
          node.minLength === undefined &&
          node.maxLength === undefined &&
          preferred === undefined
        )
          return { kind: 'string' }
        if (preferred === undefined && typeof node.title !== 'string')
          return reject(
            path,
            'constrained string has no identifier',
            'Name the constrained string in $defs or give it a title',
          )
        return named({
          definition: {
            kind: 'string',
            ...(pattern === undefined ? {} : { pattern: String(pattern), flags }),
            ...(node.minLength === undefined ? {} : { minLength: Number(node.minLength) }),
            ...(node.maxLength === undefined ? {} : { maxLength: Number(node.maxLength) }),
          },
          path,
          preferred,
        })
      }
      case 'array':
        allowed({ node, keys: ['type', 'items'], path })
        return { kind: 'array', item: lower({ input: node.items, path: `${path}/items` }) }
      case 'object': {
        allowed({
          node,
          keys: [
            'type',
            'properties',
            'required',
            'additionalProperties',
            'propertyNames',
            'x-effect-rust-excess',
            'x-effect-rust-non-exhaustive',
          ],
          path,
        })
        if (
          node.properties === undefined &&
          typeof node.additionalProperties === 'object' &&
          node.additionalProperties !== null
        ) {
          if (
            node.required !== undefined ||
            node['x-effect-rust-excess'] !== undefined ||
            node['x-effect-rust-non-exhaustive'] !== undefined
          )
            return reject(
              path,
              'record with struct-only constraints',
              'Use only propertyNames and typed additionalProperties for records',
            )
          const key = lower({
            input: node.propertyNames ?? { type: 'string' },
            path: `${path}/propertyNames`,
          })
          if (
            key.kind !== 'string' &&
            !(
              key.kind === 'ref' &&
              ['string', 'literals'].includes(defs[key.name]?.kind ?? '') === true
            )
          )
            return reject(
              `${path}/propertyNames`,
              'non-string record key',
              'Use a string or named constrained string',
            )
          return {
            kind: 'record',
            key,
            value: lower({
              input: node.additionalProperties,
              path: `${path}/additionalProperties`,
            }),
          }
        }
        if (node.additionalProperties !== false)
          return reject(
            `${path}/additionalProperties`,
            'open or mixed object',
            'Use #[serde(deny_unknown_fields)] for structs, or typed additionalProperties for records',
          )
        if (node.propertyNames !== undefined)
          return reject(
            `${path}/propertyNames`,
            'struct property-name constraint',
            'Express constraints in the declared field names',
          )
        const properties = object({ value: node.properties ?? {}, path: `${path}/properties` })
        const required = node.required ?? []
        if (
          Array.isArray(required) === false ||
          required.some((key) => typeof key !== 'string' || !Object.hasOwn(properties, key)) ===
            true ||
          new Set(required).size !== required.length
        )
          return reject(
            `${path}/required`,
            'invalid required field set',
            'List each declared required property exactly once',
          )
        const excess = node['x-effect-rust-excess'] ?? 'error'
        if (excess !== 'error' && excess !== 'ignore')
          return reject(
            `${path}/x-effect-rust-excess`,
            'unknown excess policy',
            'Use error or ignore',
          )
        const fields = Object.entries(properties).map(([wire, value]) => {
          const fieldType = lower({
            input: value,
            path: `${path}/properties/${token(wire)}`,
            preferred: undefined,
            property: true,
          })
          if (fieldType.kind === 'patch' && required.includes(wire) === true)
            return reject(
              `${path}/required`,
              'Patch property cannot be required',
              'Remove the Patch property from required; Absent is a valid state',
            )
          return {
            wire,
            type: fieldType,
            presence:
              fieldType.kind === 'patch' || required.includes(wire) === true
                ? ('required' as const)
                : ('optional' as const),
          }
        })
        return named({
          definition: { kind: 'struct', fields, excess, ...nonExhaustive({ node, path }) },
          path,
          preferred,
        })
      }
      default:
        return reject(
          `${path}/type`,
          'unsupported or missing JSON type',
          'Use an explicit portable type, local reference, nullable or discriminated union',
        )
    }
  }
  const pending = new Set<string>()
  const lowerDefinition = (key: string): void => {
    if (Object.hasOwn(defs, key) === true || pending.has(key) === true) return
    pending.add(key)
    // Make referenced definitions available for discriminant and record-key inspection.
    const scan = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return
      if (Array.isArray(value) === true) {
        value.forEach(scan)
        return
      }
      const node = value as Node
      if (typeof node.title === 'string' && Object.hasOwn(inputDefs, node.title) === true)
        lowerDefinition(node.title)
      if (typeof node.$ref === 'string') {
        const match = /^#\/(?:\$defs|definitions)\/([^/]+)$/u.exec(node.$ref)
        if (match !== null) {
          let target: string
          try {
            target = decodeURIComponent(match[1]!).replaceAll('~1', '/').replaceAll('~0', '~')
          } catch {
            return
          }
          if (Object.hasOwn(inputDefs, target) === true) lowerDefinition(target)
        }
      }
      Object.values(node).forEach(scan)
    }
    scan(inputDefs[key])
    const value = lower({ input: inputDefs[key], path: `$/$defs/${token(key)}`, preferred: key })
    if (value.kind !== 'ref' || value.name !== key || Object.hasOwn(defs, key) === false)
      defs[key] = { kind: 'alias', type: value }
    pending.delete(key)
  }
  Object.keys(inputDefs).forEach(lowerDefinition)
  const rootNode = Object.fromEntries(
    Object.entries(doc).filter(([key]) => !Object.hasOwn(documentKeys, key)),
  )
  if (
    Object.hasOwn(inputDefs, rootName) === true &&
    rootNode.$ref !== `#/$defs/${rootName}` &&
    rootNode.$ref !== `#/definitions/${rootName}` &&
    rootNode.$ref !== '#'
  )
    return reject(
      '$/title',
      'root name collides with a definition',
      'Pass a distinct import name or reference that definition as the document root',
    )
  const root = lower({ input: rootNode, path: '$', preferred: rootName })
  if (root.kind !== 'ref' || root.name !== rootName) defs[rootName] = { kind: 'alias', type: root }
  if (Object.hasOwn(defs, rootName) === false)
    return reject(
      '$/$ref',
      'root reference has no concrete schema',
      'Define the root schema before referring to it recursively',
    )
  for (const name of discriminatorDefinitions) {
    const used = Object.values(defs).some((definition) => {
      switch (definition.kind) {
        case 'alias':
          return referencesType({ type: definition.type, name })
        case 'struct':
          return definition.fields.some((field) => referencesType({ type: field.type, name }))
        case 'taggedUnion':
          return definition.variants.some((variant) => variant.ref === name)
        default:
          return false
      }
    })
    if (used === false) delete defs[name]
  }
  return finish({ irVersion: 1, contract: rootName, defs })
}

const nonExhaustive = ({
  node,
  path,
}: {
  node: Node
  path: string
}): { readonly nonExhaustive?: boolean } => {
  const value = node['x-effect-rust-non-exhaustive']
  if (value !== undefined && typeof value !== 'boolean')
    return reject(
      `${path}/x-effect-rust-non-exhaustive`,
      'invalid non-exhaustive marker',
      'Use a boolean',
    )
  return value === undefined ? {} : { nonExhaustive: Boolean(value) }
}

const finish = (ir: ContractIR): { readonly ir: ContractIR; readonly source: string } => {
  for (const name of Object.keys(ir.defs)) {
    const seen = new Set<string>()
    let current = name
    for (;;) {
      if (seen.has(current) === true)
        return reject(
          `$/$defs/${token(name)}`,
          'unproductive recursive alias',
          'Make recursion pass through an object or array with a concrete wire representation',
        )
      seen.add(current)
      const definition = ir.defs[current]
      if (definition?.kind !== 'alias') break
      let type = definition.type
      while (type.kind === 'nullable') type = type.inner
      if (type.kind !== 'ref') break
      current = type.name
    }
  }
  const dependencies = new Map<string, Set<string>>()
  for (const [name, definition] of Object.entries(ir.defs)) {
    const refs = new Set<string>()
    switch (definition.kind) {
      case 'alias':
        collect({ type: definition.type, refs })
        break
      case 'struct':
        definition.fields.forEach((field) => collect({ type: field.type, refs }))
        break
      case 'taggedUnion':
        definition.variants.forEach((variant) => refs.add(variant.ref))
        break
    }
    dependencies.set(name, refs)
  }
  // Upstream emits nonrecursive dependents before recursive groups. Delay every
  // reference into a semantic cycle, including reusable tag-free variant bodies.
  const cyclic = new Set<string>()
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const active = new Set<string>()
  let index = 0
  const visit = (name: string): void => {
    indices.set(name, index)
    low.set(name, index++)
    stack.push(name)
    active.add(name)
    for (const dependency of dependencies.get(name)!) {
      if (dependencies.has(dependency) === false)
        return reject(
          `$/$defs/${token(name)}`,
          `missing reference ${dependency}`,
          'Include the referenced definition',
        )
      if (indices.has(dependency) === false) {
        visit(dependency)
        low.set(name, Math.min(low.get(name)!, low.get(dependency)!))
      } else if (active.has(dependency) === true)
        low.set(name, Math.min(low.get(name)!, indices.get(dependency)!))
    }
    if (low.get(name) !== indices.get(name)) return
    const component: string[] = []
    let member: string
    do {
      member = stack.pop()!
      active.delete(member)
      component.push(member)
    } while (member !== name)
    if (component.length > 1 || dependencies.get(name)!.has(name) === true)
      component.forEach((componentMember) => cyclic.add(componentMember))
  }
  for (const name of dependencies.keys()) if (indices.has(name) === false) visit(name)
  const type = (value: Type): R.Representation => {
    switch (value.kind) {
      case 'string':
        return { _tag: 'String', checks: [] }
      case 'bool':
        return { _tag: 'Boolean', checks: [] }
      case 'null':
        return { _tag: 'Null', checks: [] }
      case 'u64':
        return semantic({ runtime: 'Wire.U64', Type: 'bigint' })
      case 'i64':
        return semantic({ runtime: 'Wire.I64', Type: 'bigint' })
      case 'dateTime':
        return semantic({
          runtime: 'Wire.TimestampMillis',
          Type: 'typeof Wire.TimestampMillis.Type',
        })
      case 'int':
        return semantic({ runtime: `Wire.${value.width.toUpperCase()}`, Type: 'number' })
      case 'nullable':
        return {
          _tag: 'Union',
          types: [{ _tag: 'Null', checks: [] }, type(value.inner)],
          checks: [],
        }
      case 'patch':
        return semantic({
          runtime: 'Wire.Patch($inner)',
          Type: '{ readonly _tag: "Absent" } | { readonly _tag: "Null" } | { readonly _tag: "Value"; readonly value: $inner }',
          parameters: [type(value.inner)],
        })
      case 'array':
        return { _tag: 'Arrays', elements: [], rest: [type(value.item)], checks: [] }
      case 'record':
        return {
          _tag: 'Objects',
          propertySignatures: [],
          indexSignatures: [{ parameter: type(value.key), type: type(value.value) }],
          checks: [],
        }
      case 'ref': {
        const reference: R.Reference = { _tag: 'Reference', $ref: value.name }
        return cyclic.has(value.name) === true
          ? { _tag: 'Suspend', thunk: reference, checks: [] }
          : reference
      }
    }
  }
  const definition = ({ name, value }: { name: string; value: Definition }): R.Representation => {
    switch (value.kind) {
      case 'alias':
        return type(value.type)
      case 'literals':
        return {
          _tag: 'Union',
          types: value.values.map((literal) => ({ _tag: 'Literal', literal, checks: [] })),
          checks: [],
        }
      case 'string':
        return {
          _tag: 'String',
          checks: [
            ...(value.pattern === undefined
              ? []
              : [
                  filter(
                    `Wire.pattern(${JSON.stringify(value.pattern)}, ${JSON.stringify(value.flags ?? 'u')})`,
                  ),
                ]),
            ...(value.minLength === undefined
              ? []
              : [filter(`Schema.isMinCodePoints(${value.minLength})`)]),
            ...(value.maxLength === undefined
              ? []
              : [filter(`Schema.isMaxCodePoints(${value.maxLength})`)]),
          ],
          annotations: { identifier: name },
        }
      case 'struct': {
        const ordinary: R.Objects = {
          _tag: 'Objects',
          propertySignatures: value.fields.map((field) => ({
            name: field.wire,
            type: type(field.type),
            isOptional: field.presence === 'optional',
            isMutable: false,
          })),
          indexSignatures: [],
          checks: [],
        }
        return semantic({
          runtime: `$inner.annotate(Wire.excess(${JSON.stringify(value.excess ?? 'error')}))${value.nonExhaustive === true ? '.annotate({ "x-effect-rust-non-exhaustive": true })' : ''}`,
          Type: '$inner',
          parameters: [ordinary],
        })
      }
      case 'taggedUnion':
        return {
          _tag: 'Union',
          types: value.variants.map((variant) => {
            const body = ir.defs[variant.ref]
            if (body?.kind !== 'struct')
              return reject(`$/$defs/${name}`, 'invalid variant body', 'Use a struct variant')
            const ordinary: R.Objects = {
              _tag: 'Objects',
              checks: [],
              indexSignatures: [],
              propertySignatures: [
                {
                  name: value.tagField,
                  type: { _tag: 'Literal', literal: variant.tag, checks: [] },
                  isOptional: false,
                  isMutable: false,
                },
                ...body.fields.map((field) => ({
                  name: field.wire,
                  type: type(field.type),
                  isOptional: field.presence === 'optional',
                  isMutable: false,
                })),
              ],
            }
            return semantic({
              runtime: `$inner.annotate(Wire.excess(${JSON.stringify(body.excess ?? 'error')}))`,
              Type: '$inner',
              parameters: [ordinary],
            })
          }),
          checks: [],
          ...(value.nonExhaustive === true
            ? { annotations: { 'x-effect-rust-non-exhaustive': true } }
            : {}),
        }
    }
  }
  const references = Object.fromEntries(
    Object.entries(ir.defs).map(([name, value]) => [name, definition({ name, value })]),
  )
  const emitted = R.toCodeDocument({
    representations: [{ _tag: 'Reference', $ref: ir.contract }],
    references,
  })
  // Wire codecs have distinct encoded views, including inside explicit suspension callbacks.
  const declarations = emitted.references.nonRecursives.map(
    ({ $ref, code }) =>
      `export type ${$ref} = ${code.Type}\nexport const ${$ref} = ${recursiveRuntime(code.runtime)}`,
  )
  declarations.push(
    ...Object.entries(emitted.references.recursives).map(
      ([name, code]) =>
        `export type ${name} = ${code.Type}\nexport const ${name}: Schema.Codec<${name}, unknown> = ${recursiveRuntime(code.runtime)}`,
    ),
  )
  const root = emitted.codes[0]!.runtime
  return {
    ir,
    source: `import { Schema } from 'effect'\nimport { Wire } from '@overeng/effect-rust'\n\n${declarations.join('\n\n')}\n\nexport const decode = Wire.decode(${root})\nexport const encode = Wire.encode(${root})\n`,
  }
}
