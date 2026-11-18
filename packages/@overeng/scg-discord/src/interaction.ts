import { createPublicKey, verify, type KeyObject } from 'node:crypto'

import { Effect, Schema } from 'effect'

const User = Schema.Struct({ id: Schema.NonEmptyString })
export const Interaction = Schema.Struct({
  id: Schema.NonEmptyString,
  application_id: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  type: Schema.Literals([1, 3]),
  user: Schema.optionalKey(User),
  member: Schema.optionalKey(Schema.Struct({ user: User })),
  message: Schema.optionalKey(
    Schema.Struct({ id: Schema.NonEmptyString, channel_id: Schema.NonEmptyString }),
  ),
  data: Schema.optionalKey(Schema.Struct({ custom_id: Schema.NonEmptyString })),
})
export type Interaction = typeof Interaction.Type

export class InteractionError extends Schema.TaggedError<InteractionError>()('InteractionError', {
  reason: Schema.Literals([
    'signature',
    'timestamp',
    'body',
    'user',
    'application',
    'replay',
    'binding',
    'unavailable',
  ]),
}) {}

/** Discord supplies a raw 32-byte Ed25519 public key, not a PEM certificate. */
export const discordPublicKey = (hex: string): KeyObject => {
  if (!/^[a-f\d]{64}$/i.test(hex))
    throw new TypeError('Expected a 32-byte Discord Ed25519 public key')
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki',
  })
}

/** Verifies the exact received bytes; timestamp is signed along with the body. */
export const verifyInteraction = Effect.fn('scg.discord.verifyInteraction')(function* (input: {
  readonly body: Uint8Array
  readonly signature: string | undefined
  readonly timestamp: string | undefined
  readonly publicKey: KeyObject
  readonly applicationId: string
  readonly allowedUserIds: ReadonlySet<string>
  readonly nowMs: number
}) {
  const { timestamp, signature } = input
  if (input.body.byteLength > 65_536) return yield* new InteractionError({ reason: 'body' })
  if (
    timestamp === undefined ||
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(input.nowMs - Number(timestamp) * 1000) > 300_000
  ) {
    return yield* new InteractionError({ reason: 'timestamp' })
  }
  if (
    input.publicKey.asymmetricKeyType !== 'ed25519' ||
    signature === undefined ||
    !/^[a-f\d]{128}$/i.test(signature) ||
    !verify(
      null,
      Buffer.concat([Buffer.from(timestamp), input.body]),
      input.publicKey,
      Buffer.from(signature, 'hex'),
    )
  ) {
    return yield* new InteractionError({ reason: 'signature' })
  }
  const text = yield* Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(input.body),
    catch: () => new InteractionError({ reason: 'body' }),
  })
  const interaction = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Interaction))(
    text,
  ).pipe(Effect.mapError(() => new InteractionError({ reason: 'body' })))
  if (interaction.application_id !== input.applicationId)
    return yield* new InteractionError({ reason: 'application' })
  if (interaction.type !== 1) {
    const userId = interaction.member?.user.id ?? interaction.user?.id
    if (
      userId === undefined ||
      !input.allowedUserIds.has(userId) ||
      (interaction.member !== undefined &&
        interaction.user !== undefined &&
        interaction.member.user.id !== interaction.user.id)
    ) {
      return yield* new InteractionError({ reason: 'user' })
    }
  }
  return interaction
})
