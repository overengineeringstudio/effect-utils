import { createPrivateKey, createSign } from 'node:crypto'

import { Clock, Context, Effect, Layer, Metric, Redacted, Schema, Semaphore } from 'effect'
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

const RepositoryName = Schema.NonEmptyString.check(
  Schema.makeFilter((name) => name.trim().length > 0 && !name.includes('/')),
)
export const Repositories = Schema.Union([
  Schema.TaggedStruct('Selected', { names: Schema.NonEmptyArray(RepositoryName) }),
  Schema.TaggedStruct('AllInstallation', {}),
]).annotate({ identifier: 'GitHubApp.Repositories' })

/** Installation-wide access is an explicit read-only capability. */
export const InstallationScope = Schema.Struct({
  installationID: PositiveID,
  repositories: Repositories,
  permissions: Schema.Record(
    Schema.NonEmptyString.check(Schema.makeFilter((name) => name.trim().length > 0)),
    Schema.Literals(['read', 'write']),
  ),
}).check(Schema.makeFilter((scope) =>
  Object.keys(scope.permissions).length > 0 &&
  (scope.repositories._tag === 'Selected' || Object.values(scope.permissions).every((value) => value === 'read')),
)).annotate({ identifier: 'GitHubApp.InstallationScope' })
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

export interface GitHubAppOptions {
  /** Stable process/consumer identity, never a repository, request ID, or credential. */
  readonly consumer: string
  readonly apiBase?: URL
  readonly userAgent?: string
  readonly refreshMarginSeconds?: number
}

