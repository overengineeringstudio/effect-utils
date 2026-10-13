import { type Schema } from 'effect'

import { decode as decodeSchema, encode as encodeSchema } from './validation.ts'
import { makeValueCodec } from './value-codec.ts'

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
  return encodeSchema(values, { omitOptional: true })
}
