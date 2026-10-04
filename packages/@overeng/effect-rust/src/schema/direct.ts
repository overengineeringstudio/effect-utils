import { Schema, SchemaAST } from 'effect'

import { decode as decodeSchema, encode as encodeSchema } from './validation.ts'
import { makeOptionalOmitter, makeValueCodec } from './value-codec.ts'

/** Same admitted contract and checks as ContractJson, without textual leaf staging. */
export const codec = <TSchema extends Schema.ConstraintCodec<unknown>>(
  schema: TSchema,
): Schema.Codec<TSchema['Type'], unknown> => makeValueCodec({ schema, transport: 'direct' })

/** Prepare the strict decoder once when constructing a service. */
export const decode = <TSchema extends Schema.ConstraintCodec<unknown>>(
  schema: TSchema,
): ((value: unknown) => TSchema['Type']) => decodeSchema(codec(schema))

/** Prepare width, timestamp, optional-key, and union handling once per service. */
export const encode = <TSchema extends Schema.ConstraintCodec<unknown>>(
  schema: TSchema,
): ((value: TSchema['Type']) => unknown) => {
  const values = codec(schema)
  const encoder = encodeSchema(values)
  const omitOptional = makeOptionalOmitter(SchemaAST.toEncoded(values.ast))
  return (value) => omitOptional(encoder(value))
}
