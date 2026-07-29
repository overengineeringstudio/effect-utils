import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from 'effect'

import { format, parse } from '@overeng/kdl'

import { kdlToObject, normalizeForSchema } from './decode.ts'
import { objectToKdlDocument } from './encode.ts'

/**
 * Base KDL transformation: `string ↔ unknown`
 *
 * Analogous to how `Schema.fromJsonString(Schema.Unknown)` wraps `JSON.parse`/`JSON.stringify`,
 * this wraps `parse`/`format` from `@overeng/kdl`.
 *
 * Parse errors are mapped to `SchemaIssue.InvalidValue` issues (not thrown),
 * following the same pattern as Effect's `Schema.parseJson`.
 */
const ParseKdl = Schema.String.annotate({
  description: 'a KDL string to be decoded',
})
  .pipe(
    Schema.decodeTo(
      Schema.Unknown,
      SchemaTransformation.transformOrFail<unknown, string>({
        decode: (text) =>
          Effect.try({
            try: () => {
              const doc = parse(text)
              return kdlToObject(doc)
            },
            catch: (e) =>
              new SchemaIssue.InvalidValue(Option.some(text), {
                message: e instanceof Error ? e.message : String(e),
              }),
          }),
        encode: (value) =>
          Effect.try({
            try: () => {
              const doc = objectToKdlDocument(value as Record<string, unknown>)
              return format(doc)
            },
            catch: (e) =>
              new SchemaIssue.InvalidValue(Option.some(value), {
                message: e instanceof Error ? e.message : String(e),
              }),
          }),
      }),
    ),
  )
  .annotate({ title: 'parseKdl' })

/**
 * Create a Schema that decodes KDL text into the target type.
 * Analogous to `Schema.fromJsonString(schema)`.
 *
 * Chains `string → unknown` (via KDL parse), normalized `unknown → unknown`,
 * then `unknown → A` (via the target schema).
 */
export const parseKdl = <A, I, R>(
  schema: Schema.Codec<A, I, R, R>,
): Schema.Codec<A, string, R, R> => {
  const normalizedKdl = Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.Unknown,
      SchemaTransformation.transform({
        decode: (raw) => normalizeForSchema(raw, schema.ast),
        encode: (value) => value,
      }),
    ),
  )

  return ParseKdl.pipe(Schema.decodeTo(normalizedKdl), Schema.decodeTo(schema))
}
