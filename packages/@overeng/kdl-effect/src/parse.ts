import { ParseResult, Schema } from 'effect'

import { format, parse } from '@overeng/kdl'

import { kdlToObject, normalizeForSchema } from './decode.ts'
import { objectToKdlDocument } from './encode.ts'

/**
 * Base KDL transformation: `string ↔ unknown`
 *
 * Analogous to how `Schema.parseJson()` wraps `JSON.parse`/`JSON.stringify`,
 * this wraps `parse`/`format` from `@overeng/kdl`.
 *
 * Parse errors are mapped to `ParseResult.Type` issues (not thrown),
 * following the same pattern as Effect's `Schema.parseJson`.
 */
const ParseKdl = Schema.transformOrFail(
  Schema.String.annotations({ description: 'a KDL string to be decoded' }),
  Schema.Unknown,
  {
    strict: true,
    decode: (text, _, ast) =>
      ParseResult.try({
        try: () => {
          const doc = parse(text)
          return kdlToObject(doc)
        },
        catch: (e) => new ParseResult.Type(ast, text, e instanceof Error ? e.message : String(e)),
      }),
    encode: (value, _, ast) =>
      ParseResult.try({
        try: () => {
          const doc = objectToKdlDocument(value as Record<string, unknown>)
          return format(doc)
        },
        catch: (e) => new ParseResult.Type(ast, value, e instanceof Error ? e.message : String(e)),
      }),
  },
).annotations({ title: 'parseKdl' })

/**
 * Create a Schema that decodes KDL text into the target type.
 * Analogous to `Schema.parseJson(schema)`.
 *
 * Uses `Schema.compose` to chain: `string → unknown` (via KDL parse) then `unknown → A` (via schema).
 * Array normalization is applied between the two steps using the target schema's AST.
 */
export const parseKdl = <A, I, R>(schema: Schema.Schema<A, I, R>): Schema.Schema<A, string, R> => {
  const normalizedKdl = Schema.transformOrFail(Schema.Unknown, Schema.Unknown, {
    strict: true,
    decode: (raw) => ParseResult.succeed(normalizeForSchema(raw, schema.ast)),
    encode: (value) => ParseResult.succeed(value),
  })

  return Schema.compose(Schema.compose(ParseKdl, normalizedKdl), schema) as Schema.Schema<
    A,
    string,
    R
  >
}
