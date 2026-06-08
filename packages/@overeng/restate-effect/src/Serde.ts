import * as restate from '@restatedev/restate-sdk'
import { JSONSchema, Option, ParseResult, Schema } from 'effect'

import { readSerdeOptions } from './Annotations.ts'

/**
 * The Restate `Serde<T>` shape (re-exported from the SDK). A single `Serde<T>`
 * governs every Restate-managed value of type `T` — handler input/output,
 * state, `ctx.run` results, awakeable payloads, durable promises, and ingress.
 */
export type RestateSerde<T> = restate.Serde<T>

/**
 * The slot a serde governs, which decides how a decode `ParseError` is
 * classified (spec §4):
 *
 * - `ingress` — a caller-facing input slot. A malformed payload is a
 *   deterministic bad request: throw `TerminalError(400)` (retrying cannot help).
 * - `internal` — a State value, `ctx.run` result, or awakeable / durable-promise
 *   payload. A decode failure here is a corrupt journal (bytes were written by a
 *   prior attempt or another handler), so it is a DEFECT that Restate retries —
 *   a 400 to the current caller would be wrong.
 */
export type SerdeSlot = 'ingress' | 'internal'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Bridges an Effect `Schema<A, I>` to a Restate `Serde<A>`. The `serialize` /
 * `deserialize` pair is synchronous (`Schema.encodeSync` / `decodeUnknownSync`
 * + JSON), so the schema must produce a sync validate — effectful/async
 * transforms break the contract and are unsupported (spec §4).
 *
 * `contentType` / `jsonSchema` default to `application/json` /
 * `JSONSchema.make`, overridable via the `Restate.serde` annotation
 * ([decisions/0011](../docs/decisions/0011-restate-schema-annotations.md)).
 *
 * The `slot` controls decode-failure classification: an `ingress` decode
 * failure throws `TerminalError(400)`; an `internal` decode failure rethrows
 * the raw error as a DEFECT for Restate to retry. The default slot is
 * `internal` — use `ingressSerde` / `internalSerde` for an explicit slot.
 */
export const effectSerde = <A, I>(
  schema: Schema.Schema<A, I>,
  slot: SerdeSlot = 'internal',
): RestateSerde<A> => {
  const encode = Schema.encodeSync(schema)
  const decode = Schema.decodeUnknownSync(schema)
  const overrides = readSerdeOptions(schema.ast)
  const contentType = Option.flatMap(overrides, (o) => Option.fromNullable(o.contentType)).pipe(
    Option.getOrElse(() => 'application/json'),
  )
  const jsonSchema = Option.flatMap(overrides, (o) => Option.fromNullable(o.jsonSchema)).pipe(
    Option.getOrElse(() => JSONSchema.make(schema) as object),
  )
  return {
    contentType,
    jsonSchema,
    serialize: (value: A): Uint8Array => encoder.encode(JSON.stringify(encode(value))),
    deserialize: (data: Uint8Array): A => {
      try {
        return decode(JSON.parse(decoder.decode(data)) as unknown)
      } catch (cause) {
        throw classifyDecodeFailure({ slot, cause })
      }
    },
  }
}

/** `effectSerde(schema, 'ingress')` — decode failure → `TerminalError(400)`. */
export const ingressSerde = <A, I>(schema: Schema.Schema<A, I>): RestateSerde<A> =>
  effectSerde(schema, 'ingress')

/** `effectSerde(schema, 'internal')` — decode failure → DEFECT (corrupt journal). */
export const internalSerde = <A, I>(schema: Schema.Schema<A, I>): RestateSerde<A> =>
  effectSerde(schema, 'internal')

/**
 * Classify a decode failure by slot. An `ingress` failure is a deterministic
 * bad request (`TerminalError(400)`); an `internal` failure is corrupt-journal
 * infrastructure rethrown as-is so the SDK retries it. An already-terminal
 * nested error is never double-wrapped.
 */
const classifyDecodeFailure = (input: {
  readonly slot: SerdeSlot
  readonly cause: unknown
}): unknown => {
  if (input.cause instanceof restate.TerminalError) return input.cause
  if (input.slot === 'internal') return input.cause
  const detail =
    ParseResult.isParseError(input.cause) === true
      ? ParseResult.TreeFormatter.formatErrorSync(input.cause)
      : input.cause instanceof Error
        ? input.cause.message
        : String(input.cause)
  return new restate.TerminalError(`serde decode failed: ${detail}`, { errorCode: 400 })
}
