import { createPrivateKey, createSign } from 'node:crypto'

import { Clock, Context, Effect, Layer, Redacted, Schema, Semaphore, Stream } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { HttpClientError, DecodeError } from 'effect/http/HttpClientError'

import { OtelAttr, OtelMetric, OtelOperation } from '@overeng/otel-contract'

import {
  AppLabels,
  Resource,
  MintCount,
  MintFailures,
  TokenExpiry,
  RateRemaining,
  RateLimit,
  RateReset,
} from './github-app.contract.ts'

const PositiveID = Schema.Int.check(Schema.isGreaterThan(0))
/** GitHub App client identity used as the JWT issuer. */
export const AppIdentity = Schema.Struct({
  clientID: Schema.NonEmptyString,
}).annotate({ identifier: 'GitHubApp.Identity' })
/** App identity and redacted RSA signing key. */
export const AppConfig = Schema.Struct({
  identity: AppIdentity,
  privateKey: Schema.Redacted(Schema.NonEmptyString),
}).annotate({ identifier: 'GitHubApp.Config' })

const RepositoryName = Schema.NonEmptyString.check(
  Schema.makeFilter((name) => name.trim().length > 0 && !name.includes('/')),
)
/** Explicit repository selection or read-only installation-wide access. */
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
})
  .check(
    Schema.makeFilter(
      (scope) =>
        Object.keys(scope.permissions).length > 0 &&
        (scope.repositories._tag === 'Selected' ||
          Object.values(scope.permissions).every((value) => value === 'read')),
    ),
  )
  .annotate({ identifier: 'GitHubApp.InstallationScope' })
export type InstallationScope = typeof InstallationScope.Type

/** Public App and bot identity; no installation or credential capability. */
export const GitHubAppIdentity = Schema.Struct({
  appId: PositiveID,
  slug: Schema.NonEmptyString,
  botLogin: Schema.NonEmptyString,
  botUserId: PositiveID,
}).annotate({ identifier: 'GitHubApp.BotIdentity' })
export type GitHubAppIdentity = typeof GitHubAppIdentity.Type

const AppResponse = Schema.Struct({ id: PositiveID, slug: Schema.NonEmptyString })
const BotResponse = Schema.Struct({ id: PositiveID })

