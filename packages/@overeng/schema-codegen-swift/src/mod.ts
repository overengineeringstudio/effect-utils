import type { Schema } from 'effect'

import {
  lower,
  reject,
  integerRanges,
  type ContractIR,
  type Field,
  type Type,
} from '@overeng/schema-codegen'

export interface SwiftGenerationOptions {
  readonly filename: string
  readonly moduleName?: string
  /** Repo-relative schema/generator inputs and the consumer's regeneration command. */
  readonly header: string
}
export interface GeneratedFile {
  readonly path: string
  readonly content: string
}
export interface SwiftGenerationInput {
  readonly schemas: Readonly<Record<string, Schema.Constraint>>
  readonly options: SwiftGenerationOptions
}

const id = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || ['self', 'Self', '_'].includes(name))
    return reject(
      `$/Swift/${name}`,
      'Unsupported Swift identifier',
      'Use an ASCII identifier other than self, Self or _',
    )
  return `\`${name}\``
}
/** Swift string literals are not JSON string literals (notably interpolation and Unicode escapes). */
const quote = (value: string): string =>
  '"' +
  [...value]
    .map((character) => {
      const code = character.codePointAt(0)!
      if (code >= 0xd800 && code <= 0xdfff)
        return unsupported('$/Swift/literal', 'unpaired Unicode surrogates')
      if (character === '"' || character === '\\') return `\\${character}`
      if (code < 32 || code > 126) return `\\u{${code.toString(16)}}`
      return character
    })
    .join('') +
  '"'
const doc = (description?: string): string =>
  description === undefined
    ? ''
    : description
        .split(/\r?\n/)
        .map((line) => `/// ${line}`)
        .join('\n') + '\n'
const unsupported = (path: string, feature: string): never =>
  reject(
    path,
    `Swift emitter does not support ${feature}`,
    'Use the documented Swift Codable subset or extend the emitter with validation-preserving support',
  )

/** Pure Effect-schema -> shared IR -> Swift files seam. No filesystem, clock or environment inputs. */
export const generateSwift = ({
  schemas,
  options,
}: SwiftGenerationInput): readonly [GeneratedFile] => {
  if (
    !options.filename.endsWith('.swift') ||
    options.filename.startsWith('/') ||
    options.filename.split('/').includes('..')
  )
    reject(
      '$/options/filename',
      'Invalid Swift output path',
      'Use a relative .swift path without parent traversal',
    )
  if (options.header.trim() === '')
    reject(
      '$/options/header',
      'Missing generation provenance',
      'Supply schema inputs and a regeneration command',
    )
  const ir = lower(schemas, options.moduleName ?? 'contracts', {
    descriptions: true,
    profile: 'swift',
  })
  return [{ path: options.filename, content: emit({ ir, header: options.header }) }]
}

