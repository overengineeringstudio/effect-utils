import { randomUUID, type KeyObject } from 'node:crypto'

import { Effect, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'

import {
  SignedPending,
  Status,
  Sync,
  digest,
  signPayload,
  routes,
  type SignedDecision,
} from '@overeng/scg-protocol'

import { DiscordError, type AuthorityClient } from './signer.ts'

/** Use an independently configured HTTPS authority endpoint; redirects are not trusted. */
export const makeAuthorityClient = Effect.fn('scg.discord.authorityClient')(function* (config: {
  readonly baseUrl: string
  readonly keyId: string
  readonly privateKey: KeyObject
}) {
  const base = new URL(config.baseUrl)
  if (
    base.protocol !== 'https:' ||
    base.username !== '' ||
    base.password !== '' ||
    base.search !== '' ||
    base.hash !== ''
  ) {
    return yield* new DiscordError({
      operation: 'authority-endpoint',
      cause: 'Expected a credential-free HTTPS authority URL',
    })
  }
  const client = yield* HttpClient.HttpClient
  const request = Effect.fn('scg.discord.authorityRequest')(function* <
    TSchema extends Schema.ConstraintDecoder<unknown>,
  >({
    method,
    path,
    body,
    schema,
  }: {
    readonly method: 'GET' | 'POST'
    readonly path: string
    readonly body: SignedDecision | undefined
    readonly schema: TSchema
  }) {
    const auth = signPayload({
      domain: 'auth-request',
      payload: {
        epoch: 'scg-experiment-v1',
        method,
        path,
        bodyDigest: digest(body ?? null),
        nonce: randomUUID(),
        issuedAt: Date.now(),
      },
      keyId: config.keyId,
      key: config.privateKey,
    })
    const baseRequest = HttpClientRequest.make(method)(new URL(path, base)).pipe(
      HttpClientRequest.setHeader('x-scg-auth', encodeJson(auth)),
    )
    const req =
      body === undefined ? baseRequest : HttpClientRequest.bodyJsonUnsafe(body)(baseRequest)
    const response = yield* client.execute(req)
    if (response.status < 200 || response.status >= 300) {
      return yield* new DiscordError({
        operation: 'authority-response',
        cause: { status: response.status },
      })
    }
    return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))
  })
  return {
    pending: (executionId: string) =>
      wrap(
        request({
          method: 'GET',
          path: `${routes.pending}${encodeURIComponent(executionId)}`,
          body: undefined,
          schema: SignedPending,
        }),
      ),
    status: (executionId: string) =>
      wrap(
        request({
          method: 'GET',
          path: `${routes.status}${encodeURIComponent(executionId)}`,
          body: undefined,
          schema: Status,
        }),
      ),
    decide: (decision: SignedDecision) =>
      wrap(request({ method: 'POST', path: routes.decision, body: decision, schema: Status })),
    sync: (cursor: number) =>
      wrap(
        request({
          method: 'GET',
          path: `${routes.sync}?cursor=${cursor}`,
          body: undefined,
          schema: Sync,
        }),
      ),
  } satisfies AuthorityClient & {
    readonly sync: (cursor: number) => Effect.Effect<Sync, DiscordError>
  }
})
const wrap = <T, E, R>(effect: Effect.Effect<T, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new DiscordError({ operation: 'authority-request', cause })),
  )

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