/** Credential-free configuration, signing, exchange, or authorization failure. */
export class GitHubAppError extends Schema.TaggedError<GitHubAppError>()('GitHubAppError', {
  operation: Schema.Literals(['config', 'sign', 'exchange', 'authorize', 'identity']),
  message: Schema.String,
  status: Schema.optional(Schema.Int),
  method: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
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

/** Consumer identity and transport/token refresh settings. */
export interface GitHubAppOptions {
  /** Stable process/consumer identity, never a repository, request ID, or credential. */
  readonly consumer: string
  readonly apiBase?: URL
  readonly userAgent?: string
  readonly refreshMarginSeconds?: number
}

const MintOperation = OtelOperation.define({
  name: 'github-app.mint',
  schema: AppLabels,
  label: ({ consumer, installationID }) => `${consumer} ${installationID}`,
})
const RequestOperation = OtelOperation.define({
  name: 'github-app.request',
  schema: AppLabels,
  label: ({ consumer, installationID }) => `${consumer} ${installationID}`,
})
const MakeOperation = OtelOperation.define({
  name: 'github-app.make',
  schema: Schema.Struct({
    clientID: AppLabels.fields.clientID,
    consumer: AppLabels.fields.consumer,
  }),
  label: ({ consumer }) => consumer,
})
const IdentityOperation = OtelOperation.define({
  name: 'github-app.identity',
  attributes: MakeOperation.attributes,
  label: ({ consumer }) => consumer,
})
const InvalidateOperation = OtelOperation.define({
  name: 'github-app.invalidate',
  schema: Schema.Struct({
    clientID: AppLabels.fields.clientID,
    consumer: AppLabels.fields.consumer,
    installations: OtelAttr.string({ key: 'github.installation.ids' }),
  }),
  label: ({ consumer }) => consumer,
})
const mintCount = OtelMetric.effect.counter(MintCount.metric)
const mintFailures = OtelMetric.effect.counter(MintFailures.metric)
const tokenExpiry = OtelMetric.effect.gauge({ ...TokenExpiry.metric, instrument: 'gauge' })
const rateRemaining = OtelMetric.effect.gauge({ ...RateRemaining.metric, instrument: 'gauge' })
const rateLimit = OtelMetric.effect.gauge({ ...RateLimit.metric, instrument: 'gauge' })
const rateReset = OtelMetric.effect.gauge({ ...RateReset.metric, instrument: 'gauge' })
const rateObservations = [
  ['x-ratelimit-remaining', rateRemaining],
  ['x-ratelimit-limit', rateLimit],
  ['x-ratelimit-reset', rateReset],
] as const

/** Scoped typed HttpClient; deliberately distinct from the unauthenticated transport dependency. */
export class GitHubAppHttpClient extends Context.Service<
  GitHubAppHttpClient,
  HttpClient.HttpClient.With<GitHubAppError | HttpClientError>
>()('@overeng/utils/GitHubAppHttpClient') {}

/** Token minting and authenticated clients sharing a scoped token cache. */
export interface GitHubAppService {
  /** Single-flight, service-lifetime cache of successful App/bot identity lookups. */
  readonly identity: Effect.Effect<GitHubAppIdentity, GitHubAppError>
  readonly token: (
    scope: InstallationScope,
  ) => Effect.Effect<Redacted.Redacted<string>, GitHubAppError>
  readonly client: (
    scope: InstallationScope,
  ) => HttpClient.HttpClient.With<GitHubAppError | HttpClientError>
}

/** Creates an App service using the provided unauthenticated HttpClient transport. */
export const makeGitHubApp = Effect.fn('github-app.make')(function* (
  input: typeof AppConfig.Type,
  options: GitHubAppOptions,
) {
  const config = yield* Schema.decodeEffect(AppConfig)(input).pipe(
    Effect.mapError(
      () => new GitHubAppError({ operation: 'config', message: 'Invalid GitHub App config' }),
    ),
  )
  const consumer = yield* Schema.decodeEffect(Schema.NonEmptyString)(options.consumer).pipe(
    Effect.mapError(
      () =>
        new GitHubAppError({ operation: 'config', message: 'Consumer identity must be non-empty' }),
    ),
  )
  const refreshMarginSeconds = yield* Schema.decodeEffect(PositiveID)(
    options.refreshMarginSeconds ?? 60,
  ).pipe(
    Effect.mapError(
      () =>
        new GitHubAppError({
          operation: 'config',
          message: 'Refresh margin must be a positive integer in seconds',
        }),
    ),
  )
  yield* MakeOperation.annotate({ clientID: config.identity.clientID, consumer }).pipe(Effect.orDie)
  // Parse once. Never attach the PEM or crypto exception to an error/log/span.
  const key = yield* Effect.try({
    try: () => createPrivateKey(Redacted.value(config.privateKey)),
    catch: () =>
      new GitHubAppError({ operation: 'sign', message: 'Invalid GitHub App RSA private key' }),
  })
  if (key.asymmetricKeyType !== 'rsa') {
    return yield* new GitHubAppError({
      operation: 'sign',
      message: 'GitHub App requires an RSA private key',
    })
  }
  const raw = yield* HttpClient.HttpClient
  // Middleware cannot opt JWT requests into redirect replay. Use the platform transport,
  // not the injected client's closed-over middleware or Fetch/RequestInit customizations.
  const jwtTransport = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))
  const platformFetch = globalThis.fetch
  const executeJwt = (request: HttpClientRequest.HttpClientRequest) =>
    jwtTransport
      .execute(request)
      .pipe(
        Effect.provideService(FetchHttpClient.Fetch, platformFetch),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
      )
  const apiBase = options.apiBase ?? new URL('https://api.github.com')
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': options.userAgent ?? 'overeng-github-app/0.1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const lock = yield* Semaphore.make(1)
  const tokens = new Map<
    string,
    {
      readonly token: Redacted.Redacted<string>
      readonly expiresAt: number
      readonly installationID: number
    }
  >()
  const flights = new Map<string, Effect.Effect<Redacted.Redacted<string>, GitHubAppError>>()
  const attributes = (installationID: number) => ({
    clientID: config.identity.clientID,
    installationID: String(installationID),
    consumer,
  })
  const observeResponse = Effect.fn('github-app.rate-limit')(function* (
    installationID: number,
    responseHeaders: Readonly<Record<string, string | undefined>>,
  ) {
    yield* MintOperation.annotate(attributes(installationID)).pipe(Effect.orDie)
    const resource = responseHeaders['x-ratelimit-resource']
    // GitHub's resources are a finite vocabulary; never use arbitrary response strings as labels.
    if (resource !== undefined && Schema.is(Resource)(resource) === true) {
      const labels = { ...attributes(installationID), resource }
      for (const [header, gauge] of rateObservations) {
        const rawValue = responseHeaders[header]
        // Missing, empty and malformed values are not observations (in particular, not zero).
        if (rawValue === undefined || /^\d+$/.test(rawValue) === false) continue
        const value = Number(rawValue)
        if (Number.isSafeInteger(value) === true) {
          yield* gauge.trustedSet({ labels, value })
        }
      }
    }
  })
  const observeExpiry = (installationID: number) =>
    Effect.suspend(() => {
      const expiries = [...tokens.values()]
        .filter((entry) => entry.installationID === installationID)
        .map((entry) => entry.expiresAt)
      return tokenExpiry.trustedSet({
        labels: attributes(installationID),
        value: expiries.length === 0 ? 0 : Math.min(...expiries) / 1000,
      })
    })

  // JWT custody stays here: neither a signer nor an App-authenticated client is exposed.
  const signJwt = Effect.gen(function* () {
    const signedAt = yield* Clock.currentTimeMillis
    return yield* Effect.try({
      try: () => {
        const unsigned = `${Buffer.from(encodeHeader({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
          encodeClaims({
            iat: Math.floor(signedAt / 1000) - 60,
            exp: Math.floor(signedAt / 1000) + 540,
            iss: config.identity.clientID,
          }),
        ).toString('base64url')}`
        return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).end().sign(key).toString('base64url')}`
      },
      catch: () =>
        new GitHubAppError({ operation: 'sign', message: 'Failed to sign GitHub App JWT' }),
    })
  })
  let cachedIdentity: GitHubAppIdentity | undefined
  let identityFlight: Effect.Effect<GitHubAppIdentity, GitHubAppError> | undefined
  const identityRequest = Effect.fn('github-app.identity-request')(function* (
    path: string,
    jwt?: string,
  ) {
    const url = new URL(path, apiBase)
    if (url.origin !== apiBase.origin)
      return yield* new GitHubAppError({
        operation: 'identity',
        message: 'Refusing to send GitHub App JWT to another origin',
      })
    const request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers))
    const response = yield* (
      jwt === undefined
        ? raw.execute(request)
        : executeJwt(request.pipe(HttpClientRequest.bearerToken(jwt)))
    ).pipe(
      Effect.updateContext((context: Context.Context<never>) =>
        Context.add(context, FetchHttpClient.RequestInit, {
          ...Context.getOrUndefined(context, FetchHttpClient.RequestInit),
          redirect: 'manual',
        }),
      ),
      Effect.mapError(
        (error) =>
          new GitHubAppError({
            operation: 'identity',
            method: 'GET',
            path: url.pathname,
            reason: error.reason._tag,
            ...(error.response === undefined ? {} : { status: error.response.status }),
            message: 'GitHub App identity transport failed',
          }),
      ),
    )
    // Do not follow redirects or retain the authenticated response in errors.
    if (response.status !== 200)
      return yield* new GitHubAppError({
        operation: 'identity',
        status: response.status,
        method: 'GET',
        path: url.pathname,
        message: 'GitHub rejected App identity lookup',
      })
    return yield* response.json.pipe(
      Effect.mapError(
        () =>
          new GitHubAppError({
            operation: 'identity',
            message: 'Invalid GitHub App identity response',
          }),
      ),
    )
  })
  const identity = Effect.gen(function* () {
    const flight = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (cachedIdentity !== undefined) return { effect: Effect.succeed(cachedIdentity) }
        if (identityFlight !== undefined) return { effect: identityFlight }
        const lookup = Effect.gen(function* () {
          const jwt = yield* signJwt.pipe(
            Effect.mapError(
              () =>
                new GitHubAppError({
                  operation: 'identity',
                  message: 'Failed to sign GitHub App identity JWT',
                }),
            ),
          )
          const app = yield* identityRequest('/app', jwt).pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(AppResponse)(value).pipe(
                Effect.mapError(
                  () =>
                    new GitHubAppError({
                      operation: 'identity',
                      message: 'Invalid GitHub App response',
                    }),
                ),
              ),
            ),
          )
          const botLogin = `${app.slug}[bot]`
          // Public user lookup needs no token and no installation permissions.
          const bot = yield* identityRequest(`/users/${encodeURIComponent(botLogin)}`).pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(BotResponse)(value).pipe(
                Effect.mapError(
                  () =>
                    new GitHubAppError({
                      operation: 'identity',
                      message: 'Invalid GitHub bot response',
                    }),
                ),
              ),
            ),
          )
          cachedIdentity = { appId: app.id, slug: app.slug, botLogin, botUserId: bot.id }
          return cachedIdentity
        })
        const shared: Effect.Effect<GitHubAppIdentity, GitHubAppError> = yield* Effect.cached(
          lookup.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (identityFlight === shared) identityFlight = undefined
              }),
            ),
          ),
        )
        identityFlight = shared
        return { effect: shared }
      }),
    )
    return yield* flight.effect
  }).pipe((effect) =>
    IdentityOperation.with({
      attributes: { clientID: config.identity.clientID, consumer },
      effect,
    }).pipe(Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error))),
  )

  const token = Effect.fn('github-app.token')(function* (inputScope: InstallationScope) {
    const scope = yield* Schema.decodeEffect(InstallationScope)(inputScope).pipe(
      Effect.mapError(
        () => new GitHubAppError({ operation: 'config', message: 'Invalid installation scope' }),
      ),
    )
    const canonical = {
      ...scope,
      repositories:
        scope.repositories._tag === 'Selected'
          ? { _tag: 'Selected' as const, names: [...new Set(scope.repositories.names)].toSorted() }
          : scope.repositories,
      permissions: Object.fromEntries(
        Object.entries(scope.permissions).toSorted(([a], [b]) => a.localeCompare(b)),
      ),
    }
    const normalized = yield* Schema.decodeUnknownEffect(InstallationScope)(canonical).pipe(
      Effect.mapError(
        () => new GitHubAppError({ operation: 'config', message: 'Invalid normalized scope' }),
      ),
    )
    const cacheKey = encodeScope(normalized)
    yield* MintOperation.annotate(attributes(scope.installationID)).pipe(Effect.orDie)
    const flight = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        // Sample time after acquiring the lock, never before waiting for another fiber.
        const now = yield* Clock.currentTimeMillis
        const cached = tokens.get(cacheKey)
        if (cached !== undefined && cached.expiresAt - now > refreshMarginSeconds * 1000)
          return { effect: Effect.succeed(cached.token) }
        const existing = flights.get(cacheKey)
        if (existing !== undefined) return { effect: existing }
        const mint = Effect.gen(function* () {
          yield* mintCount.trustedIncrement(attributes(scope.installationID))
          const jwt = yield* signJwt
          const body = yield* Schema.encodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                repositories: Schema.optional(Schema.Array(RepositoryName)),
                permissions: Schema.Record(
                  Schema.NonEmptyString,
                  Schema.Literals(['read', 'write']),
                ),
              }),
            ),
          )({
            permissions: canonical.permissions,
            ...(canonical.repositories._tag === 'Selected'
              ? { repositories: canonical.repositories.names }
              : {}),
          }).pipe(
            Effect.mapError(
              () =>
                new GitHubAppError({
                  operation: 'exchange',
                  message: 'Invalid installation token request',
                }),
            ),
          )
          const request = HttpClientRequest.post(
            new URL(`/app/installations/${scope.installationID}/access_tokens`, apiBase),
          ).pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bearerToken(jwt),
            HttpClientRequest.bodyText(body, 'application/json'),
          )
          const response = yield* executeJwt(request).pipe(
            Effect.mapError(
              () =>
                new GitHubAppError({
                  operation: 'exchange',
                  message: 'Installation token transport failed',
                }),
            ),
          )
          yield* observeResponse(scope.installationID, response.headers)
          if (response.status !== 201)
            return yield* new GitHubAppError({
              operation: 'exchange',
              status: response.status,
              message: 'GitHub rejected installation token exchange',
            })
          const value = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
            Effect.mapError(
              () =>
                new GitHubAppError({
                  operation: 'exchange',
                  message: 'Invalid installation token response',
                }),
            ),
          )
          const receivedAt = yield* Clock.currentTimeMillis
          if (value.expires_at.getTime() - receivedAt <= refreshMarginSeconds * 1000)
            return yield* new GitHubAppError({
              operation: 'exchange',
              message: 'Installation token expires inside refresh window',
            })
          tokens.set(cacheKey, {
            token: value.token,
            expiresAt: value.expires_at.getTime(),
            installationID: scope.installationID,
          })
          yield* observeExpiry(scope.installationID)
          return value.token
        }).pipe(
          Effect.tapError(() => mintFailures.trustedIncrement(attributes(scope.installationID))),
          (effect) =>
            MintOperation.with({
              attributes: attributes(scope.installationID),
              effect,
            }).pipe(Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error))),
        )
        // A shared cached effect shares both success and failure among current waiters.
        // Removing only this flight prevents late cleanup from deleting a replacement.
        const shared: Effect.Effect<
          Redacted.Redacted<string>,
          GitHubAppError
        > = yield* Effect.cached(
          mint.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (flights.get(cacheKey) === shared) flights.delete(cacheKey)
              }),
            ),
          ),
        )
        flights.set(cacheKey, shared)
        return { effect: shared }
      }),
    )
    return yield* flight.effect
  })

  const invalidate = Effect.fn('github-app.invalidate')(function* (
    rejected: Redacted.Redacted<string>,
  ) {
    const installations = new Set<number>()
    // Compare token values: a late 401 must not evict a newer token minted by another fiber.
    for (const [cacheKey, entry] of tokens) {
      if (Redacted.value(entry.token) === Redacted.value(rejected)) {
        tokens.delete(cacheKey)
        installations.add(entry.installationID)
      }
    }
    yield* InvalidateOperation.annotate({
      clientID: config.identity.clientID,
      consumer,
      installations: [...installations].join(','),
    }).pipe(Effect.orDie)
    yield* Effect.forEach(installations, observeExpiry, { discard: true })
  })

  const client = (
    scope: InstallationScope,
  ): HttpClient.HttpClient.With<GitHubAppError | HttpClientError> =>
    HttpClient.makeWith<never, never, GitHubAppError | HttpClientError, never>(
      (requestEffect) =>
        Effect.gen(function* () {
          const request = yield* requestEffect
          const url = yield* Effect.try({
            try: () => new URL(request.url),
            catch: () =>
              new GitHubAppError({
                operation: 'authorize',
                message: 'Authenticated GitHub request requires an absolute URL',
              }),
          })
          if (url.origin !== apiBase.origin)
            return yield* new GitHubAppError({
              operation: 'authorize',
              message: 'Refusing to send GitHub installation token to another origin',
            })
          const credential = yield* token(scope)
          const response = yield* raw
            .execute(
              request.pipe(
                HttpClientRequest.setHeaders(headers),
                HttpClientRequest.bearerToken(Redacted.value(credential)),
              ),
            )
            .pipe(
              Effect.tapError((error) =>
                Effect.gen(function* () {
                  if (error.response !== undefined) {
                    yield* observeResponse(scope.installationID, error.response.headers)
                    if (error.response.status === 401) yield* invalidate(credential)
                  }
                }),
              ),
              Effect.mapError(
                (error) =>
                  new GitHubAppError({
                    operation: 'authorize',
                    method: request.method,
                    path: url.pathname,
                    reason: error.reason._tag,
                    ...(error.response === undefined ? {} : { status: error.response.status }),
                    message: `GitHub request failed: ${request.method} ${url.pathname} (${error.reason._tag})`,
                  }),
              ),
            )
          yield* observeResponse(scope.installationID, response.headers)
          if (response.status === 401) {
            yield* invalidate(credential)
            // Never transparently replay writes. The caller decides whether an operation is safe to retry.
            return yield* new GitHubAppError({
              operation: 'authorize',
              status: 401,
              message: 'GitHub rejected installation token; cache invalidated',
            })
          }
          // Never expose the authenticated request through response decoding failures.
          // Body access remains lazy/streaming; only safe metadata survives in errors.
          const safeRequest = HttpClientRequest.make(request.method)(`${url.origin}${url.pathname}`)
          const metadata = HttpClientResponse.fromWeb(
            safeRequest,
            new Response(null, {
              status: response.status,
              headers: response.headers,
            }),
          )
          const decodeFailure = (error: HttpClientError) =>
            new HttpClientError({
              reason: new DecodeError({
                request: safeRequest,
                response: metadata,
                description: error.reason._tag,
              }),
            })
          const safeResponse = HttpClientResponse.fromWeb(
            safeRequest,
            new Response(null, {
              status: response.status,
              headers: response.headers,
            }),
          )
          Object.defineProperties(safeResponse, {
            json: { get: () => response.json.pipe(Effect.mapError(decodeFailure)) },
            text: { get: () => response.text.pipe(Effect.mapError(decodeFailure)) },
            urlParamsBody: {
              get: () => response.urlParamsBody.pipe(Effect.mapError(decodeFailure)),
            },
            arrayBuffer: { get: () => response.arrayBuffer.pipe(Effect.mapError(decodeFailure)) },
            formData: { get: () => response.formData.pipe(Effect.mapError(decodeFailure)) },
          })
          Object.defineProperty(safeResponse, 'stream', {
            get: () => response.stream.pipe(Stream.mapError(decodeFailure)),
          })
          Object.defineProperty(safeResponse, 'url', { value: response.url })
          return safeResponse
        }).pipe((effect) =>
          RequestOperation.with({
            attributes: attributes(scope.installationID),
            effect,
          }).pipe(Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error))),
        ),
      Effect.succeed,
    )
  return { identity, token, client } as const
})

/** Context service for shared GitHub App authentication. */
export class GitHubApp extends Context.Service<GitHubApp, GitHubAppService>()(
  '@overeng/utils/GitHubApp',
) {
  static layer = ({
    config,
    options,
  }: {
    config: typeof AppConfig.Type
    options: GitHubAppOptions
  }) => Layer.effect(this, makeGitHubApp(config, options))
}

/** Provides a dedicated authenticated HttpClient for an explicit installation scope. */
export const installationHttpClientLayer = (scope: InstallationScope) =>
  Layer.effect(
    GitHubAppHttpClient,
    Effect.map(GitHubApp, (app) => app.client(scope)),
  )
