import { DateTime, type Schema } from 'effect'

import type { ContractIR, Definition, Type, Width } from '../compiler/ir.ts'
import { lower } from '../compiler/lower.ts'
import { valueCodec } from './contract-json.ts'
import { scalarString } from './json.ts'
import { decode as decodeSchema, encode as encodeSchema } from './validation.ts'

/** Malformed Borsh frame failure with its byte offset. */
export class FrameError extends Error {
  readonly _tag = 'FrameError'
  // eslint-disable-next-line overeng/named-args -- Preserve the public FrameError positional error constructor.
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(`Borsh frame at ${offset}: ${message}`)
  }
}
/** Contract identifier and version written into each Borsh frame header. */
export interface FrameOptions {
  readonly contractId: number
  readonly version: number
}
/** Bidirectional value codec over binary payload bytes. */
export interface Codec<T> {
  readonly encode: (value: T) => Uint8Array
  readonly decode: (bytes: Uint8Array) => T
}
/** Checked frame codec paired with its trusted schema-admitted counterpart. */
export interface FrameCodec<T> extends Codec<T> {
  readonly trusted: Codec<T>
}
const widths: Record<Width, number> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
}
// Rust String::Ord and Borsh order valid UTF-8 strings by Unicode scalar, not UTF-16 code unit.
const compareKeys = ({ left, right }: { left: string; right: string }): number => {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.length - b.length
}

