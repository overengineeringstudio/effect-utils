import * as crypto from 'node:crypto'

import { Context, Layer, Option } from 'effect'
import * as SchemaAST from 'effect/SchemaAST'

import { SensitiveId } from './Annotations.ts'

/**
 * Field-level redaction for `sensitive`/`redacted` struct fields (decision 0011,
 * docs/vrs/02-schema-serde/spec.md). A `sensitive` annotation is NOT a passive fact — it is consumed
 * as a serde TRANSFORM: the annotated field's value is ENCRYPTED at encode and
 * DECRYPTED at decode, so the wire/journal bytes hold ciphertext for that field
 * while every other field stays plaintext.
 *
 * The cipher is a PLUGGABLE Effect service (`RestateRedaction`) the consumer
 * provides. The serde runs synchronously (`encodeSync`/`decodeUnknownSync` —
 * docs/vrs/02-schema-serde/spec.md §1), so the cipher is a SYNCHRONOUS byte transform, resolved ONCE from the
 * captured runtime's context at `materialize` time and threaded into the serde.
 *
 * Field redaction MUST live here, not in the deferred whole-value
 * `JournalValueCodec`: post-serde bytes have no field structure to selectively
 * encrypt (decision 0011). So redaction ships in v1 with no codec.
 */

/* ── cipher service ───────────────────────────────────────────────────────── */

/**
 * A synchronous symmetric byte cipher: `encrypt` turns plaintext bytes into
 * self-describing ciphertext bytes; `decrypt` reverses it. Both run in-line
 * inside the synchronous serde, so they MUST be synchronous and total (a failure
 * throws). The reference {@link aesGcmRedactionLayer} implements this with
 * AES-256-GCM from `node:crypto`; a consumer may supply any cipher (KMS-backed,
 * envelope-encrypted, …) by providing its own {@link RestateRedaction} layer.
 */
export interface RedactionCipher {
  readonly encrypt: (plaintext: Uint8Array) => Uint8Array
  readonly decrypt: (ciphertext: Uint8Array) => Uint8Array
}

/**
 * The pluggable redaction cipher service. Provide it in the application `Layer`
 * (so the captured runtime carries it) whenever any served schema has a
 * `sensitive`/`redacted` field. If a schema declares a sensitive field but no
 * `RestateRedaction` is provided, encode/decode FAILS with a clear error rather
 * than silently passing plaintext (see {@link withRedaction}).
 */
export class RestateRedaction extends Context.Tag('@overeng/restate-effect/RestateRedaction')<
  RestateRedaction,
  RedactionCipher
>() {}

/* ── reference AES-256-GCM cipher (node:crypto) ──────────────────────────── */

const AES_KEY_BYTES = 32
const AES_IV_BYTES = 12

/**
 * Build a {@link RedactionCipher} from a 32-byte AES-256-GCM key. The ciphertext
 * layout is `iv(12) ‖ authTag(16) ‖ ciphertext`, self-describing so `decrypt`
 * needs only the key. A fresh random IV per `encrypt` makes the same plaintext
 * encrypt to different bytes (semantic security) — so redaction round-trips by
 * VALUE, not by byte equality.
 */
export const aesGcmCipher = (key: Uint8Array): RedactionCipher => {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(
      `RestateRedaction AES-256-GCM key must be ${AES_KEY_BYTES} bytes, got ${key.length}`,
    )
  }
  return {
    encrypt: (plaintext) => {
      const iv = crypto.randomBytes(AES_IV_BYTES)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decrypt: (ciphertext) => {
      const buf = Buffer.from(ciphertext)
      const iv = buf.subarray(0, AES_IV_BYTES)
      const authTag = buf.subarray(AES_IV_BYTES, AES_IV_BYTES + 16)
      const body = buf.subarray(AES_IV_BYTES + 16)
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(authTag)
      return Buffer.concat([decipher.update(body), decipher.final()])
    },
  }
}

/**
 * A ready-to-use {@link RestateRedaction} layer wrapping {@link aesGcmCipher}
 * with the given 32-byte key. The key is the secret the consumer manages (env /
 * secret store) — the binding never generates or persists one.
 */
export const aesGcmRedactionLayer = (key: Uint8Array): Layer.Layer<RestateRedaction> =>
  Layer.succeed(RestateRedaction, aesGcmCipher(key))

