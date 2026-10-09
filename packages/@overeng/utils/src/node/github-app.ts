import { createPrivateKey, createSign } from 'node:crypto'

import { Clock, Context, Effect, Layer, Redacted, Schema, Semaphore } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import type { HttpClientError } from 'effect/http/HttpClientError'

const PositiveID = Schema.Int.check(Schema.isGreaterThan(0))
export const AppIdentity = Schema.Struct({
  clientID: Schema.NonEmptyString,
}).annotate({ identifier: 'GitHubApp.Identity' })
export const AppConfig = Schema.Struct({
  identity: AppIdentity,
  privateKey: Schema.Redacted(Schema.NonEmptyString),
}).annotate({ identifier: 'GitHubApp.Config' })

/** Both fields are mandatory: omission must never mint the installation's full authority. */
export const InstallationScope = Schema.Struct({
  installationID: PositiveID,
  repositories: Schema.NonEmptyArray(Schema.NonEmptyString),
  permissions: Schema.Record(Schema.NonEmptyString, Schema.Literals(['read', 'write'])),
}).check(Schema.makeFilter((scope) => Object.keys(scope.permissions).length > 0))
  .annotate({ identifier: 'GitHubApp.InstallationScope' })
export type InstallationScope = typeof InstallationScope.Type

export class GitHubAppError extends Schema.TaggedError<GitHubAppError>()('GitHubAppError', {
  operation: Schema.Literals(['config', 'sign', 'exchange', 'authorize']),
  message: Schema.String,
  status: Schema.optional(Schema.Int),
}) {}

const TokenResponse = Schema.Struct({
  token: Schema.RedactedFromValue(Schema.NonEmptyString),
  expires_at: Schema.DateFromString,
})
const JwtHeader = Schema.Struct({ alg: Schema.Literal('RS256'), typ: Schema.Literal('JWT') })
const JwtClaims = Schema.Struct({ iat: Schema.Int, exp: Schema.Int, iss: Schema.NonEmptyString })
const encodeHeader = Schema.encodeSync(Schema.fromJsonString(JwtHeader))
const encodeClaims = Schema.encodeSync(Schema.fromJsonString(JwtClaims))
const encodeScope = Schema.encodeSync(Schema.fromJsonString(InstallationScope))

/** Scoped typed HttpClient; deliberately distinct from the unauthenticated transport dependency. */
export class GitHubAppHttpClient extends Context.Service<
  GitHubAppHttpClient,
  HttpClient.HttpClient.With<GitHubAppError | HttpClientError>
>()('@overeng/utils/GitHubAppHttpClient') {}

export interface GitHubAppService {
  readonly token: (scope: InstallationScope) => Effect.Effect<Redacted.Redacted<string>, GitHubAppError>
  readonly client: (scope: InstallationScope) => HttpClient.HttpClient.With<GitHubAppError | HttpClientError>
}

