/**
 * Restate Schema annotations: Restate-specific facts carried ON the schema, read
 * once at the site that owns the fact. Each `Restate.*` annotation returns the
 * SAME schema with the fact attached.
 *
 * - `Restate.terminal(Err, { errorCode })` — the error is non-retryable; cross the
 *   wire with this status code (e.g. 404/409). This is the default classification.
 * - `Restate.retryable(Err)` — Restate RETRIES the handler instead of propagating.
 * - `Restate.retention(schema, { … })` — journal/idempotency/workflow retention,
 *   mapped to SDK options at `materialize` (equivalent to builder `options`, but
 *   kept with the schema).
 * - `Restate.sensitive(field)` / `Restate.redacted(field)` — encrypt the FIELD at
 *   encode, decrypt at decode, via a pluggable `RestateRedaction` cipher.
 *
 * Per-handler/service retry + timeout knobs (`retryPolicy`, `inactivityTimeout`,
 * `ingressPrivate`, …) live in the builder `options`, not on the schema.
 */
import { Effect, Schema } from 'effect'

import { aesGcmRedactionLayer, Restate, RestateService } from '../src/mod.ts'

/* ── Error classification: per-error status code, retryable vs terminal ────── */

/** Terminal with a 404: the caller sees status 404; Restate does not retry. */
export class NotFound extends Schema.TaggedError<NotFound>('example/NotFound')('NotFound', {
  id: Schema.String,
}) {}
export const NotFoundTerminal = Restate.terminal(NotFound, { errorCode: 404 })

/** Retryable: Restate re-runs the handler rather than propagating to the caller. */
export class Throttled extends Schema.TaggedError<Throttled>('example/Throttled')(
  'Throttled',
  {},
) {}
export const ThrottledRetryable = Restate.retryable(Throttled)

/* ── Retention on the input schema (mapped to SDK retention at materialize) ── */

export const LookupInput = Restate.retention(Schema.Struct({ id: Schema.String }), {
  idempotency: '5 minutes',
  journal: '1 hour',
})

/* ── Field-level redaction: `sensitive` encrypts the field on the wire/journal ── */

export const StoreSecret = Schema.Struct({
  account: Schema.String,
  /* `pin` is ciphertext on the wire/journal; every other field stays plaintext. */
  pin: Restate.sensitive(Schema.String),
})

/**
 * Provide a `RestateRedaction` cipher in the application Layer whenever any served
 * schema marks a field sensitive — otherwise encode/decode FAILS with a clear
 * `RedactionCipherMissingError` (never silently plaintext). `aesGcmRedactionLayer`
 * is a ready AES-256-GCM reference; the 32-byte key is the consumer's secret.
 */
export const RedactionLayer = aesGcmRedactionLayer(new Uint8Array(32).fill(7))

/* ── A contract using the annotated schemas + per-handler retry/timeout options ── */

export const Vault = RestateService.contract('vault', {
  lookup: {
    input: LookupInput,
    success: Schema.String,
    error: NotFoundTerminal,
    /* Restate's durable retry policy + timeouts are TYPED builder options. Durable
     * retries are Restate's — never wrap a durable op in `Effect.retry`. */
    options: {
      retryPolicy: {
        maxAttempts: 5,
        initialIntervalMillis: 100,
        maxIntervalMillis: 5_000,
        exponentiationFactor: 2,
        onMaxAttempts: 'pause', // resumable from the CLI/UI on giving up
      },
      inactivityTimeoutMillis: 30_000,
    },
  },
  store: { input: StoreSecret, success: Schema.Void },
})

export const VaultLive = RestateService.implement<typeof Vault>(Vault, {
  lookup: ({ id }) =>
    Effect.gen(function* () {
      if (id === 'missing') return yield* new NotFound({ id })
      return `value-for-${id}`
    }),
  store: () => Effect.void,
})