/* ── sensitive-field discovery (read ONCE on pre-transform signatures) ────── */

/**
 * The names of a struct's `sensitive`/`redacted`-annotated fields, found by
 * walking `ast.propertySignatures` and reading the annotation off each
 * `prop.type` (decision 0011 — the annotation lives on the field's value schema,
 * NOT the `PropertySignature`). Empty if the schema is not a struct or no field
 * is annotated. Read ONCE on the PRE-transform signatures, before the redaction
 * transform consumes them.
 */
export const findSensitiveFields = (ast: SchemaAST.AST): ReadonlyArray<string> => {
  if (ast._tag !== 'TypeLiteral') return []
  const fields: string[] = []
  for (const prop of ast.propertySignatures) {
    if (typeof prop.name !== 'string') continue
    if (Option.isSome(SchemaAST.getAnnotation<true>(SensitiveId)(prop.type)) === true) {
      fields.push(prop.name)
    }
  }
  return fields
}

/* ── encode/decode redaction wrappers ─────────────────────────────────────── */

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/**
 * The error thrown when a schema declares a `sensitive`/`redacted` field but no
 * {@link RestateRedaction} cipher was provided. A clear, actionable failure — the
 * binding NEVER silently writes plaintext for a field the author marked sensitive.
 */
export class RedactionCipherMissingError extends Error {
  constructor(fields: ReadonlyArray<string>) {
    super(
      `schema has sensitive field(s) [${fields.join(', ')}] but no RestateRedaction cipher was provided — ` +
        `provide a RestateRedaction layer (e.g. aesGcmRedactionLayer(key)) in the application Layer`,
    )
    this.name = 'RedactionCipherMissingError'
  }
}

/**
 * Wrap a schema's `encode`/`decode` pair with field-level redaction for its
 * `sensitive` fields. The transform operates on the JSON-shaped ENCODED object
 * (after the schema's own encode, before the schema's own decode), so it has the
 * field structure the whole-value codec lacks:
 *
 * - encode: `Schema.encodeSync` → for each sensitive field, replace its encoded
 *   value with `base64(cipher.encrypt(utf8(JSON.stringify(value))))`.
 * - decode: for each sensitive field, replace the ciphertext string with the
 *   decrypted `JSON.parse(utf8(cipher.decrypt(base64(...))))`, then
 *   `Schema.decodeUnknownSync`.
 *
 * `fields` is the cached result of {@link findSensitiveFields} on the
 * pre-transform AST. When `fields` is empty the original `encode`/`decode` are
 * returned untouched (zero overhead for non-sensitive schemas). When `fields` is
 * non-empty but `cipher` is `undefined`, encode/decode throws
 * {@link RedactionCipherMissingError}.
 */
export const withRedaction = <A>(input: {
  readonly fields: ReadonlyArray<string>
  readonly cipher: RedactionCipher | undefined
  readonly encode: (value: A) => unknown
  readonly decode: (encoded: unknown) => A
}): { readonly encode: (value: A) => unknown; readonly decode: (encoded: unknown) => A } => {
  if (input.fields.length === 0) return { encode: input.encode, decode: input.decode }

  const requireCipher = (): RedactionCipher => {
    if (input.cipher === undefined) throw new RedactionCipherMissingError(input.fields)
    return input.cipher
  }

  return {
    encode: (value) => {
      const encoded = input.encode(value)
      const cipher = requireCipher()
      if (typeof encoded !== 'object' || encoded === null) return encoded
      const out = { ...(encoded as Record<string, unknown>) }
      for (const field of input.fields) {
        if (!(field in out)) continue
        const plaintext = utf8Encoder.encode(JSON.stringify(out[field]))
        out[field] = Buffer.from(cipher.encrypt(plaintext)).toString('base64')
      }
      return out
    },
    decode: (encoded) => {
      const cipher = requireCipher()
      if (typeof encoded !== 'object' || encoded === null) return input.decode(encoded)
      const out = { ...(encoded as Record<string, unknown>) }
      for (const field of input.fields) {
        const ciphertext = out[field]
        if (typeof ciphertext !== 'string') continue
        const plaintext = cipher.decrypt(Buffer.from(ciphertext, 'base64'))
        out[field] = JSON.parse(utf8Decoder.decode(plaintext)) as unknown
      }
      return input.decode(out)
    },
  }
}
