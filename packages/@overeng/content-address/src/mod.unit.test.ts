import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  ContentDescriptorMismatchError,
  descriptorForCanonicalJson,
  descriptorForUtf8,
  hashCanonicalJson,
  objectPathForDigest,
  utf8Bytes,
  verifyDescriptor,
} from './mod.ts'

const Payload = Schema.Struct({
  alpha: Schema.String,
  nested: Schema.Struct({
    zed: Schema.Number,
    beta: Schema.Array(Schema.String),
  }),
}).annotations({ identifier: 'ContentAddressTest.Payload' })

describe('@overeng/content-address', () => {
  it('hashes canonical JSON independent of object key insertion order', () => {
    const left = Payload.make({ alpha: 'a', nested: { zed: 1, beta: ['b'] } })
    const right = { nested: { beta: ['b'], zed: 1 }, alpha: 'a' }

    expect(hashCanonicalJson(Payload, left)).toBe(hashCanonicalJson(Payload, right))
  })

  it('describes canonical JSON with descriptor metadata', () => {
    const descriptor = descriptorForCanonicalJson({
      schema: Payload,
      value: Payload.make({ alpha: 'a', nested: { zed: 1, beta: ['b'] } }),
      schemaVersion: 1,
    })

    expect(descriptor).toMatchObject({
      _tag: 'ContentDescriptor',
      mediaType: 'application/json',
      codec: 'canonical-json',
      schemaVersion: 1,
    })
    expect(descriptor.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(descriptor.byteLength).toBeGreaterThan(0)
  })

  it('verifies matching bytes and fails closed on mismatches', async () => {
    const descriptor = descriptorForUtf8({ value: 'hello' })

    await expect(
      Effect.runPromise(verifyDescriptor({ descriptor, bytes: utf8Bytes('hello') })),
    ).resolves.toBeUndefined()
    const mismatch = await Effect.runPromise(
      verifyDescriptor({ descriptor, bytes: utf8Bytes('HELLO') }).pipe(Effect.either),
    )
    expect(mismatch._tag).toBe('Left')
    if (mismatch._tag === 'Left') {
      expect(mismatch.left).toBeInstanceOf(ContentDescriptorMismatchError)
    }
  })

  it('derives a stable object path segment from a digest', () => {
    expect(objectPathForDigest(`sha256:${'a'.repeat(64)}`)).toBe(`sha256/aa/${'a'.repeat(62)}`)
  })
})
