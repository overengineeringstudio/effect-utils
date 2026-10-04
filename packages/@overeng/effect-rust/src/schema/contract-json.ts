import { Effect, Schema, SchemaAST, SchemaIssue, SchemaParser, SchemaTransformation } from 'effect'

import { tagKeys } from './discriminator.ts'
import { canonicalJson, parseJson } from './json.ts'
import { decode as decodeSchema, encode as encodeSchema, prepare } from './validation.ts'
import { makeOptionalOmitter, makeValueCodec } from './value-codec.ts'

/** JSON value boundary: wide integers are decimal strings, timestamps are RFC3339. */
export const valueCodec = <TSchema extends Schema.ConstraintCodec<unknown>>(
  schema: TSchema,
): Schema.Codec<TSchema['Type'], unknown> => makeValueCodec({ schema, transport: 'json' })

export { canonicalJson, parseJson, JsonError } from './json.ts'
export { tagKeys } from './discriminator.ts'


const jsonEffect = <TValue>(run: () => TValue): Effect.Effect<TValue, SchemaIssue.Issue> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new SchemaIssue.InvalidValue({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  })

/** Ordinary Effect string codec, preserving the exact authored domain type. */
export const codec = <TSchema extends Schema.ConstraintCodec<unknown>>(
  schema: TSchema,
): Schema.Codec<TSchema['Type'], string> => {
  const values = valueCodec(schema)
  const decodeValue = SchemaParser.decodeUnknownEffect(values, { onExcessProperty: 'error' })
  const encodeValue = SchemaParser.encodeUnknownEffect(values, { onExcessProperty: 'error' })
  const omitOptional = makeOptionalOmitter(SchemaAST.toEncoded(values.ast))
  const keys = tagKeys(schema.ast)
  const domain = Schema.declare<TSchema['Type']>(Schema.is(Schema.toType(schema)))
  return Schema.String.pipe(
    Schema.decodeTo(
      domain,
      SchemaTransformation.transformEffect({
        decode: (text) =>
          Effect.flatMap(
            jsonEffect(() => prepare({ ast: values.ast, input: parseJson(text, true) })),
            (input) => decodeValue(input),
          ),
        encode: (value) =>
          Effect.flatMap(
            encodeValue(prepare({ ast: SchemaAST.toType(values.ast), input: value })),
            (encoded) =>
              jsonEffect(() =>
                canonicalJson(omitOptional(encoded), keys, true),
              ),
          ),
      }),
    ),
  )
}

/** Strict decoded JSON value boundary, for host bridges that already parse JSON. */
export const decodeValue = <TSchema extends Schema.ConstraintCodec<unknown>>(schema: TSchema) =>
  decodeSchema(valueCodec(schema))

/** Strict encoded JSON value boundary, with schema-aware optional undefined omission. */
export const encodeValue = <TSchema extends Schema.ConstraintCodec<unknown>>(schema: TSchema) => {
  const values = valueCodec(schema)
  const encoder = encodeSchema(values)
  const omitOptional = makeOptionalOmitter(SchemaAST.toEncoded(values.ast))
  return (value: TSchema['Type']): unknown => omitOptional(encoder(value))
}

/** Synchronous convenience using the same ordinary Effect codec. */
export const decode = <TSchema extends Schema.ConstraintCodec<unknown>>(schema: TSchema) =>
  Schema.decodeUnknownSync(codec(schema))
/** Synchronous canonical output using the same ordinary Effect codec. */
export const encode = <TSchema extends Schema.ConstraintCodec<unknown>>(schema: TSchema) =>
  Schema.encodeSync(codec(schema))
