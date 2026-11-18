import { generateKeyPairSync, sign } from 'node:crypto'

import { it } from '@effect/vitest'
import { Effect, Exit, Schema } from 'effect'
import { expect } from 'vitest'

import { discordPublicKey, verifyInteraction } from './interaction.ts'

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const discord = generateKeyPairSync('ed25519')
const stranger = generateKeyPairSync('ed25519')
const nowMs = 1_800_000_000_000
const timestamp = String(nowMs / 1000)
const body = Buffer.from(
  JSON.stringify({
    id: 'interaction',
    application_id: 'test-app',
    token: 'synthetic-token',
    type: 3,
    user: { id: 'owner' },
    data: { custom_id: 'opaque' },
  }),
)
const signature = sign(
  null,
  Buffer.concat([Buffer.from(timestamp), body]),
  discord.privateKey,
).toString('hex')
const input = {
  body,
  timestamp,
  signature,
  publicKey: discord.publicKey,
  applicationId: 'test-app',
  allowedUserIds: new Set(['owner']),
  nowMs,
}

it.effect('verifies exact signed bytes with a locally generated Discord Ed25519 key', () =>
  Effect.gen(function* () {
    const raw = discord.publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(-32)
      .toString('hex')
    const value = yield* verifyInteraction({ ...input, publicKey: discordPublicKey(raw) })
    expect(value.id).toBe('interaction')
  }),
)

for (const [name, changed] of [
  ['body forgery', { body: Buffer.from(body.toString().replace('owner', 'other')) }],
  ['wrong Discord key', { publicKey: stranger.publicKey }],
  ['stale timestamp', { nowMs: nowMs + 300_001 }],
  ['future timestamp', { nowMs: nowMs - 300_001 }],
  ['unsigned timestamp change', { timestamp: String(Number(timestamp) + 1) }],
  ['bad timestamp syntax', { timestamp: `${timestamp}.0` }],
  ['wrong application', { applicationId: 'other-app' }],
  ['non-allowlisted human', { allowedUserIds: new Set(['other']) }],
  ['missing signature', { signature: undefined }],
] as const) {
  it.effect(`rejects ${name}`, () =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* Effect.exit(verifyInteraction({ ...input, ...changed })))).toBe(
        true,
      )
    }),
  )
}

it.effect('accepts signed PING without a user but never bypasses signature validation', () =>
  Effect.gen(function* () {
    const ping = Buffer.from(
      encodeJson({ id: 'ping', application_id: 'test-app', token: 'ping-token', type: 1 }),
    )
    const signed = sign(
      null,
      Buffer.concat([Buffer.from(timestamp), ping]),
      discord.privateKey,
    ).toString('hex')
    expect((yield* verifyInteraction({ ...input, body: ping, signature: signed })).type).toBe(1)
    expect(Exit.isFailure(yield* Effect.exit(verifyInteraction({ ...input, body: ping })))).toBe(
      true,
    )
  }),
)
