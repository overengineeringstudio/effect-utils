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
})
