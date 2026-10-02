import { Option, Schema, SchemaTransformation } from 'effect'
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

export const width = (value: Width | 'u64' | 'i64'): Schema.Annotations.Annotations => ({ 'x-effect-rust-width': value })
export const excess = (value: 'error' | 'ignore'): Schema.Annotations.Annotations => ({ 'x-effect-rust-excess': value })
export const nonExhaustive: Schema.Annotations.Annotations = { 'x-effect-rust-non-exhaustive': true }
const canonicalUnsigned = Schema.makeFilter<string>((value) => /^(0|[1-9][0-9]*)$/.test(value), { expected: 'canonical unsigned decimal' })
const canonicalSigned = Schema.makeFilter<string>((value) => /^(0|-?[1-9][0-9]*)$/.test(value), { expected: 'canonical signed decimal' })
export const U64 = Schema.String.check(canonicalUnsigned).pipe(Schema.decodeTo(Schema.BigIntFromString))
  .check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 18446744073709551615n }))
  .annotate({ ...width('u64'), 'x-effect-rust-format': 'u64-decimal', identifier: 'Wire.U64' })
export const I64 = Schema.String.check(canonicalSigned).pipe(Schema.decodeTo(Schema.BigIntFromString))
  .check(Schema.isBetweenBigInt({ minimum: -9223372036854775808n, maximum: 9223372036854775807n }))
  .annotate({ ...width('i64'), 'x-effect-rust-format': 'i64-decimal', identifier: 'Wire.I64' })
export const U32 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4294967295 })).annotate(width('u32'))
export const I32 = Schema.Int.check(Schema.isBetween({ minimum: -2147483648, maximum: 2147483647 })).annotate(width('i32'))
export const U16 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })).annotate(width('u16'))
export const U8 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })).annotate(width('u8'))

export const validTimestampMillis = (text: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(text)
  if (!match) return false
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const fraction = match[7] ?? ''
  if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) return false
  const days = [31, year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const zone = match[8]!
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return false
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= days[month! - 1]! && hour! <= 23 && minute! <= 59 && second! <= 59 && Number.isFinite(Date.parse(text)) && /^\d{4}-/.test(new Date(text).toISOString())
}
export const TimestampMillis = Schema.String.check(Schema.makeFilter(validTimestampMillis, { expected: 'RFC3339 with explicit offset and exact millisecond precision' }))
  .pipe(Schema.decodeTo(Schema.DateTimeUtcFromString))
  .annotate({ 'x-effect-rust-format': 'date-time-millis', identifier: 'Wire.TimestampMillis' })

/** Missing field, explicit null and value remain distinct in decoded Rust/Effect data. */
export const Patch = <TSchema extends Schema.Constraint>(schema: TSchema) => {
  const target = Schema.Union([
    Schema.TaggedStruct('Absent', {}),
    Schema.TaggedStruct('Null', {}),
    // The value is always a required field, independently of the supplied schema's key modifiers.
    Schema.TaggedStruct('Value', { value: Schema.declare<TSchema['Type']>(Schema.is(Schema.toType(schema))) }),
  ])
  return Schema.optionalKey(Schema.NullOr(schema)).pipe(Schema.decodeTo(target, SchemaTransformation.transformOptional<typeof target.Encoded, TSchema['Type'] | null>({
    decode: (input) => Option.some(Option.isNone(input) ? { _tag: 'Absent' as const } : input.value === null ? { _tag: 'Null' as const } : { _tag: 'Value' as const, value: input.value }),
    encode: (input) => Option.isNone(input) || input.value._tag === 'Absent' ? Option.none() : Option.some(input.value._tag === 'Null' ? null : input.value.value),
  }))).annotate({ 'x-effect-rust-patch': schema.ast })
}

/** Schema validation at control-plane boundaries is strict by default; any key order is accepted. */
export const decodeJson = <TSchema extends Schema.ConstraintDecoder<unknown>>(schema: TSchema) => (text: string) => decode(schema)(parseJson(text))
/** Canonical JSON with each tagged union's discriminator first; the tag set comes from the schema, like Rust `TAG_FIELDS`. */
export const encodeJson = <TSchema extends Schema.ConstraintEncoder<unknown>>(schema: TSchema) => {
  const keys = tagKeys(schema.ast)
  const encoder = encode(schema)
  return (value: TSchema['Type']): string => canonicalJson(encoder(value), keys)
}
export const frame = makeFrame
export const columns = makeColumns
