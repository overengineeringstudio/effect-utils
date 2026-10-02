import { Option, Schema, SchemaAST, SchemaTransformation } from 'effect'

import type { Width } from '../compiler/ir.ts'
import { makeFrame, makeColumns } from './borsh.ts'
import { tagKeys } from './discriminator.ts'
import { canonicalJson, parseJson } from './json.ts'
import { decode, encode } from './validation.ts'
export { decode, encode } from './validation.ts'
export { canonicalJson, parseJson, JsonError } from './json.ts'
export { pattern, assertPortablePattern } from './pattern.ts'
export { tagKeys } from './discriminator.ts'
export { FrameError } from './borsh.ts'
export type { Codec, FrameCodec, FrameOptions, Column, ColumnWidth } from './borsh.ts'

/** Annotates an explicit lossless integer wire width. */
export const width = (value: Width | 'u64' | 'i64'): Schema.Annotations.Annotations => ({
  'x-effect-rust-width': value,
})
/** Annotates the per-object excess-key policy; unannotated objects remain strict. */
export const excess = (value: 'error' | 'ignore'): Schema.Annotations.Annotations => ({
  'x-effect-rust-excess': value,
})
/** Marks a struct or tagged union as non-exhaustive for generated Rust consumers. */
export const nonExhaustive: Schema.Annotations.Annotations = {
  'x-effect-rust-non-exhaustive': true,
}
const canonicalUnsigned = Schema.makeFilter<string>((value) => /^(0|[1-9][0-9]*)$/.test(value), {
  expected: 'canonical unsigned decimal',
})
const canonicalSigned = Schema.makeFilter<string>((value) => /^(0|-?[1-9][0-9]*)$/.test(value), {
  expected: 'canonical signed decimal',
})
/** Unsigned 64-bit integer encoded as a canonical decimal JSON string. */
export const U64 = Schema.String.check(canonicalUnsigned)
  .pipe(Schema.decodeTo(Schema.BigIntFromString))
  .check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 18446744073709551615n }))
  .annotate({ ...width('u64'), 'x-effect-rust-format': 'u64-decimal', identifier: 'Wire.U64' })
/** Signed 64-bit integer encoded as a canonical decimal JSON string. */
export const I64 = Schema.String.check(canonicalSigned)
  .pipe(Schema.decodeTo(Schema.BigIntFromString))
  .check(Schema.isBetweenBigInt({ minimum: -9223372036854775808n, maximum: 9223372036854775807n }))
  .annotate({ ...width('i64'), 'x-effect-rust-format': 'i64-decimal', identifier: 'Wire.I64' })
/** Unsigned 32-bit integer encoded as a lossless JSON number. */
export const U32 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4294967295 })).annotate(
  width('u32'),
)
/** Signed 32-bit integer encoded as a lossless JSON number. */
export const I32 = Schema.Int.check(
  Schema.isBetween({ minimum: -2147483648, maximum: 2147483647 }),
).annotate(width('i32'))
/** Unsigned 16-bit integer encoded as a lossless JSON number. */
export const U16 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })).annotate(
  width('u16'),
)
/** Unsigned 8-bit integer encoded as a lossless JSON number. */
export const U8 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })).annotate(
  width('u8'),
)

/** Checks calendar-valid RFC3339 timestamps with exact millisecond precision. */
export const validTimestampMillis = (text: string): boolean => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(text)
  if (match === null) return false
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const fraction = match[7] ?? ''
  if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3)) === true) return false
  const days = [
    31,
    year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  const zone = match[8]!
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return false
  return (
    month! >= 1 &&
    month! <= 12 &&
    day! >= 1 &&
    day! <= days[month! - 1]! &&
    hour! <= 23 &&
    minute! <= 59 &&
    second! <= 59 &&
    Number.isFinite(Date.parse(text)) &&
    /^\d{4}-/.test(new Date(text).toISOString())
  )
}
/** UTC timestamp decoded from RFC3339 with an explicit offset and millisecond precision. */
export const TimestampMillis = Schema.String.check(
  Schema.makeFilter(validTimestampMillis, {
    expected: 'RFC3339 with explicit offset and exact millisecond precision',
  }),
)
  .pipe(Schema.decodeTo(Schema.DateTimeUtcFromString))
  .annotate({ 'x-effect-rust-format': 'date-time-millis', identifier: 'Wire.TimestampMillis' })

