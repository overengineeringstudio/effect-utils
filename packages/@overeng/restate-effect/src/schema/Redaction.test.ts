import * as crypto from 'node:crypto'

import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { Restate } from './Annotations.ts'
import {
  aesGcmCipher,
  findSensitiveFields,
  type RedactionCipher,
  RedactionCipherMissingError,
} from './Redaction.ts'
import { effectSerde } from './Serde.ts'

/* A trivial reversible test cipher (XOR + a tag prefix) so the assertion is on
 * the redaction WIRING, not on AES specifics; the AES reference cipher is covered
 * separately below. */
const xorCipher = (): RedactionCipher => {
  const key = 0x5a
  const xor = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes, (b) => b ^ key)
  return { encrypt: xor, decrypt: xor }
}

const SecretMessage = Schema.Struct({
  /* `to` stays plaintext; `body` is redacted. */
  to: Schema.String,
  body: Restate.sensitive(Schema.String),
})

describe('field-level redaction (sensitive/redacted)', () => {
  it('finds sensitive fields off the pre-transform property signatures', () => {
    expect(findSensitiveFields(SecretMessage.ast)).toStrictEqual(['body'])
    expect(findSensitiveFields(Schema.Struct({ x: Schema.Number }).ast)).toStrictEqual([])
    /* `redacted` is an alias for `sensitive`. */
    const R = Schema.Struct({ pin: Restate.redacted(Schema.Number) })
    expect(findSensitiveFields(R.ast)).toStrictEqual(['pin'])
  })

  it('encodes CIPHERTEXT for the sensitive field and PLAINTEXT for others, and round-trips', () => {
    const cipher = xorCipher()
    const serde = effectSerde(SecretMessage, 'internal', { redaction: cipher })
    const value = { to: 'alice', body: 'launch codes' }

    const bytes = serde.serialize(value)
    const wire = JSON.parse(new TextDecoder().decode(bytes)) as { to: string; body: string }

    /* Non-sensitive field is plaintext on the wire. */
    expect(wire.to).toBe('alice')
    /* Sensitive field is ciphertext: NOT the plaintext, and decryptable back. */
    expect(wire.body).not.toBe('launch codes')
    expect(typeof wire.body).toBe('string')
    const decrypted = new TextDecoder().decode(cipher.decrypt(Buffer.from(wire.body, 'base64')))
    expect(JSON.parse(decrypted)).toBe('launch codes')

    /* Decode reverses the transform back to plaintext. */
    expect(serde.deserialize(bytes)).toStrictEqual(value)
  })

  it('fails with a CLEAR error when a sensitive field has no cipher (never plaintext)', () => {
    const serde = effectSerde(SecretMessage) // no redaction provided
    expect(() => serde.serialize({ to: 'alice', body: 'secret' })).toThrow(
      RedactionCipherMissingError,
    )
    expect(() => serde.serialize({ to: 'alice', body: 'secret' })).toThrow(/no RestateRedaction/)
  })

  it('leaves a schema with no sensitive field completely untouched', () => {
    const plain = Schema.Struct({ a: Schema.String })
    const serde = effectSerde(plain, 'internal', { redaction: xorCipher() })
    const value = { a: 'hello' }
    const wire = JSON.parse(new TextDecoder().decode(serde.serialize(value))) as { a: string }
    expect(wire.a).toBe('hello')
    expect(serde.deserialize(serde.serialize(value))).toStrictEqual(value)
  })
})

describe('aesGcmCipher reference (node:crypto)', () => {
  it('round-trips by VALUE with a fresh IV per encrypt (ciphertext differs each time)', () => {
    const key = crypto.randomBytes(32)
    const cipher = aesGcmCipher(key)
    const plaintext = new TextEncoder().encode('top secret')
    const a = cipher.encrypt(plaintext)
    const b = cipher.encrypt(plaintext)
    /* Semantic security: same plaintext → different ciphertext bytes. */
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
    expect(new TextDecoder().decode(cipher.decrypt(a))).toBe('top secret')
    expect(new TextDecoder().decode(cipher.decrypt(b))).toBe('top secret')
  })

  it('rejects a wrong-length key', () => {
    expect(() => aesGcmCipher(crypto.randomBytes(16))).toThrow(/32 bytes/)
  })

  it('end-to-end: AES-GCM redacted field is ciphertext on the wire and decodes back', () => {
    const cipher = aesGcmCipher(crypto.randomBytes(32))
    const serde = effectSerde(SecretMessage, 'internal', { redaction: cipher })
    const value = { to: 'bob', body: 'classified' }
    const wire = JSON.parse(new TextDecoder().decode(serde.serialize(value))) as {
      to: string
      body: string
    }
    expect(wire.to).toBe('bob')
    expect(wire.body).not.toContain('classified')
    expect(serde.deserialize(serde.serialize(value))).toStrictEqual(value)
  })
})
