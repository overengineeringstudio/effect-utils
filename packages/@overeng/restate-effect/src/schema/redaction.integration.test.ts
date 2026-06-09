/**
 * Integration gap: `sensitive`-field redaction ON THE WIRE against a real native
 * server (decision 0011, docs/vrs/02-schema-serde/spec.md §1). A `sensitive` field is a serde TRANSFORM
 * (encrypt-at-encode / decrypt-at-decode) the server's I/O serde applies. This
 * proves the TRANSPORTED bytes are encrypted end-to-end, and that a MISSING cipher
 * fails LOUDLY (a terminal error, never silent plaintext).
 *
 * - A handler RETURNS a success struct with a `sensitive` field. The server's OUTPUT
 *   serde encrypts that field, so the RAW ingress HTTP response body holds base64
 *   CIPHERTEXT (not the plaintext) — verified by a raw fetch + a decrypt round-trip
 *   with the same key.
 * - Served WITHOUT a `RestateRedaction` cipher, the same handler's output encode
 *   throws `RedactionCipherMissingError` → the invocation FAILS terminally (loud),
 *   never returning plaintext.
 */
import { it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { aesGcmCipher, aesGcmRedactionLayer, Restate, RestateService } from '../mod.ts'
import { RestateTestHarness, serverAvailable } from '../testing/testing.ts'

const KEY = new Uint8Array(32).fill(7)
const PLAINTEXT = 'launch-codes-42'

/* The success carries a `sensitive` field: the server encrypts it on the way out. */
const Secret = Schema.Struct({
  label: Schema.String,
  token: Restate.sensitive(Schema.String),
})

const Vault = RestateService.contract('redact-vault', {
  reveal: { input: Schema.Void, success: Secret },
})

const VaultLive = RestateService.implement<typeof Vault>(Vault, {
  reveal: () => Effect.succeed({ label: 'plain', token: PLAINTEXT }),
})

/* ── descriptor peer-call redaction: a `sensitive` field on the DESCRIPTOR call path
 * (inside `Restate.all`) must thread the same cipher the direct `callRpc` path does
 * (decision 0020). The bug built the descriptor's serde with NO cipher, so a sensitive
 * field threw `RedactionCipherMissingError` when issued inside a combinator. ──────── */

const DESC_SECRET = 'descriptor-secret-99'
const SecretIO = Schema.Struct({ value: Restate.sensitive(Schema.String) })

/* The callee echoes a `sensitive` field in BOTH its input and output. */
const DescEcho = RestateService.contract('redact-desc-echo', {
  echo: { input: SecretIO, success: SecretIO },
})
const DescEchoLive = RestateService.implement<typeof DescEcho>(DescEcho, {
  echo: ({ value }) => Effect.succeed({ value }),
})

/* The caller issues the peer call as a DESCRIPTOR inside `Restate.all` (the path that
 * dropped the cipher) and returns the round-tripped value as a NON-sensitive success
 * — so the assertion needs no ingress-side decryption. Under the bug the descriptor's
 * serde had no cipher, so encoding the sensitive `value` threw → the caller failed. */
const DescCaller = RestateService.contract('redact-desc-caller', {
  start: { input: Schema.Void, success: Schema.String },
})
const DescCallerLive = RestateService.implement<typeof DescCaller>(DescCaller, {
  start: () =>
    Effect.gen(function* () {
      const [echoed] = yield* Restate.all([
        Restate.callDescriptor(DescEcho, 'echo', { value: DESC_SECRET }),
      ])
      return echoed.value
    }),
})

/**
 * A RAW ingress POST that returns the UNPARSED JSON response body (the wire bytes).
 * The handler input is `Schema.Void`, so the server requires an EMPTY body AND no
 * `content-type` (a void payload is encoded as zero bytes); `accept: application/json`
 * gets the JSON response form.
 */
const rawIngressBody = (ingressUrl: string, service: string, handler: string): Promise<string> =>
  fetch(`${ingressUrl}/${service}/${handler}`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  }).then((res) => res.text())

describe.skipIf(!serverAvailable)('sensitive-field redaction on the wire (real server)', () => {
  it.layer(
    RestateTestHarness.layer({
      services: [VaultLive],
      appLayer: aesGcmRedactionLayer(KEY),
      disableRetries: true,
    }),
    { timeout: 90_000 },
  )('cipher present', (it) => {
    it.effect('the transported sensitive field is CIPHERTEXT and decrypts back', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const body = yield* Effect.promise(() =>
          rawIngressBody(harness.ingressUrl, 'redact-vault', 'reveal'),
        )
        const wire = JSON.parse(body) as { label: string; token: string }

        /* Non-sensitive field plaintext; sensitive field is NOT the plaintext. */
        expect(wire.label).toBe('plain')
        expect(wire.token).not.toBe(PLAINTEXT)
        expect(body).not.toContain(PLAINTEXT)

        /* The ciphertext decrypts back to the plaintext with the same key — so it is
         * genuine encryption, not just an opaque mangling. */
        const cipher = aesGcmCipher(KEY)
        const decrypted = new TextDecoder().decode(
          cipher.decrypt(Buffer.from(wire.token, 'base64')),
        )
        expect(JSON.parse(decrypted)).toBe(PLAINTEXT)
      }),
    )
  })

  it.layer(
    RestateTestHarness.layer({
      /* NO `RestateRedaction` in the app layer — a sensitive field must fail LOUDLY. */
      services: [VaultLive],
      appLayer: Layer.empty,
      disableRetries: true,
    }),
    { timeout: 90_000 },
  )('cipher missing', (it) => {
    it.effect('a missing cipher FAILS the invocation (never silent plaintext)', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const body = yield* Effect.promise(() =>
          rawIngressBody(harness.ingressUrl, 'redact-vault', 'reveal'),
        )
        /* The output encode throws `RedactionCipherMissingError` → a terminal error;
         * the plaintext is NEVER on the wire. */
        expect(body).not.toContain(PLAINTEXT)
        expect(body.toLowerCase()).toMatch(/redaction|cipher|error/)
      }),
    )
  })

  it.layer(
    RestateTestHarness.layer({
      services: [DescEchoLive, DescCallerLive],
      appLayer: aesGcmRedactionLayer(KEY),
      disableRetries: true,
    }),
    { timeout: 90_000 },
  )('descriptor peer call (sensitive field)', (it) => {
    it.effect(
      'a descriptor call inside Restate.all threads the cipher (round-trips, no missing-cipher error)',
      () =>
        Effect.gen(function* () {
          const harness = yield* RestateTestHarness
          /* Under the bug the descriptor serde had no cipher → `RedactionCipherMissingError`
           * → the caller fails. Post-fix the cipher is resolved at issue time and the
           * sensitive field round-trips on the s2s wire. */
          const result = yield* harness.ingress.call(DescCaller, 'start', undefined)
          expect(result).toBe(DESC_SECRET)
        }),
    )
  })
})