/** Missing field, explicit null and value remain distinct in decoded Rust/Effect data. */
export const Patch = <TSchema extends Schema.Constraint>(schema: TSchema) => {
  const target = Schema.Union([
    Schema.TaggedStruct('Absent', {}),
    Schema.TaggedStruct('Null', {}),
    // The value is always a required field, independently of the supplied schema's key modifiers.
    Schema.TaggedStruct('Value', {
      value: Schema.declare<TSchema['Type']>(Schema.is(Schema.toType(schema))),
    }),
  ])
  return Schema.optionalKey(Schema.NullOr(schema))
    .pipe(
      Schema.decodeTo(
        target,
        SchemaTransformation.transformOptional<typeof target.Encoded, TSchema['Type'] | null>({
          decode: (input) =>
            Option.some(
              Option.isNone(input) === true
                ? { _tag: 'Absent' as const }
                : input.value === null
                  ? { _tag: 'Null' as const }
                  : { _tag: 'Value' as const, value: input.value },
            ),
          encode: (input) =>
            Option.isNone(input) === true || input.value._tag === 'Absent'
              ? Option.none()
              : Option.some(input.value._tag === 'Null' ? null : input.value.value),
        }),
      ),
    )
    .annotate({ 'x-effect-rust-patch': schema.ast })
}

/** Schema validation at control-plane boundaries is strict by default; any key order is accepted. */
export const decodeJson =
  <TSchema extends Schema.ConstraintDecoder<unknown>>(schema: TSchema) =>
  (text: string) =>
    decode(schema)(parseJson(text))

/** Work on the validated encoded shape, never on decoded semantic values such as Patch. */
const omitOptionalUndefined = ({
  ast,
  value,
  depth = 0,
}: {
  ast: SchemaAST.AST
  value: unknown
  depth?: number
}): unknown => {
  // Canonical JSON remains responsible for rejecting excessive depth and non-JSON values.
  if (depth > 128) return value
  if (ast._tag === 'Suspend')
    return omitOptionalUndefined({ ast: ast.thunk(), value, depth })
  if (ast._tag === 'Union') {
    const member = ast.types.find((candidate) => Schema.is(Schema.make(candidate))(value))
    return member === undefined
      ? value
      : omitOptionalUndefined({ ast: member, value, depth })
  }
  if (
    ast._tag === 'Arrays' &&
    Array.isArray(value) === true &&
    ast.elements.length === 0 &&
    ast.rest.length === 1
  )
    return value.map((item) =>
      omitOptionalUndefined({ ast: ast.rest[0]!, value: item, depth: depth + 1 }),
    )
  if (
    ast._tag !== 'Objects' ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) === true
  )
    return value
  const fields = new Map(ast.propertySignatures.map((field) => [String(field.name), field.type]))
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const field = fields.get(key)
    if (item === undefined && field !== undefined && SchemaAST.isOptional(field) === true)
      continue
    const target =
      field ??
      ast.indexSignatures.find((signature) => Schema.is(Schema.make(signature.parameter))(key))
        ?.type
    Object.defineProperty(output, key, {
      value:
        target === undefined
          ? item
          : omitOptionalUndefined({ ast: target, value: item, depth: depth + 1 }),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return output
}

/** Canonical JSON with each tagged union's discriminator first; the tag set comes from the schema, like Rust `TAG_FIELDS`. */
export const encodeJson = <TSchema extends Schema.ConstraintEncoder<unknown>>(schema: TSchema) => {
  const keys = tagKeys(schema.ast)
  const encoder = encode(schema)
  const encodedAST = SchemaAST.toEncoded(schema.ast)
  return (value: TSchema['Type']): string =>
    canonicalJson(omitOptionalUndefined({ ast: encodedAST, value: encoder(value) }), keys)
}
/** Constructs checked and trusted Borsh frame codecs from a live contract schema. */
export const frame = makeFrame
/** Constructs explicit-width column codecs for bulk wire payloads. */
export const columns = makeColumns
