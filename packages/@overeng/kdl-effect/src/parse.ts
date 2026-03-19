import { Effect, type ParseResult, Schema } from 'effect'
import { parseEffect, type Document } from '@overeng/kdl'
import type { KdlParseError } from '@overeng/kdl'
import { kdlToObject } from './decode.ts'

/** Parse KDL text and decode into a typed value via an Effect Schema */
export const parseAndDecode = <A, I>(
  schema: Schema.Schema<A, I>,
  text: string,
): Effect.Effect<A, KdlParseError | ParseResult.ParseError> =>
  Effect.gen(function* () {
    const doc: Document = yield* parseEffect(text)
    const obj = kdlToObject(doc)
    return yield* Schema.decodeUnknown(schema)(obj)
  })
