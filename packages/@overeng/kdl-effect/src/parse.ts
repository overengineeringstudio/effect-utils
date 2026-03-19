import { Effect, ParseResult, Schema } from 'effect'
import { parse, format } from '@overeng/kdl'
import { kdlToObject, normalizeForSchema } from './decode.ts'
import { objectToKdlDocument } from './encode.ts'

/**
 * Create a Schema that decodes KDL text into the target type.
 * Analogous to `Schema.parseJson()`.
 */
export const parseKdl = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
): Schema.Schema<A, string, R> =>
  Schema.transformOrFail(Schema.String, schema, {
    strict: false,
    decode: (text) =>
      Effect.gen(function* () {
        const doc = parse(text)
        const raw = kdlToObject(doc)
        const normalized = normalizeForSchema(raw, schema.ast)
        return yield* Schema.decodeUnknown(schema)(normalized).pipe(
          Effect.mapError((e) => e.issue),
        )
      }),
    encode: (value) =>
      Effect.gen(function* () {
        const raw = yield* Schema.encodeUnknown(schema)(value).pipe(
          Effect.mapError((e) => e.issue),
        )
        const doc = objectToKdlDocument(raw as Record<string, unknown>)
        return format(doc)
      }),
  })