const mintCount = Metric.counter('github_app_mints_total', { description: 'Installation token mint attempts' })
const mintFailures = Metric.counter('github_app_mint_failures_total', { description: 'Failed installation token mint attempts' })
const tokenExpiry = Metric.gauge('github_app_token_expiry_seconds', { description: 'Earliest cached token expiry (Unix seconds); zero when invalidated', bigint: false })
const rateRemaining = Metric.gauge('github_app_rate_limit_remaining', { description: 'Last observed GitHub budget, separated by resource bucket', bigint: false })

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
  options: GitHubAppOptions,
) {
  const config = yield* Schema.decodeUnknownEffect(AppConfig)(input).pipe(
    Effect.mapError(() => new GitHubAppError({ operation: 'config', message: 'Invalid GitHub App config' })),
  )
  const consumer = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(options.consumer).pipe(
    Effect.mapError(() => new GitHubAppError({ operation: 'config', message: 'Consumer identity must be non-empty' })),
  )
  const refreshMarginSeconds = yield* Schema.decodeUnknownEffect(PositiveID)(options.refreshMarginSeconds ?? 60).pipe(
    Effect.mapError(() => new GitHubAppError({ operation: 'config', message: 'Refresh margin must be a positive integer in seconds' })),
  )
  yield* Effect.annotateCurrentSpan({ 'github.app.client_id': config.identity.clientID, 'github.consumer': consumer, 'span.label': consumer })
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
  const tokens = new Map<string, { readonly token: Redacted.Redacted<string>; readonly expiresAt: number; readonly installationID: number }>()
  const flights = new Map<string, Effect.Effect<Redacted.Redacted<string>, GitHubAppError>>()
  const attributes = (installationID: number) => ({
    'github.app.client_id': config.identity.clientID,
    'github.installation.id': String(installationID),
    'github.consumer': consumer,
  })
  const observeResponse = Effect.fn('github-app.rate-limit')(function* (
    installationID: number,
    responseHeaders: Readonly<Record<string, string | undefined>>,
  ) {
    yield* Effect.annotateCurrentSpan({ ...attributes(installationID), 'span.label': `${consumer} ${installationID}` })
    const remaining = responseHeaders['x-ratelimit-remaining']
    const resource = responseHeaders['x-ratelimit-resource']
    // GitHub's resources are a finite vocabulary; never use arbitrary response strings as labels.
    if (remaining !== undefined && resource !== undefined &&
      ['core', 'search', 'graphql', 'integration_manifest', 'code_search'].includes(resource)) {
      const value = Number(remaining)
      if (Number.isSafeInteger(value) && value >= 0) {
        yield* Metric.update(Metric.withAttributes(rateRemaining, { ...attributes(installationID), 'github.resource': resource }), value)
      }
    }
  })
  const observeExpiry = (installationID: number) => Effect.suspend(() => {
    const expiries = [...tokens.values()].filter((entry) => entry.installationID === installationID).map((entry) => entry.expiresAt)
    return Metric.update(Metric.withAttributes(tokenExpiry, attributes(installationID)), expiries.length === 0 ? 0 : Math.min(...expiries) / 1000)
  })

  const token = Effect.fn('github-app.token')(function* (inputScope: InstallationScope) {
    const scope = yield* Schema.decodeUnknownEffect(InstallationScope)(inputScope).pipe(
      Effect.mapError(() => new GitHubAppError({ operation: 'config', message: 'Invalid installation scope' })),
    )
    const canonical = {
      ...scope,
      repositories: scope.repositories._tag === 'Selected'
        ? { _tag: 'Selected' as const, names: [...new Set(scope.repositories.names)].sort() }
        : scope.repositories,
      permissions: Object.fromEntries(Object.entries(scope.permissions).sort(([a], [b]) => a.localeCompare(b))),
    }
    const normalized = yield* Schema.decodeUnknownEffect(InstallationScope)(canonical).pipe(
      Effect.mapError(() => new GitHubAppError({ operation: 'config', message: 'Invalid normalized scope' })),
    )
    const cacheKey = encodeScope(normalized)
    yield* Effect.annotateCurrentSpan({ ...attributes(scope.installationID), 'span.label': `${consumer} ${scope.installationID}` })
    const flight = yield* lock.withPermits(1)(Effect.gen(function* () {
      // Sample time after acquiring the lock, never before waiting for another fiber.
      const now = yield* Clock.currentTimeMillis
      const cached = tokens.get(cacheKey)
      if (cached !== undefined && cached.expiresAt - now > refreshMarginSeconds * 1000) return Effect.succeed(cached.token)
      const existing = flights.get(cacheKey)
      if (existing !== undefined) return existing
      const mint = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* Metric.update(Metric.withAttributes(mintCount, attributes(scope.installationID)), 1)
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
          repositories: Schema.optional(Schema.Array(RepositoryName)),
          permissions: Schema.Record(Schema.NonEmptyString, Schema.Literals(['read', 'write'])),
        })))({
          permissions: canonical.permissions,
          ...(canonical.repositories._tag === 'Selected' ? { repositories: canonical.repositories.names } : {}),
        }), 'application/json'),
      )
      const response = yield* raw.execute(request).pipe(
        Effect.mapError(() => new GitHubAppError({ operation: 'exchange', message: 'Installation token transport failed' })),
      )
      yield* observeResponse(scope.installationID, response.headers)
      if (response.status !== 201) return yield* new GitHubAppError({
        operation: 'exchange', status: response.status, message: 'GitHub rejected installation token exchange',
      })
      const value = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
        Effect.mapError(() => new GitHubAppError({ operation: 'exchange', message: 'Invalid installation token response' })),
      )
      const receivedAt = yield* Clock.currentTimeMillis
      if (value.expires_at.getTime() - receivedAt <= refreshMarginSeconds * 1000) return yield* new GitHubAppError({
        operation: 'exchange', message: 'Installation token expires inside refresh window',
      })
      tokens.set(cacheKey, { token: value.token, expiresAt: value.expires_at.getTime(), installationID: scope.installationID })
      yield* observeExpiry(scope.installationID)
      return value.token
      }).pipe(
        Effect.tapError(() => Metric.update(Metric.withAttributes(mintFailures, attributes(scope.installationID)), 1)),
        Effect.withSpan('github-app.mint', { attributes: { ...attributes(scope.installationID), 'span.label': `${consumer} ${scope.installationID}` } }),
      )
      // A shared cached effect shares both success and failure among current waiters.
      // Removing only this flight prevents late cleanup from deleting a replacement.
      const shared: Effect.Effect<Redacted.Redacted<string>, GitHubAppError> = yield* Effect.cached(mint.pipe(Effect.ensuring(Effect.sync(() => {
        if (flights.get(cacheKey) === shared) flights.delete(cacheKey)
      }))))
      flights.set(cacheKey, shared)
      return shared
    }))
    return yield* flight
  })

  const invalidate = Effect.fn('github-app.invalidate')(function* (rejected: Redacted.Redacted<string>) {
    const installations = new Set<number>()
    // Compare token values: a late 401 must not evict a newer token minted by another fiber.
    for (const [key, entry] of tokens) {
      if (Redacted.value(entry.token) === Redacted.value(rejected)) {
        tokens.delete(key)
        installations.add(entry.installationID)
      }
    }
    yield* Effect.annotateCurrentSpan({ 'github.app.client_id': config.identity.clientID, 'github.consumer': consumer, 'github.installation.ids': [...installations].join(','), 'span.label': consumer })
    yield* Effect.forEach(installations, observeExpiry, { discard: true })
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
        yield* observeResponse(scope.installationID, response.headers)
        if (response.status === 401) {
          yield* invalidate(credential)
          // Never transparently replay writes. The caller decides whether an operation is safe to retry.
          return yield* new GitHubAppError({ operation: 'authorize', status: 401, message: 'GitHub rejected installation token; cache invalidated' })
        }
        return response
      }).pipe(Effect.withSpan('github-app.request', {
        attributes: { ...attributes(scope.installationID), 'span.label': `${consumer} ${scope.installationID}` },
      })),
      Effect.succeed,
    )
  return { token, client } as const
})

export class GitHubApp extends Context.Service<GitHubApp, GitHubAppService>()('@overeng/utils/GitHubApp') {
  static layer = (config: typeof AppConfig.Type, options: GitHubAppOptions) =>
    Layer.effect(this, makeGitHubApp(config, options))
}

export const installationHttpClientLayer = (scope: InstallationScope) =>
  Layer.effect(GitHubAppHttpClient, Effect.map(GitHubApp, (app) => app.client(scope)))