export const makeGitHubApp = Effect.fn('github-app.make')(function* (
  input: typeof AppConfig.Type,
  options: { readonly apiBase?: URL; readonly userAgent?: string } = {},
) {
  const config = yield* Schema.decodeUnknownEffect(AppConfig)(input).pipe(
    Effect.mapError(() => new GitHubAppError({ operation: 'config', message: 'Invalid GitHub App config' })),
  )
  // Parse once. Never attach the PEM or crypto exception to an error/log/span.
  const key = yield* Effect.try({
    try: () => createPrivateKey(Redacted.value(config.privateKey)),
    catch: () => new GitHubAppError({ operation: 'sign', message: 'Invalid GitHub App RSA private key' }),
  })
  if (key.asymmetricKeyType !== 'rsa') {
    return yield* new GitHubAppError({ operation: 'sign', message: 'GitHub App requires an RSA private key' })
  }
  const raw = yield* HttpClient.HttpClient
  const apiBase = options.apiBase ?? new URL('https://api.github.com')
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': options.userAgent ?? 'overeng-github-app/0.1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const lock = yield* Semaphore.make(1)
  const tokens = new Map<string, { readonly token: Redacted.Redacted<string>; readonly expiresAt: number }>()

  const token = Effect.fn('github-app.token')(function* (inputScope: InstallationScope) {
    const scope = yield* Schema.decodeUnknownEffect(InstallationScope)(inputScope).pipe(
      Effect.mapError(() => new GitHubAppError({ operation: 'config', message: 'Invalid installation scope' })),
    )
    const canonical = {
      ...scope,
      repositories: [...new Set(scope.repositories)].sort(),
      permissions: Object.fromEntries(Object.entries(scope.permissions).sort(([a], [b]) => a.localeCompare(b))),
    }
    const normalized = yield* Schema.decodeUnknownEffect(InstallationScope)(canonical).pipe(
      Effect.mapError(() => new GitHubAppError({ operation: 'config', message: 'Invalid normalized scope' })),
    )
    const cacheKey = encodeScope(normalized)
    return yield* lock.withPermits(1)(Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const cached = tokens.get(cacheKey)
      if (cached !== undefined && cached.expiresAt - now > 60_000) return cached.token
      const jwt = yield* Effect.try({
        try: () => {
          const unsigned = `${Buffer.from(encodeHeader({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(encodeClaims({
            iat: Math.floor(now / 1000) - 60,
            exp: Math.floor(now / 1000) + 540,
            iss: config.identity.clientID,
          })).toString('base64url')}`
          return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).end().sign(key).toString('base64url')}`
        },
        catch: () => new GitHubAppError({ operation: 'sign', message: 'Failed to sign GitHub App JWT' }),
      })
      const request = HttpClientRequest.post(new URL(`/app/installations/${scope.installationID}/access_tokens`, apiBase)).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bearerToken(jwt),
        HttpClientRequest.bodyText(Schema.encodeSync(Schema.fromJsonString(Schema.Struct({
          repositories: Schema.Array(Schema.NonEmptyString),
          permissions: Schema.Record(Schema.NonEmptyString, Schema.Literals(['read', 'write'])),
        })))(canonical), 'application/json'),
      )
      const response = yield* raw.execute(request).pipe(
        Effect.mapError(() => new GitHubAppError({ operation: 'exchange', message: 'Installation token transport failed' })),
      )
      if (response.status !== 201) return yield* new GitHubAppError({
        operation: 'exchange', status: response.status, message: 'GitHub rejected installation token exchange',
      })
      const value = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
        Effect.mapError(() => new GitHubAppError({ operation: 'exchange', message: 'Invalid installation token response' })),
      )
      if (value.expires_at.getTime() - now <= 60_000) return yield* new GitHubAppError({
        operation: 'exchange', message: 'Installation token expires inside refresh window',
      })
      tokens.set(cacheKey, { token: value.token, expiresAt: value.expires_at.getTime() })
      return value.token
    }))
  })

  const invalidate = (rejected: Redacted.Redacted<string>) =>
    Effect.sync(() => {
      // Compare token values: a late 401 must not evict a newer token minted by another fiber.
      for (const [key, entry] of tokens) {
        if (Redacted.value(entry.token) === Redacted.value(rejected)) tokens.delete(key)
      }
    })

  const client = (scope: InstallationScope): HttpClient.HttpClient.With<GitHubAppError | HttpClientError> =>
    HttpClient.makeWith<never, never, GitHubAppError | HttpClientError, never>(
      (requestEffect) => Effect.gen(function* () {
        const request = yield* requestEffect
        const url = yield* Effect.try({
          try: () => new URL(request.url),
          catch: () => new GitHubAppError({ operation: 'authorize', message: 'Authenticated GitHub request requires an absolute URL' }),
        })
        if (url.origin !== apiBase.origin) return yield* new GitHubAppError({
          operation: 'authorize', message: 'Refusing to send GitHub installation token to another origin',
        })
        const credential = yield* token(scope)
        const response = yield* raw.execute(request.pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bearerToken(Redacted.value(credential)),
        ))
        if (response.status === 401) {
          yield* invalidate(credential)
          // Never transparently replay writes. The caller decides whether an operation is safe to retry.
          return yield* new GitHubAppError({ operation: 'authorize', status: 401, message: 'GitHub rejected installation token; cache invalidated' })
        }
        return response
      }),
      Effect.succeed,
    )
  return { token, client } as const
})

export class GitHubApp extends Context.Service<GitHubApp, GitHubAppService>()('@overeng/utils/GitHubApp') {
  static layer = (config: typeof AppConfig.Type, options?: { readonly apiBase?: URL; readonly userAgent?: string }) =>
    Layer.effect(this, makeGitHubApp(config, options))
}

export const installationHttpClientLayer = (scope: InstallationScope) =>
  Layer.effect(GitHubAppHttpClient, Effect.map(GitHubApp, (app) => app.client(scope)))
