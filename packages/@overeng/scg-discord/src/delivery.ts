import { Effect, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'

import type { DiscordMessage } from './card.ts'
import { DiscordError, type DiscordDelivery } from './signer.ts'
import type { Card } from './store.ts'

const Posted = Schema.Struct({ id: Schema.NonEmptyString, channel_id: Schema.NonEmptyString })
export const makeDiscordDelivery = Effect.fn('scg.discord.delivery')(function* (
  token: Redacted.Redacted<string>,
) {
  const client = yield* HttpClient.HttpClient
  const request = Effect.fn('scg.discord.rest')(function* (
    method: 'POST' | 'PATCH',
    path: string,
    message: DiscordMessage,
    botAuth: boolean,
  ) {
    const base = HttpClientRequest.make(method)(`https://discord.com/api/v10${path}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(message),
    )
    const req = botAuth
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
    post: (channelId: string, message: DiscordMessage) =>
      request('POST', `/channels/${encodeURIComponent(channelId)}/messages`, message, true).pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Posted)),
        Effect.mapError((cause) => new DiscordError({ operation: 'post-message', cause })),
      ),
    edit: (card: Card, message: DiscordMessage) =>
      request(
        'PATCH',
        `/channels/${encodeURIComponent(card.channelId)}/messages/${encodeURIComponent(card.messageId)}`,
        message,
        true,
      ).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new DiscordError({ operation: 'edit-message', cause })),
      ),
    ephemeral: (applicationId: string, interactionToken: string, message: DiscordMessage) =>
      request(
        'POST',
        `/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}`,
        message,
        false,
      ).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new DiscordError({ operation: 'ephemeral-message', cause })),
      ),
  } satisfies DiscordDelivery & {
    readonly post: (
      channelId: string,
      message: DiscordMessage,
    ) => Effect.Effect<typeof Posted.Type, DiscordError>
  }
})
