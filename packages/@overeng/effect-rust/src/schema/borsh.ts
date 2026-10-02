import { DateTime, Schema } from 'effect'
import { lower } from '../compiler/lower.ts'
import type { ContractIR, Definition, Type, Width } from '../compiler/ir.ts'
import { decode as decodeSchema, encode as encodeSchema } from './validation.ts'

export class FrameError extends Error {
  readonly _tag = 'FrameError'
  constructor(readonly offset: number, message: string) { super(`Borsh frame at ${offset}: ${message}`) }
}
export interface FrameOptions { readonly contractId: number; readonly version: number }
export interface Codec<T> { readonly encode: (value: T) => Uint8Array; readonly decode: (bytes: Uint8Array) => T }
export interface FrameCodec<T> extends Codec<T> { readonly trusted: Codec<T> }
const widths: Record<Width, number> = { u8: 1, u16: 2, u32: 4, i32: 4 }
// Rust String::Ord and Borsh order valid UTF-8 strings by Unicode scalar, not UTF-16 code unit.
const compareKeys = (left: string, right: string): number => {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.length - b.length
}

/** Borsh has no self-description: layout is derived from the same admitted live AST as Rust. */
export const makeIRCodec = (ir: ContractIR, root: string, options: FrameOptions, typed = false): Codec<unknown> => {
  if (!Number.isInteger(options.contractId) || options.contractId < 0 || options.contractId > 0xffffffff || !Number.isInteger(options.version) || options.version < 0 || options.version > 0xffff) throw new FrameError(0, 'Header requires u32 contractId and u16 version')
  const rootType: Type = { kind: 'ref', name: root }
  const isPatch = (node: Type): boolean => {
    const seen = new Set<string>()
    while (node.kind === 'ref') {
      if (seen.has(node.name)) throw new FrameError(0, 'Cyclic type alias')
      seen.add(node.name)
      const target = ir.defs[node.name]
      if (target?.kind !== 'alias') return false
      node = target.type
    }
    return node.kind === 'patch'
  }
  const compareMapKeys = (node: Type, left: string, right: string): number => {
    const seen = new Set<string>()
    while (node.kind === 'ref') {
      if (seen.has(node.name)) throw new FrameError(0, 'Cyclic map-key alias')
      seen.add(node.name)
      const target = ir.defs[node.name]
      if (target?.kind === 'literals') return target.values.indexOf(left) - target.values.indexOf(right)
      if (target?.kind !== 'alias') break
      node = target.type
    }
    return compareKeys(left, right)
  }
  const encode = (input: unknown): Uint8Array => {
    const chunks: Uint8Array[] = []
    let size = 0
    const push = (bytes: Uint8Array) => { chunks.push(bytes); size += bytes.length }
    const integer = (value: bigint, bytes: number, signed = false) => {
      const minimum = signed ? -(1n << BigInt(bytes * 8 - 1)) : 0n
      const maximum = signed ? (1n << BigInt(bytes * 8 - 1)) - 1n : (1n << BigInt(bytes * 8)) - 1n
      if (value < minimum || value > maximum) throw new FrameError(size, 'Integer exceeds Borsh width')
      const buffer = new Uint8Array(bytes)
      let remaining = BigInt.asUintN(bytes * 8, value)
      for (let index = 0; index < bytes; index++) { buffer[index] = Number(remaining & 255n); remaining >>= 8n }
      push(buffer)
    }
    const string = (value: string) => { const bytes = new TextEncoder().encode(value); integer(BigInt(bytes.length), 4); push(bytes) }
    const object = (value: unknown): Record<string, unknown> => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new FrameError(size, 'Expected object')
      return value as Record<string, unknown>
    }
    const definition = (node: Definition, value: unknown, depth: number): void => {
      if (node.kind === 'alias') { write(node.type, value, depth); return }
      if (node.kind === 'string') { if (typeof value !== 'string') throw new FrameError(size, 'Expected string'); string(value); return }
      if (node.kind === 'literals') { const index = node.values.indexOf(String(value)); if (index < 0 || index > 255) throw new FrameError(size, 'Unknown enum literal'); integer(BigInt(index), 1); return }
      const input = object(value)
      if (node.kind === 'struct') {
        for (const field of node.fields) {
          const child = input[field.wire]
          if (isPatch(field.type)) { write(field.type, child, depth + 1); continue }
          if (field.presence === 'optional') { integer(child === undefined ? 0n : 1n, 1); if (child === undefined) continue }
          write(field.type, child, depth + 1)
        }
        return
      }
      const index = node.variants.findIndex((variant) => variant.tag === input[node.tagField])
      if (index < 0 || index > 255) throw new FrameError(size, 'Unknown tagged variant')
      integer(BigInt(index), 1); definition(ir.defs[node.variants[index]!.ref]!, input, depth + 1)
    }
    const write = (node: Type, value: unknown, depth: number): void => {
      if (depth > 128) throw new FrameError(size, 'Maximum Borsh nesting depth 128 exceeded')
      switch (node.kind) {
        case 'ref': { const target = ir.defs[node.name]; if (!target) throw new FrameError(size, `Unknown definition ${node.name}`); definition(target, value, depth); break }
        case 'null': if (value !== null) throw new FrameError(size, 'Expected null'); break
        case 'bool': if (typeof value !== 'boolean') throw new FrameError(size, 'Expected bool'); integer(value ? 1n : 0n, 1); break
        case 'string': if (typeof value !== 'string') throw new FrameError(size, 'Expected string'); string(value); break
        case 'int': if (typeof value !== 'number' || !Number.isInteger(value)) throw new FrameError(size, 'Expected integer'); integer(BigInt(value), widths[node.width], node.width === 'i32'); break
        case 'u64': case 'i64': if (typeof value !== 'bigint' && typeof value !== 'string') throw new FrameError(size, 'Expected decimal or bigint'); integer(BigInt(value), 8, node.kind === 'i64'); break
        case 'dateTime': { const millis = typeof value === 'string' ? Date.parse(value) : DateTime.isDateTime(value) ? DateTime.toEpochMillis(value) : NaN; if (!Number.isSafeInteger(millis)) throw new FrameError(size, 'Invalid timestamp'); integer(BigInt(millis), 8, true); break }
        case 'nullable': integer(value === null ? 0n : 1n, 1); if (value !== null) write(node.inner, value, depth + 1); break
        case 'patch': {
          let tag: string; let child = value
          if (typed) { const patch = object(value); tag = String(patch._tag); child = patch.value } else tag = value === undefined ? 'Absent' : value === null ? 'Null' : 'Value'
          const index = ['Absent', 'Null', 'Value'].indexOf(tag)
          if (index < 0) throw new FrameError(size, 'Invalid Patch')
          integer(BigInt(index), 1); if (index === 2) write(node.inner, child, depth + 1); break
        }
        case 'array': if (!Array.isArray(value)) throw new FrameError(size, 'Expected array'); integer(BigInt(value.length), 4); value.forEach((item) => write(node.item, item, depth + 1)); break
        case 'record': { const input = object(value); const entries = Object.entries(input).sort(([left], [right]) => compareMapKeys(node.key, left, right)); integer(BigInt(entries.length), 4); for (const [key, item] of entries) { write(node.key, key, depth + 1); write(node.value, item, depth + 1) }; break }
      }
    }
    integer(BigInt(options.contractId), 4); integer(BigInt(options.version), 2); write(rootType, input, 0)
    const output = new Uint8Array(size)
    let cursor = 0
    for (const chunk of chunks) { output.set(chunk, cursor); cursor += chunk.length }
    return output
  }
  const decode = (bytes: Uint8Array): unknown => {
    let cursor = 0
    const integer = (width: number, signed = false): bigint => {
      if (cursor + width > bytes.length) throw new FrameError(cursor, 'Truncated payload')
      let value = 0n
      for (let index = 0; index < width; index++) value |= BigInt(bytes[cursor++]!) << BigInt(index * 8)
      return signed ? BigInt.asIntN(width * 8, value) : value
    }
    const length = (): number => {
      const value = Number(integer(4))
      // Reject allocation bombs before creating any collection, including zero-width arrays.
      if (value > 16777216) throw new FrameError(cursor, 'Collection exceeds 16M element limit')
      return value
    }
    const string = (): string => { const count = length(); if (cursor + count > bytes.length) throw new FrameError(cursor, 'Truncated string'); const slice = bytes.subarray(cursor, cursor + count); cursor += count; try { return new TextDecoder('utf-8', { fatal: true }).decode(slice) } catch { throw new FrameError(cursor, 'Invalid UTF-8') } }
    const discriminant = (maximum: number): number => { const value = Number(integer(1)); if (value > maximum) throw new FrameError(cursor - 1, 'Invalid discriminant'); return value }
    const definition = (node: Definition, depth: number): unknown => {
      if (node.kind === 'alias') return read(node.type, depth)
      if (node.kind === 'string') return string()
      if (node.kind === 'literals') return node.values[discriminant(node.values.length - 1)]
      if (node.kind === 'struct') {
        const object: Record<string, unknown> = {}
        for (const field of node.fields) {
          if (field.presence === 'optional' && !isPatch(field.type) && discriminant(1) === 0) continue
          const value = read(field.type, depth + 1)
          if (value !== undefined) Object.defineProperty(object, field.wire, { value, enumerable: true })
        }
        return object
      }
      const variant = node.variants[discriminant(node.variants.length - 1)]!
      return { [node.tagField]: variant.tag, ...(definition(ir.defs[variant.ref]!, depth + 1) as Record<string, unknown>) }
    }
    const read = (node: Type, depth: number): unknown => {
      if (depth > 128) throw new FrameError(cursor, 'Maximum Borsh nesting depth 128 exceeded')
      switch (node.kind) {
        case 'ref': { const target = ir.defs[node.name]; if (!target) throw new FrameError(cursor, `Unknown definition ${node.name}`); return definition(target, depth) }
        case 'null': return null
        case 'bool': return discriminant(1) === 1
        case 'string': return string()
        case 'int': return Number(integer(widths[node.width], node.width === 'i32'))
        case 'u64': case 'i64': { const value = integer(8, node.kind === 'i64'); return typed ? value : value.toString() }
        case 'dateTime': { const millis = Number(integer(8, true)); if (!Number.isSafeInteger(millis)) throw new FrameError(cursor, 'Timestamp exceeds JS safe millis'); const date = new Date(millis); if (!Number.isFinite(date.getTime())) throw new FrameError(cursor, 'Timestamp out of range'); return typed ? DateTime.makeUnsafe(millis) : date.toISOString() }
        case 'nullable': return discriminant(1) === 0 ? null : read(node.inner, depth + 1)
        case 'patch': { const tag = discriminant(2); return typed ? tag === 0 ? { _tag: 'Absent' } : tag === 1 ? { _tag: 'Null' } : { _tag: 'Value', value: read(node.inner, depth + 1) } : tag === 0 ? undefined : tag === 1 ? null : read(node.inner, depth + 1) }
        case 'array': { const count = length(); return Array.from({ length: count }, () => read(node.item, depth + 1)) }
        case 'record': { const count = length(); const object: Record<string, unknown> = {}; let previous: string | undefined; for (let index = 0; index < count; index++) { const key = read(node.key, depth + 1); if (typeof key !== 'string' || (previous !== undefined && compareMapKeys(node.key, key, previous) <= 0)) throw new FrameError(cursor, 'Borsh map keys must be unique and sorted'); previous = key; Object.defineProperty(object, key, { value: read(node.value, depth + 1), enumerable: true }) }; return object }
      }
    }
    if (Number(integer(4)) !== options.contractId || Number(integer(2)) !== options.version) throw new FrameError(0, 'Contract/version header mismatch')
    const value = read(rootType, 0)
    if (cursor !== bytes.length) throw new FrameError(cursor, 'Trailing payload')
    return value
  }
  return { encode, decode }
}

