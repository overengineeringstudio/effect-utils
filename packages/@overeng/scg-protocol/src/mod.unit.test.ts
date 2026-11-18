import { createPrivateKey, createPublicKey } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  canonical,
  decodeJson,
  Decision,
  digest,
  Pending,
  signPayload,
  signingBytes,
  verifyPayload,
} from './mod.ts'
import {
  canonicalVectors,
  decisionVector,
  testEd25519PublicKey,
  testEd25519Seed,
} from './vectors.ts'

const privateKey = createPrivateKey({
  key: Buffer.from(`302e020100300506032b657004220420${testEd25519Seed}`, 'hex'),
  format: 'der',
  type: 'pkcs8',
})
const publicKey = createPublicKey({
  key: Buffer.from(`302a300506032b6570032100${testEd25519PublicKey}`, 'hex'),
  format: 'der',
  type: 'spki',
})
const pending = {
  epoch: 'scg-experiment-v1',
  kind: 'pending',
  executionId: '00000000-0000-4000-8000-000000000001',
  requestDigest: digest('request'),
  actionDigest: digest('action'),
  review: {
    command: 'example.read',
    account: 'example',
    sensitivity: 'low',
    fields: [],
    agentClaim: 'Unverified',
  },
  options: [
    { optionId: 'allow-once', kind: 'allow-once', statement: 'Allow this exact action once.' },
    { optionId: 'deny', kind: 'deny', statement: 'Deny this exact action.' },
  ],
  issuedAt: 1795039200000,
  expiresAt: 1795039260000,
} as const

describe('shared canonical and Ed25519 protocol vectors', () => {
  it.each(canonicalVectors)('preserves Unicode and sorted UTF-16 keys', ({ value, expected }) => {
    expect(canonical(value)).toBe(expected)
  })
  it('matches the shared deterministic Ed25519 decision vector byte-for-byte', () => {
    const vector = signPayload('decision', decisionVector.payload, decisionVector.keyId, privateKey)
    expect(vector.signature).toBe(decisionVector.signature)
    expect(
      new TextDecoder().decode(
        signingBytes('decision', decisionVector.payload, decisionVector.keyId),
      ),
    ).toBe(decisionVector.signingText)
    expect(digest(decisionVector.payload)).toBe(decisionVector.digest)
    expect(verifyPayload('decision', vector, publicKey)).toBe(true)
  })
  it('binds entire pending, selected option, key, domain and epoch', () => {
    const payload = decodeJson(
      Decision,
      canonical({
        epoch: 'scg-experiment-v1',
        kind: 'decision',
        executionId: pending.executionId,
        pendingDigest: digest(pending),
        optionId: 'allow-once',
        surfaceId: 'test',
        principalId: 'owner',
        decidedAt: pending.issuedAt,
      }),
    )
    const signed = signPayload('decision', payload, 'test-key', privateKey)
    expect(verifyPayload('decision', signed, publicKey)).toBe(true)
    expect(verifyPayload('pending', signed, publicKey)).toBe(false)
    expect(verifyPayload('decision', { ...signed, keyId: 'other' }, publicKey)).toBe(false)
    expect(
      verifyPayload(
        'decision',
        { ...signed, payload: { ...payload, optionId: 'deny' } },
        publicKey,
      ),
    ).toBe(false)
    expect(
      digest({ ...pending, review: { ...pending.review, agentClaim: 'Changed reason' } }),
    ).not.toBe(payload.pendingDigest)
    expect(() =>
      decodeJson(Decision, canonical({ ...payload, epoch: 'scg-authority-v1' })),
    ).toThrow()
  })
  it('rejects duplicate escaped properties, unknown fields, times and unsupported canonical values', () => {
    expect(() => decodeJson(Decision, '{"optionId":"allow-once","option\\u0049d":"deny"}')).toThrow(
      'Duplicate JSON property',
    )
    expect(() => decodeJson(Pending, canonical({ ...pending, approved: true }))).toThrow()
    expect(() => decodeJson(Pending, canonical({ ...pending, expiresAt: 1.5 }))).toThrow()
    for (const value of [undefined, NaN, Infinity, new Date(), { invalid: undefined }])
      expect(() => canonical(value)).toThrow()
  })
  it('limits frozen manifests to ten items and includes signed statement text', () => {
    const item = {
      executionId: pending.executionId,
      actionDigest: pending.actionDigest,
      review: pending.review,
    }
    expect(() =>
      decodeJson(
        Pending,
        canonical({
          ...pending,
          options: [
            {
              kind: 'manifest-approve',
              optionId: 'manifest',
              statement: 'Allow exact manifest',
              items: Array.from({ length: 11 }, () => item),
            },
          ],
        }),
      ),
    ).toThrow()
    expect(() =>
      decodeJson(
        Pending,
        canonical({ ...pending, options: [{ kind: 'allow-once', optionId: 'allow-once' }] }),
      ),
    ).toThrow()
  })
})