/** Borsh has no self-description: layout is derived from the same admitted live AST as Rust. */
// eslint-disable-next-line overeng/named-args -- Preserve the public makeIRCodec positional SDK signature.
export const makeIRCodec = (
  ir: ContractIR,
  root: string,
  options: FrameOptions,
  typed = false,
): Codec<unknown> => {
  if (
    Number.isInteger(options.contractId) === false ||
    options.contractId < 0 ||
    options.contractId > 0xffffffff ||
    Number.isInteger(options.version) === false ||
    options.version < 0 ||
    options.version > 0xffff
  )
    throw new FrameError(0, 'Header requires u32 contractId and u16 version')
  const rootType: Type = { kind: 'ref', name: root }
  const isPatch = (node: Type): boolean => {
    const seen = new Set<string>()
    while (node.kind === 'ref') {
      if (seen.has(node.name) === true) throw new FrameError(0, 'Cyclic type alias')
      seen.add(node.name)
      const target = ir.defs[node.name]
      if (target?.kind !== 'alias') return false
      node = target.type
    }
    return node.kind === 'patch'
  }
  const compareMapKeys = ({
    node,
    left,
    right,
  }: {
    node: Type
    left: string
    right: string
  }): number => {
    const seen = new Set<string>()
    while (node.kind === 'ref') {
      if (seen.has(node.name) === true) throw new FrameError(0, 'Cyclic map-key alias')
      seen.add(node.name)
      const target = ir.defs[node.name]
      if (target?.kind === 'literals')
        return target.values.indexOf(left) - target.values.indexOf(right)
      if (target?.kind !== 'alias') break
      node = target.type
    }
    return compareKeys({ left, right })
  }
  const encode = (rowInput: unknown): Uint8Array => {
    const chunks: Uint8Array[] = []
    let size = 0
    const push = (bytes: Uint8Array) => {
      chunks.push(bytes)
      size += bytes.length
    }
    const integer = ({
      value,
      bytes,
      signed = false,
    }: {
      value: bigint
      bytes: number
      signed?: boolean
    }) => {
      const minimum = signed === true ? -(1n << BigInt(bytes * 8 - 1)) : 0n
      const maximum =
        signed === true ? (1n << BigInt(bytes * 8 - 1)) - 1n : (1n << BigInt(bytes * 8)) - 1n
      if (value < minimum || value > maximum)
        throw new FrameError(size, 'Integer exceeds Borsh width')
      const buffer = new Uint8Array(bytes)
      let remaining = BigInt.asUintN(bytes * 8, value)
      for (let index = 0; index < bytes; index++) {
        buffer[index] = Number(remaining & 255n)
        remaining >>= 8n
      }
      push(buffer)
    }
    const string = (value: string) => {
      if (scalarString(value) === false) throw new FrameError(size, 'Unpaired Unicode surrogate')
      const bytes = new TextEncoder().encode(value)
      integer({ value: BigInt(bytes.length), bytes: 4 })
      push(bytes)
    }
    const object = (value: unknown): Record<string, unknown> => {
      if (typeof value !== 'object' || value === null || Array.isArray(value) === true)
        throw new FrameError(size, 'Expected object')
      return value as Record<string, unknown>
    }
    const definition = ({
      node,
      value,
      depth,
    }: {
      node: Definition
      value: unknown
      depth: number
    }): void => {
      if (node.kind === 'alias') {
        write({ node: node.type, value, depth })
        return
      }
      if (node.kind === 'string') {
        if (typeof value !== 'string') throw new FrameError(size, 'Expected string')
        string(value)
        return
      }
      if (node.kind === 'literals') {
        const index = node.values.indexOf(String(value))
        if (index < 0 || index > 255) throw new FrameError(size, 'Unknown enum literal')
        integer({ value: BigInt(index), bytes: 1 })
        return
      }
      const input = object(value)
      if (node.kind === 'struct') {
        for (const field of node.fields) {
          const child = input[field.wire]
          if (isPatch(field.type) === true) {
            write({ node: field.type, value: child, depth: depth + 1 })
            continue
          }
          if (field.presence === 'optional') {
            integer({ value: child === undefined ? 0n : 1n, bytes: 1 })
            if (child === undefined) continue
          }
          write({ node: field.type, value: child, depth: depth + 1 })
        }
        return
      }
      const index = node.variants.findIndex((variant) => variant.tag === input[node.tagField])
      if (index < 0 || index > 255) throw new FrameError(size, 'Unknown tagged variant')
      integer({ value: BigInt(index), bytes: 1 })
      definition({ node: ir.defs[node.variants[index]!.ref]!, value: input, depth: depth + 1 })
    }
    const write = ({ node, value, depth }: { node: Type; value: unknown; depth: number }): void => {
      if (depth > 128) throw new FrameError(size, 'Maximum Borsh nesting depth 128 exceeded')
      switch (node.kind) {
        case 'ref': {
          const target = ir.defs[node.name]
          if (target === undefined) throw new FrameError(size, `Unknown definition ${node.name}`)
          definition({ node: target, value, depth })
          break
        }
        case 'null':
          if (value !== null) throw new FrameError(size, 'Expected null')
          break
        case 'bool':
          if (typeof value !== 'boolean') throw new FrameError(size, 'Expected bool')
          integer({ value: value === true ? 1n : 0n, bytes: 1 })
          break
        case 'string':
          if (typeof value !== 'string') throw new FrameError(size, 'Expected string')
          string(value)
          break
        case 'int':
          if (typeof value !== 'number' || Number.isSafeInteger(value) === false)
            throw new FrameError(size, 'Expected safe integer')
          integer({
            value: BigInt(value),
            bytes: widths[node.width],
            signed: node.width.startsWith('i'),
          })
          break
        case 'u64':
        case 'i64':
          if (typeof value !== 'bigint' && typeof value !== 'string')
            throw new FrameError(size, 'Expected decimal or bigint')
          integer({ value: BigInt(value), bytes: 8, signed: node.kind === 'i64' })
          break
        case 'dateTime': {
          const millis =
            typeof value === 'string'
              ? Date.parse(value)
              : DateTime.isDateTime(value) === true
                ? DateTime.toEpochMillis(value)
                : NaN
          if (Number.isSafeInteger(millis) === false)
            throw new FrameError(size, 'Invalid timestamp')
          integer({ value: BigInt(millis), bytes: 8, signed: true })
          break
        }
        case 'nullable':
          integer({ value: value === null ? 0n : 1n, bytes: 1 })
          if (value !== null) write({ node: node.inner, value, depth: depth + 1 })
          break
        case 'patch': {
          const index = value === undefined ? 0 : value === null ? 1 : 2
          integer({ value: BigInt(index), bytes: 1 })
          if (index === 2) write({ node: node.inner, value, depth: depth + 1 })
          break
        }
        case 'array':
          if (Array.isArray(value) === false) throw new FrameError(size, 'Expected array')
          integer({ value: BigInt(value.length), bytes: 4 })
          value.forEach((item) => write({ node: node.item, value: item, depth: depth + 1 }))
          break
        case 'record': {
          const input = object(value)
          // eslint-disable-next-line unicorn/no-array-sort -- This array is freshly constructed here; sorting in place avoids an unnecessary copy.
          const entries = Object.entries(input).sort(([left], [right]) =>
            compareMapKeys({ node: node.key, left, right }),
          )
          integer({ value: BigInt(entries.length), bytes: 4 })
          for (const [key, item] of entries) {
            write({ node: node.key, value: key, depth: depth + 1 })
            write({ node: node.value, value: item, depth: depth + 1 })
          }
          break
        }
      }
    }
    integer({ value: BigInt(options.contractId), bytes: 4 })
    integer({ value: BigInt(options.version), bytes: 2 })
    write({ node: rootType, value: rowInput, depth: 0 })
    const output = new Uint8Array(size)
    let cursor = 0
    for (const chunk of chunks) {
      output.set(chunk, cursor)
      cursor += chunk.length
    }
    return output
  }
  const decode = (bytes: Uint8Array): unknown => {
    let cursor = 0
    const integer = ({ width, signed = false }: { width: number; signed?: boolean }): bigint => {
      if (cursor + width > bytes.length) throw new FrameError(cursor, 'Truncated payload')
      let value = 0n
      for (let index = 0; index < width; index++)
        value |= BigInt(bytes[cursor++]!) << BigInt(index * 8)
      return signed === true ? BigInt.asIntN(width * 8, value) : value
    }
    const length = (): number => {
      const value = Number(integer({ width: 4 }))
      // Reject allocation bombs before creating any collection, including zero-width arrays.
      if (value > 16777216) throw new FrameError(cursor, 'Collection exceeds 16M element limit')
      return value
    }
    const string = (): string => {
      const count = length()
      if (cursor + count > bytes.length) throw new FrameError(cursor, 'Truncated string')
      const slice = bytes.subarray(cursor, cursor + count)
      cursor += count
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(slice)
      } catch {
        throw new FrameError(cursor, 'Invalid UTF-8')
      }
    }
    const discriminant = (maximum: number): number => {
      const value = Number(integer({ width: 1 }))
      if (value > maximum) throw new FrameError(cursor - 1, 'Invalid discriminant')
      return value
    }
    const definition = ({ node, depth }: { node: Definition; depth: number }): unknown => {
      if (node.kind === 'alias') return read({ node: node.type, depth })
      if (node.kind === 'string') return string()
      if (node.kind === 'literals') return node.values[discriminant(node.values.length - 1)]
      if (node.kind === 'struct') {
        const object: Record<string, unknown> = {}
        for (const field of node.fields) {
          if (
            field.presence === 'optional' &&
            isPatch(field.type) === false &&
            discriminant(1) === 0
          )
            continue
          const value = read({ node: field.type, depth: depth + 1 })
          if (value !== undefined)
            Object.defineProperty(object, field.wire, { value, enumerable: true })
        }
        return object
      }
      const variant = node.variants[discriminant(node.variants.length - 1)]!
      return {
        [node.tagField]: variant.tag,
        ...(definition({ node: ir.defs[variant.ref]!, depth: depth + 1 }) as Record<
          string,
          unknown
        >),
      }
    }
    const read = ({ node, depth }: { node: Type; depth: number }): unknown => {
      if (depth > 128) throw new FrameError(cursor, 'Maximum Borsh nesting depth 128 exceeded')
      switch (node.kind) {
        case 'ref': {
          const target = ir.defs[node.name]
          if (target === undefined) throw new FrameError(cursor, `Unknown definition ${node.name}`)
          return definition({ node: target, depth })
        }
        case 'null':
          return null
        case 'bool':
          return discriminant(1) === 1
        case 'string':
          return string()
        case 'int': {
          const value = Number(
            integer({ width: widths[node.width], signed: node.width.startsWith('i') }),
          )
          if (Number.isSafeInteger(value) === false)
            throw new FrameError(cursor, 'Integer exceeds JS safe number range')
          return value
        }
        case 'u64':
        case 'i64': {
          const value = integer({ width: 8, signed: node.kind === 'i64' })
          return typed === true ? value : value.toString()
        }
        case 'dateTime': {
          const millis = Number(integer({ width: 8, signed: true }))
          if (Number.isSafeInteger(millis) === false)
            throw new FrameError(cursor, 'Timestamp exceeds JS safe millis')
          const date = new Date(millis)
          if (Number.isFinite(date.getTime()) === false)
            throw new FrameError(cursor, 'Timestamp out of range')
          return typed === true ? DateTime.makeUnsafe(millis) : date.toISOString()
        }
        case 'nullable':
          return discriminant(1) === 0 ? null : read({ node: node.inner, depth: depth + 1 })
        case 'patch': {
          const tag = discriminant(2)
          return tag === 0
            ? undefined
            : tag === 1
              ? null
              : read({ node: node.inner, depth: depth + 1 })
        }
        case 'array': {
          const count = length()
          return Array.from({ length: count }, () => read({ node: node.item, depth: depth + 1 }))
        }
        case 'record': {
          const count = length()
          const object: Record<string, unknown> = {}
          let previous: string | undefined
          for (let index = 0; index < count; index++) {
            const key = read({ node: node.key, depth: depth + 1 })
            if (
              typeof key !== 'string' ||
              (previous !== undefined &&
                compareMapKeys({ node: node.key, left: key, right: previous }) <= 0)
            )
              throw new FrameError(cursor, 'Borsh map keys must be unique and sorted')
            previous = key
            Object.defineProperty(object, key, {
              value: read({ node: node.value, depth: depth + 1 }),
              enumerable: true,
            })
          }
          return object
        }
      }
    }
    if (
      Number(integer({ width: 4 })) !== options.contractId ||
      Number(integer({ width: 2 })) !== options.version
    )
      throw new FrameError(0, 'Contract/version header mismatch')
    const value = read({ node: rootType, depth: 0 })
    if (cursor !== bytes.length) throw new FrameError(cursor, 'Trailing payload')
    return value
  }
  return { encode, decode }
}

/** Creates schema-validated Borsh frame codecs plus trusted encoding and decoding paths. */
// eslint-disable-next-line overeng/named-args -- Public frame codec takes a schema and header options.
export const frame = <TSchema extends Schema.ConstraintCodec<unknown>>(
  schema: TSchema,
  options: FrameOptions,
): FrameCodec<TSchema['Type']> => {
  const ir = lower({ Row: schema }, 'frame')
  const values = valueCodec(schema)
  const encoder = encodeSchema(values)
  const decoder = decodeSchema(values)
  const codec = makeIRCodec(ir, 'Row', options)
  const trusted = makeIRCodec(ir, 'Row', options, true)
  return {
    encode: (value) => codec.encode(encoder(value)),
    decode: (bytes) => decoder(codec.decode(bytes)),
    // Admission proves the layout corresponds to TSchema.Type; trusted intentionally bypasses refinements.
    trusted: {
      encode: trusted.encode,
      decode: (bytes) => trusted.decode(bytes) as TSchema['Type'],
    },
  }
}
