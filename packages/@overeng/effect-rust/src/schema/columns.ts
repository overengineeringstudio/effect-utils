import { Schema } from 'effect'

import type { Type, Width } from '../compiler/ir.ts'
import { lower } from '../compiler/lower.ts'
import { FrameError } from './borsh.ts'

/** Numeric structure-of-arrays storage uses the same inferred or pinned width as frames. */
export type Column =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | BigUint64Array
  | BigInt64Array
  | Float32Array
/** Integer widths supported by numeric column storage, including bigint-backed 64-bit columns. */
export type ColumnWidth = Width | 'f32'
const constructors = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  u64: BigUint64Array,
  i64: BigInt64Array,
  f32: Float32Array,
}

/** Column storage does not encode optionality, nullability or nested values. */
export const make = <const TFields extends Schema.Struct.Fields>(
  schema: Schema.Struct<TFields>,
) => {
  const ir = lower({ Row: schema }, 'columns')
  const row = ir.defs.Row
  if (row?.kind !== 'struct') throw new FrameError(0, 'Columns require a numeric struct')
  const layoutOf = (type: Type): { readonly width: ColumnWidth; readonly numeric: boolean } => {
    const seen = new Set<string>()
    while (type.kind === 'ref') {
      if (seen.has(type.name) === true) throw new FrameError(0, 'Cyclic column type alias')
      seen.add(type.name)
      const target = ir.defs[type.name]
      if (target?.kind !== 'alias') throw new FrameError(0, 'Columns require numeric fields')
      type = target.type
    }
    if (type.kind === 'int') return { width: type.width, numeric: true }
    if (type.kind === 'f32') return { width: 'f32', numeric: true }
    if (type.kind === 'u64' || type.kind === 'i64') return { width: type.kind, numeric: false }
    throw new FrameError(0, 'Columns require numeric fields')
  }
  const fields = row.fields.map((field) => {
    if (field.presence !== 'required') throw new FrameError(0, 'Columns require required fields')
    const property = schema.ast.propertySignatures.find(
      (signature) => signature.name === field.wire,
    )
    if (property === undefined) throw new FrameError(0, 'Missing column schema')
    const { width, numeric } = layoutOf(field.type)
    return { key: field.wire, width, numeric, is: Schema.is(Schema.make(property.type)) }
  })
  type Storage = { readonly [TKey in keyof TFields]: Column }
  return {
    allocate: (rows: number): Storage => {
      if (Number.isSafeInteger(rows) === false || rows < 0)
        throw new FrameError(0, 'Invalid row count')
      // Admission proves these entries are exactly the authored struct's numeric keys.
      return Object.fromEntries(
        fields.map(({ key, width }) => [key, new constructors[width](rows)]),
      ) as Storage
    },
    validate: (input: Storage): void => {
      let rows: number | undefined
      if (Object.keys(input).length !== fields.length)
        throw new FrameError(0, 'Unexpected column count')
      for (const { key, width, numeric, is } of fields) {
        const column: unknown = Reflect.get(input, key)
        if (!(column instanceof constructors[width]))
          throw new FrameError(0, `Wrong width for column ${key}`)
        if (rows !== undefined && column.length !== rows)
          throw new FrameError(0, 'Column row counts differ')
        rows = column.length
        for (const value of column) {
          const domain = numeric === true && typeof value === 'bigint' ? Number(value) : value
          if (
            (numeric === true &&
              (typeof domain !== 'number' ||
                (width !== 'f32' && Number.isSafeInteger(domain) === false))) ||
            is(domain) === false
          )
            throw new FrameError(0, `Value violates column ${key} schema`)
        }
      }
    },
  }
}