export const makeFrame = <TSchema extends Schema.ConstraintCodec<unknown>>(schema: TSchema, options: FrameOptions): FrameCodec<TSchema['Type']> => {
  const ir = lower({ Row: schema }, 'frame')
  const codec = makeIRCodec(ir, 'Row', options)
  const trusted = makeIRCodec(ir, 'Row', options, true)
  return {
    encode: (value) => codec.encode(encodeSchema(schema)(value)),
    decode: (bytes) => decodeSchema(schema)(codec.decode(bytes)),
    // Admission proves the layout corresponds to TSchema.Type; trusted intentionally bypasses refinements.
    trusted: { encode: trusted.encode, decode: (bytes) => trusted.decode(bytes) as TSchema['Type'] },
  }
}
export type Column = Uint8Array | Uint16Array | Uint32Array | Int32Array | BigUint64Array | BigInt64Array
export type ColumnWidth = Width | 'u64' | 'i64'
const constructors = { u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i32: Int32Array, u64: BigUint64Array, i64: BigInt64Array }
/** Structure-of-arrays storage: every column has a declared width and equal row count. */
export const makeColumns = <TFields extends Readonly<Record<string, ColumnWidth>>>(fields: TFields) => ({
  allocate: (rows: number): { readonly [K in keyof TFields]: InstanceType<(typeof constructors)[TFields[K]]> } => {
    if (!Number.isSafeInteger(rows) || rows < 0) throw new FrameError(0, 'Invalid row count')
    return Object.fromEntries(Object.entries(fields).map(([key, width]) => [key, new constructors[width](rows)])) as { readonly [K in keyof TFields]: InstanceType<(typeof constructors)[TFields[K]]> }
  },
  validate: (input: Readonly<Record<keyof TFields, Column>>): void => {
    let rows: number | undefined
    if (Object.keys(input).length !== Object.keys(fields).length) throw new FrameError(0, 'Unexpected column count')
    for (const [key, width] of Object.entries(fields)) {
      const column = input[key]
      if (!(column instanceof constructors[width])) throw new FrameError(0, `Wrong width for column ${key}`)
      if (rows !== undefined && column.length !== rows) throw new FrameError(0, 'Column row counts differ')
      rows = column.length
    }
  },
})
