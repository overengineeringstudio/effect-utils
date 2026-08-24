import { Effect, Schema, SchemaGetter, SchemaIssue } from 'effect'

import { format, parse } from '@overeng/kdl'

import { kdlToObject, normalizeForSchema } from './decode.ts'
import { objectToKdlDocument } from './encode.ts'

/**
 * Base KDL transformation: `string ↔ unknown`
 *
 * Analogous to how `Schema.fromJsonString()` wraps `JSON.parse`/`JSON.stringify`,
 * this wraps `parse`/`format` from `@overeng/kdl`.
 *
 * Parse errors are mapped to `SchemaIssue.InvalidValue` issues (not thrown),
 * following the same pattern as Effect's `Schema.fromJsonString`.
 */
const ParseKdl = Schema.String.annotate({
  description: 'a KDL string to be decoded',
}).pipe(
  Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.transformOrFail((text) =>
      Effect.try({
        try: () => kdlToObject(parse(text)),
        catch: (e) =>
          new SchemaIssue.InvalidValue({
            message: e instanceof Error ? e.message : String(e),
          }),
      }),
    ),
    encode: SchemaGetter.transformOrFail((value) =>
      Effect.try({
        try: () => format(objectToKdlDocument(value as Record<string, unknown>)),
        catch: (e) =>
          new SchemaIssue.InvalidValue({
            message: e instanceof Error ? e.message : String(e),
          }),
      }),
    ),
  }),
).annotate({ title: 'parseKdl' })

/**
 * Create a Schema that decodes KDL text into the target type.
 * Analogous to `Schema.fromJsonString(schema)`.
 *
 * Chains: `string → unknown` (via KDL parse) then `unknown → A` (via schema).
 * Array normalization is applied between the two steps using the target schema's AST.
 */
export const parseKdl = <S extends Schema.Codec<any, any, any, any>>(
  schema: S,
): Schema.Codec<S['Type'], string, S['DecodingServices'], S['EncodingServices']> => {
  const normalizedKdl = Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.transform((raw) => normalizeForSchema(raw, schema.ast)),
    encode: SchemaGetter.transform((value) => value),
  })(Schema.Unknown)

  return Schema.decodeTo(schema)(
    Schema.decodeTo(normalizedKdl)(ParseKdl),
  ) as Schema.Codec<S['Type'], string, S['DecodingServices'], S['EncodingServices']>
}
