import { Effect, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'

import type { DiscordMessage } from './card.ts'
import { DiscordError, type DiscordDelivery } from './signer.ts'

const Posted = Schema.Struct({ id: Schema.NonEmptyString, channel_id: Schema.NonEmptyString })
/** Builds authenticated Discord REST delivery without exposing the bot token to callers. */
export const makeDiscordDelivery = Effect.fn('scg.discord.delivery')(function* (
  token: Redacted.Redacted<string>,
) {
  const client = yield* HttpClient.HttpClient
  const request = Effect.fn('scg.discord.rest')(function* ({
    method,
    path,
    message,
    botAuth,
  }: {
    readonly method: 'POST' | 'PATCH'
    readonly path: string
    readonly message: DiscordMessage
    readonly botAuth: boolean
  }) {
    const base = HttpClientRequest.make(method)(`https://discord.com/api/v10${path}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(message),
    )
    const req =
      botAuth === true
        ? HttpClientRequest.setHeader('authorization', `Bot ${Redacted.value(token)}`)(base)
        : base
    const response = yield* client.execute(req)
    if (response.status < 200 || response.status >= 300) {
      return yield* new DiscordError({
        operation: 'discord-response',
        cause: { status: response.status },
      })
    }
    return response
  })
  return {
    post: ({ channelId, message }) =>
      request({
        method: 'POST',
        path: `/channels/${encodeURIComponent(channelId)}/messages`,
        message,
        botAuth: true,
      }).pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Posted)),
        Effect.mapError((cause) => new DiscordError({ operation: 'post-message', cause })),
      ),
    edit: ({ card, message }) =>
      request({
        method: 'PATCH',
        path: `/channels/${encodeURIComponent(card.channelId)}/messages/${encodeURIComponent(card.messageId)}`,
        message,
        botAuth: true,
      }).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new DiscordError({ operation: 'edit-message', cause })),
      ),
    ephemeral: ({ applicationId, token: interactionToken, message }) =>
      request({
        method: 'POST',
        path: `/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}`,
        message,
        botAuth: false,
      }).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new DiscordError({ operation: 'ephemeral-message', cause })),
      ),
  } satisfies DiscordDelivery
})