const emit = ({ ir, header }: { readonly ir: ContractIR; readonly header: string }): string => {
  const integers = new Map<
    string,
    { readonly name: string; readonly type: Extract<Type, { kind: 'int' | 'f64' }> }
  >()
  const resolve = (type: Type, seen = new Set<string>()): Type => {
    if (type.kind !== 'ref') return type
    if (seen.has(type.name)) return unsupported(`$/${type.name}`, 'cyclic scalar aliases')
    seen.add(type.name)
    const definition = ir.defs[type.name]
    if (definition === undefined) return unsupported(`$/${type.name}`, 'unresolved references')
    return definition.kind === 'alias' ? resolve(definition.type, seen) : type
  }
  const typeName = (type: Type): string => {
    switch (type.kind) {
      case 'string':
        return 'String'
      case 'bool':
        return 'Bool'
      case 'null':
        return 'JSONNull'
      case 'ref':
        resolve(type)
        return id(type.name)
      case 'array':
        return `[${typeName(type.item)}]`
      case 'nullable':
        return `${typeName(type.inner)}?`
      case 'patch':
        return `Presence<${typeName(type.inner)}?>`
      case 'f64':
      case 'int': {
        const key = JSON.stringify(type)
        let integer = integers.get(key)
        if (integer === undefined) {
          integer = { name: `SchemaCodegenInteger${integers.size}`, type }
          if (ir.defs[integer.name] !== undefined)
            return unsupported(`$/${integer.name}`, 'reserved generated integer names')
          integers.set(key, integer)
        }
        return integer.name
      }
      default:
        return unsupported(`$/types/${type.kind}`, type.kind)
    }
  }
  const fieldType = (field: Field): string => {
    const value = resolve(field.type)
    if (value.kind === 'patch') return typeName(value)
    return typeName(field.type) + (field.presence === 'optional' ? '?' : '')
  }
  const decode = (field: Field): string => {
    const key = `.${id(field.wire)}`
    const value = resolve(field.type)
    if (value.kind === 'patch')
      return `container.contains(${key}) ? .present(try container.decode(${typeName(value.inner)}?.self, forKey: ${key})) : .absent`
    if (field.presence === 'optional')
      return `container.contains(${key}) ? try container.decode(${typeName(field.type)}.self, forKey: ${key}) : nil`
    return `try container.decode(${typeName(field.type)}.self, forKey: ${key})`
  }
  const encode = (field: Field, value: string): string => {
    const key = `.${id(field.wire)}`
    if (resolve(field.type).kind === 'patch')
      return `if case .present(let value) = ${value} { try container.encode(value, forKey: ${key}) }`
    return `try container.${field.presence === 'optional' ? 'encodeIfPresent' : 'encode'}(${value}, forKey: ${key})`
  }
  const keys = (names: readonly string[]): string =>
    names.length === 0
      ? 'private typealias CodingKeys = SchemaCodegenKey'
      : `private enum CodingKeys: String, CodingKey {\n${names.map((name) => `    case ${id(name)} = ${quote(name)}`).join('\n')}\n  }`
  const excess = (names: readonly string[]): string =>
    `let allKeys = try decoder.container(keyedBy: SchemaCodegenKey.self).allKeys\n    guard allKeys.allSatisfy({ key in ${names.length === 0 ? 'false' : names.map((name) => `key.stringValue == ${quote(name)}`).join(' || ')} }) else {\n      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unknown object key"))\n    }`
  // Direct recursive value structs have infinite size. Arrays and indirect enums break that cycle.
  const checkSize = (type: Type, seen: ReadonlySet<string>): void => {
    if (type.kind === 'nullable' || type.kind === 'patch') return checkSize(type.inner, seen)
    if (type.kind !== 'ref') return
    if (seen.has(type.name)) return unsupported(`$/${type.name}`, 'direct recursive value structs')
    const definition = ir.defs[type.name]
    const next = new Set([...seen, type.name])
    if (definition?.kind === 'struct')
      definition.fields.forEach((field) => checkSize(field.type, next))
    if (definition?.kind === 'alias') checkSize(definition.type, next)
  }
  const checkAliases = (type: Type, seen: ReadonlySet<string>): void => {
    if (type.kind === 'array') return checkAliases(type.item, seen)
    if (type.kind === 'nullable' || type.kind === 'patch') return checkAliases(type.inner, seen)
    if (type.kind !== 'ref') return
    if (seen.has(type.name)) return unsupported(`$/${type.name}`, 'recursive Swift type aliases')
    const definition = ir.defs[type.name]
    if (definition?.kind === 'alias') checkAliases(definition.type, new Set([...seen, type.name]))
  }
  const declarations = Object.entries(ir.defs).map(([name, definition]) => {
    id(name)
    if (
      [
        'String',
        'Bool',
        'Int',
        'Int8',
        'Int16',
        'Int32',
        'Int64',
        'UInt',
        'UInt8',
        'UInt16',
        'UInt32',
        'UInt64',
        'Double',
        'Float',
        'Optional',
        'JSONNull',
        'Presence',
        'SchemaCodegenKey',
        'CodingKeys',
        'CodingKey',
        'Codable',
        'Equatable',
        'Sendable',
        'Decoder',
        'Encoder',
        'DecodingError',
      ].includes(name)
    )
      unsupported(`$/${name}`, 'names reserved by the Swift standard library or emitter runtime')
    const prefix = doc(definition.description)
    switch (definition.kind) {
      case 'alias': {
        checkAliases(definition.type, new Set([name]))
        checkSize(definition.type, new Set([name]))
        return `${prefix}public typealias ${id(name)} = ${typeName(definition.type)}`
      }
      case 'string':
        return unsupported(`$/${name}`, 'constrained or branded string definitions')
      case 'literals': {
        const cases = definition.values.map((value, index) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !['self', 'Self', '_'].includes(value)
            ? value
            : `value${index}`,
        )
        if (new Set(cases).size !== cases.length)
          unsupported(`$/${name}`, 'normalized literal case collisions')
        return `${prefix}public enum ${id(name)}: String, Codable, Equatable, Sendable {\n${definition.values.map((value, index) => `  case ${id(cases[index]!)} = ${quote(value)}`).join('\n')}\n}`
      }
      case 'struct': {
        definition.fields.forEach((field) => checkSize(field.type, new Set([name])))
        const fields = definition.fields
        return `${prefix}public struct ${id(name)}: Codable, Equatable, Sendable {\n${fields.map((field) => `${doc(field.description)}  public var ${id(field.wire)}: ${fieldType(field)}`).join('\n')}\n  public init(${fields.map((field) => `${id(field.wire)}: ${fieldType(field)}`).join(', ')}) {\n${fields.map((field) => `    self.${id(field.wire)} = ${id(field.wire)}`).join('\n')}\n  }\n  ${keys(fields.map((field) => field.wire))}\n  public init(from decoder: Decoder) throws {\n    ${definition.excess === 'ignore' ? '' : excess(fields.map((field) => field.wire))}\n    let container = try decoder.container(keyedBy: CodingKeys.self)\n${fields.map((field) => `    self.${id(field.wire)} = ${decode(field)}`).join('\n')}\n  }\n  public func encode(to encoder: Encoder) throws {\n    var container = encoder.container(keyedBy: CodingKeys.self)\n${fields.map((field) => `    ${encode(field, `self.${id(field.wire)}`)}`).join('\n')}\n  }\n}`
      }
      case 'taggedUnion': {
        const variants = definition.variants.map((variant) => {
          const body = ir.defs[variant.ref]
          if (body?.kind !== 'struct')
            return unsupported(`$/${name}/${variant.tag}`, 'non-struct union payloads')
          return { ...variant, body }
        })
        const names = [
          ...new Set([
            definition.tagField,
            ...variants.flatMap(({ body }) => body.fields.map((field) => field.wire)),
          ]),
        ]
        return `${prefix}public indirect enum ${id(name)}: Codable, Equatable, Sendable {\n${variants.map((variant) => `  case ${id(variant.tag)}(${id(variant.ref)})`).join('\n')}\n  ${keys(names)}\n  public init(from decoder: Decoder) throws {\n    let container = try decoder.container(keyedBy: CodingKeys.self)\n    switch try container.decode(String.self, forKey: .${id(definition.tagField)}) {\n${variants.map(({ tag, ref, body }) => `    case ${quote(tag)}:\n      ${body.excess === 'ignore' ? '' : excess([definition.tagField, ...body.fields.map((field) => field.wire)])}\n      self = .${id(tag)}(${id(ref)}(${body.fields.map((field) => `${id(field.wire)}: ${decode(field)}`).join(', ')}))`).join('\n')}\n    default: throw DecodingError.dataCorruptedError(forKey: .${id(definition.tagField)}, in: container, debugDescription: "Unknown union tag")\n    }\n  }\n  public func encode(to encoder: Encoder) throws {\n    var container = encoder.container(keyedBy: CodingKeys.self)\n    switch self {\n${variants.map(({ tag, body }) => `    case .${id(tag)}(let payload):\n      try container.encode(${quote(tag)}, forKey: .${id(definition.tagField)})\n${body.fields.map((field) => `      ${encode(field, `payload.${id(field.wire)}`)}`).join('\n')}`).join('\n')}\n    }\n  }\n}`
      }
    }
  })
  const integerDeclarations = [...integers.values()].map(({ name, type }) => {
    const storage =
      type.kind === 'f64'
        ? 'Double'
        : {
            u8: 'UInt8',
            u16: 'UInt16',
            u32: 'UInt32',
            i8: 'Int8',
            i16: 'Int16',
            i32: 'Int32',
            u64: 'UInt64',
            i64: 'Int64',
          }[type.width]
    const check =
      type.kind === 'f64'
        ? [
            'value.isFinite',
            ...(type.minimum === undefined ? [] : [`value >= ${type.minimum}`]),
            ...(type.maximum === undefined ? [] : [`value <= ${type.maximum}`]),
          ].join(' && ')
        : `value >= ${type.minimum ?? integerRanges[type.width][0]} && value <= ${type.maximum ?? integerRanges[type.width][1]}`
    return `public struct ${name}: Codable, Equatable, Sendable {\n  public let value: ${storage}\n  public init(_ value: ${storage}) throws {\n    guard ${check} else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Integer outside contract bounds")) }\n    self.value = value\n  }\n  public init(from decoder: Decoder) throws {\n    let container = try decoder.singleValueContainer()\n    let value = try container.decode(${storage}.self)\n    guard ${check} else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "Integer outside contract bounds") }\n    self.value = value\n  }\n  public func encode(to encoder: Encoder) throws {\n    var container = encoder.singleValueContainer()\n    try container.encode(value)\n  }\n}`
  })
  return `// Generated by @overeng/schema-codegen-swift. DO NOT EDIT.\n${header
    .split(/\r?\n/)
    .map((line) => `// ${line}`)
    .join(
      '\n',
    )}\nimport Foundation\nimport CodableHelpers\n\nprivate struct SchemaCodegenKey: CodingKey {\n  let stringValue: String\n  var intValue: Int? { nil }\n  init?(stringValue: String) { self.stringValue = stringValue }\n  init?(intValue: Int) { return nil }\n}\n\n${[...integerDeclarations, ...declarations].join('\n\n')}\n`
}
