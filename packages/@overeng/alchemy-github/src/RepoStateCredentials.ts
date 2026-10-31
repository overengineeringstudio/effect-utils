import {
  Cause,
  Clock,
  Config,
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Layer,
  Redacted,
  Schema,
} from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

/** Deliberately excludes upstream causes, URLs, response bodies and credentials. */
export class RepoStateError extends Schema.TaggedError<RepoStateError>()('RepoStateError', {
  operation: Schema.String,
}) {}

const secret = Schema.RedactedFromValue(Schema.NonEmptyString, { disallowEncode: true })

/** Broker wire response; decoding immediately wraps all credential material. */
export const RepoStateCredential = Schema.Struct({
  accessKeyId: secret,
  secretAccessKey: secret,
  sessionToken: secret,
  endpoint: Schema.String.check(Schema.isPattern(/^https:\/\/[^/?#@]+\/?$/)),
  bucket: Schema.NonEmptyString,
  prefix: Schema.String.check(
    Schema.isPattern(/^alchemy\/v1\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/$/),
    Schema.makeFilter((value) =>
      value.split('/').every((segment) => segment !== '.' && segment !== '..'),
    ),
  ),
  expiresAt: Schema.String.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
}).annotate({ identifier: 'RepoState.Credential' })
export type RepoStateCredential = typeof RepoStateCredential.Type

/** Refreshable, repository-scoped credentials; callers never retain a static signing session. */
export class RepoStateCredentials extends Context.Service<
  RepoStateCredentials,
  { readonly get: Effect.Effect<RepoStateCredential, RepoStateError> }
>()('@overeng/alchemy-github/RepoStateCredentials') {}

const sanitize =
  (operation: string) =>
  <TValue, TError, TContext>(
    effect: Effect.Effect<TValue, TError, TContext>,
  ): Effect.Effect<TValue, RepoStateError, TContext> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) === true
          ? Effect.interrupt
          : Effect.fail(new RepoStateError({ operation })),
      ),
    )

const oidcResponse = Schema.Struct({ value: secret })
const refreshAheadMilliseconds = 60_000

/** Actions OIDC → explicit broker → short-lived repository-scoped object-store credentials. */
export const githubActionsOidc = ({
  brokerUrl,
}: {
  readonly brokerUrl: string
}): Layer.Layer<RepoStateCredentials, never, HttpClient.HttpClient> =>
  Layer.effect(
    RepoStateCredentials,
    Effect.gen(function* () {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const configProvider = yield* ConfigProvider.ConfigProvider
      const acquire = Effect.gen(function* () {
        const configuration = yield* Effect.all({
          url: Config.String('ACTIONS_ID_TOKEN_REQUEST_URL'),
          token: Config.Redacted('ACTIONS_ID_TOKEN_REQUEST_TOKEN'),
        }).pipe(sanitize('actions-oidc-configuration'))

        // Fetch must not replay bearer/JWT requests at a redirect target. Injected
        // clients must also omit redirect-following and request/body logging middleware.
        const oidc = yield* Effect.gen(function* () {
          const response = yield* client.execute(
            HttpClientRequest.get(configuration.url).pipe(
              HttpClientRequest.setUrlParam('audience', brokerUrl),
              HttpClientRequest.setHeader(
                'authorization',
                `Bearer ${Redacted.value(configuration.token)}`,
              ),
            ),
          )
          return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(oidcResponse)))
        }).pipe(sanitize('actions-oidc-token'))

        const credential = yield* Effect.gen(function* () {
          const request = yield* HttpClientRequest.post(brokerUrl).pipe(
            HttpClientRequest.bodyJson({ token: Redacted.value(oidc.value) }),
          )
          const response = yield* client.execute(request)
          return yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(RepoStateCredential)),
          )
        }).pipe(sanitize('broker-exchange'))

        const now = yield* Clock.currentTimeMillis
        const timeToLive = Date.parse(credential.expiresAt) - now - refreshAheadMilliseconds
        if (timeToLive <= 0)
          return yield* new RepoStateError({ operation: 'credential-expiration' })
        return { credential, timeToLive }
      }).pipe(
        // HTTP errors retain requests (including bearer headers and JWT bodies). Suppress
        // transport spans and propagation before sanitizing any error or defect.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.withTracerEnabled(false),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
        sanitize('credential-acquisition'),
      )
      const cached = yield* Effect.cachedWithTTL(acquire, (exit) =>
        Exit.isSuccess(exit) === true ? exit.value.timeToLive : 0,
      )
      return {
        get: cached.pipe(Effect.map(({ credential }) => credential)),
      }
    }),
  )
