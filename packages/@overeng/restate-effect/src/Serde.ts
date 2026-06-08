import * as restate from '@restatedev/restate-sdk'
import { JSONSchema, ParseResult, Schema } from 'effect'

/**
 * The Restate `Serde<T>` shape (re-exported from the SDK). A single `Serde<T>`
 * governs every Restate-managed value of type `T` — handler input/output,
 * state, `ctx.run` results, awakeable payloads, durable promises, and ingress.
 */
export type RestateSerde<T> = restate.Serde<T>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Bridges an Effect `Schema` to a Restate `Serde`. This is the Schema pillar:
 * provide one `effectSerde(schema)` and thread it through `input`/`output` (and
 * any `ctx.*` serde slots) so the boundary is Schema-typed end to end.
 *
 * On the wire we emit `application/json` (the encoded `I` shape, JSON-stringified)
 * and surface the schema's JSON Schema for Restate discovery/UI.
 *
 * Malformed or invalid payloads are deterministic failures — retrying cannot
 * help — so a decode/encode `ParseError` is thrown as a `restate.TerminalError`
 * with `errorCode: 400`, which propagates to the caller without retry.
 */
export const effectSerde = <A, I>(schema: Schema.Schema<A, I>): RestateSerde<A> => {
  const encode = Schema.encodeSync(schema)
  const decode = Schema.decodeUnknownSync(schema)
  return {
    contentType: 'application/json',
    jsonSchema: JSONSchema.make(schema) as object,
    serialize: (value: A): Uint8Array => {
      try {
        return encoder.encode(JSON.stringify(encode(value)))
      } catch (cause) {
        throw toTerminalSerdeError({ phase: 'encode', cause })
      }
    },
    deserialize: (data: Uint8Array): A => {
      try {
        return decode(JSON.parse(decoder.decode(data)) as unknown)
      } catch (cause) {
        throw toTerminalSerdeError({ phase: 'decode', cause })
      }
    },
  }
}

const toTerminalSerdeError = (input: {
  readonly phase: 'encode' | 'decode'
  readonly cause: unknown
}): restate.TerminalError => {
  /* Already terminal (e.g. a nested serde threw one) — don't double-wrap. */
  if (input.cause instanceof restate.TerminalError) return input.cause
  const detail =
    ParseResult.isParseError(input.cause) === true
      ? ParseResult.TreeFormatter.formatErrorSync(input.cause)
      : input.cause instanceof Error
        ? input.cause.message
        : String(input.cause)
  return new restate.TerminalError(`serde ${input.phase} failed: ${detail}`, { errorCode: 400 })
}
