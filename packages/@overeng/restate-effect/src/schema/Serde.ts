import * as restate from '@restatedev/restate-sdk'
import { JSONSchema, Option, ParseResult, Schema } from 'effect'

import { textEncodeToArrayBuffer } from '@overeng/utils'

import { readSerdeOptions } from './Annotations.ts'
import { findSensitiveFields, type RedactionCipher, withRedaction } from './Redaction.ts'

/**
 * The Restate `Serde<T>` shape (re-exported from the SDK). A single `Serde<T>`
 * governs every Restate-managed value of type `T` — handler input/output,
 * state, `ctx.run` results, awakeable payloads, durable promises, and ingress.
 */
export type RestateSerde<T> = restate.Serde<T>

/**
 * The slot a serde governs, which decides how a decode `ParseError` is
 * classified (docs/vrs/02-schema-serde/spec.md §1):
 *
 * - `ingress` — a caller-facing input slot. A malformed payload is a
 *   deterministic bad request: throw `TerminalError(400)` (retrying cannot help).
 * - `internal` — a State value, `ctx.run` result, or awakeable / durable-promise
 *   payload. A decode failure here is a corrupt journal (bytes were written by a
 *   prior attempt or another handler), so it is a DEFECT that Restate retries —
 *   a 400 to the current caller would be wrong.
 */
export type SerdeSlot = 'ingress' | 'internal'

const decoder = new TextDecoder()

/**
 * Bridges an Effect `Schema<A, I>` to a Restate `Serde<A>`. The `serialize` /
 * `deserialize` pair is synchronous (`Schema.encodeSync` / `decodeUnknownSync`
 * + JSON), so the schema must produce a sync validate — effectful/async
 * transforms break the contract and are unsupported (docs/vrs/02-schema-serde/spec.md §1).
 *
 * `contentType` / `jsonSchema` default to `application/json` /
 * `JSONSchema.make`, overridable via the `Restate.serde` annotation
 * ([.decisions/0011](../../docs/vrs/.decisions/0011-restate-schema-annotations.md)).
 *
 * The `slot` controls decode-failure classification: an `ingress` decode
 * failure throws `TerminalError(400)`; an `internal` decode failure rethrows
 * the raw error as a DEFECT for Restate to retry. The default slot is
 * `internal` — use `ingressSerde` / `internalSerde` for an explicit slot.
 */
export const effectSerde = <A, I>(
  schema: Schema.Schema<A, I>,
  slot: SerdeSlot = 'internal',
  options?: { readonly redaction?: RedactionCipher },
): RestateSerde<A> => {
  /* Field-level redaction (decision 0011, docs/vrs/02-schema-serde/spec.md): for each `sensitive`/
   * `redacted` field (read ONCE on the pre-transform property signatures), wrap
   * the schema's encode/decode with an encrypt-at-encode / decrypt-at-decode
   * transform via the provided cipher. No sensitive field → the original
   * encode/decode pass through untouched. A sensitive field but no cipher →
   * encode/decode throws a clear `RedactionCipherMissingError` (never plaintext). */
  const sensitiveFields = findSensitiveFields(schema.ast)
  const { encode, decode } = withRedaction<A>({
    fields: sensitiveFields,
    cipher: options?.redaction,
    encode: Schema.encodeSync(schema),
    decode: Schema.decodeUnknownSync(schema),
  })
  const overrides = readSerdeOptions(schema.ast)
  /* A void/undefined payload has NO body. Restate's `serde.empty` leaves the
   * content type UNSET so the server allows an empty body (`application/json` +
   * an empty body is rejected as "Empty body not allowed"). Mirror that: a
   * `VoidKeyword`/`UndefinedKeyword` schema defaults to no content type. */
  const isVoid = schema.ast._tag === 'VoidKeyword' || schema.ast._tag === 'UndefinedKeyword'
  const contentType = Option.flatMap(overrides, (o) => Option.fromNullable(o.contentType)).pipe(
    Option.getOrElse(() => (isVoid ? undefined : 'application/json')),
  )
  const jsonSchema = Option.flatMap(overrides, (o) => Option.fromNullable(o.jsonSchema)).pipe(
    Option.getOrElse(() => JSONSchema.make(schema) as object),
  )
  return {
    /* Omit `contentType` entirely when unset (void payload), per `exactOptionalPropertyTypes`. */
    ...(contentType !== undefined ? { contentType } : {}),
    jsonSchema,
    serialize: (value: A): Uint8Array => {
      const encoded = encode(value)
      /* `Schema.Void` (and any `undefined` payload) has no JSON representation
       * (`JSON.stringify(undefined) === undefined`). Restate's convention for a
       * void/empty payload is an EMPTY body, so emit zero bytes; `deserialize`
       * reverses it (an empty body decodes back to the `undefined` value). */
      if (encoded === undefined) return new Uint8Array(0)
      /* `textEncodeToArrayBuffer` is the SSOT for byte encoding (`@overeng/utils`,
       * isomorphic/binary.ts): UTF-8 encode guaranteed-`ArrayBuffer`-backed. */
      return textEncodeToArrayBuffer(JSON.stringify(encoded))
    },
    deserialize: (data: Uint8Array): A => {
      try {
        if (data.length === 0) return decode(undefined)
        return decode(JSON.parse(decoder.decode(data)) as unknown)
      } catch (cause) {
        throw classifyDecodeFailure({ slot, cause })
      }
    },
  }
}

/** `effectSerde(schema, 'ingress')` — decode failure → `TerminalError(400)`. */
export const ingressSerde = <A, I>(
  schema: Schema.Schema<A, I>,
  options?: { readonly redaction?: RedactionCipher },
): RestateSerde<A> => effectSerde(schema, 'ingress', options)

/** `effectSerde(schema, 'internal')` — decode failure → DEFECT (corrupt journal). */
export const internalSerde = <A, I>(
  schema: Schema.Schema<A, I>,
  options?: { readonly redaction?: RedactionCipher },
): RestateSerde<A> => effectSerde(schema, 'internal', options)

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
