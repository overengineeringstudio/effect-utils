import { generateKeyPairSync, verify } from 'node:crypto'
import { createServer } from 'node:http'

import { it } from '@effect/vitest'
import { Clock, Deferred, Effect, Fiber, Metric, Redacted, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'
import { expect } from 'vitest'

import { makeGitHubApp, type InstallationScope } from './github-app.ts'

const Json = Schema.fromJsonString(Schema.Unknown)
const Claims = Schema.fromJsonString(Schema.Struct({ iat: Schema.Int, exp: Schema.Int, iss: Schema.String }))
const scope: InstallationScope = { installationID: 123, repositories: ['dotfiles'], permissions: { issues: 'write' } }

const fixture = Effect.gen(function* () {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const started = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const delay = yield* Effect.context<never>()
  const state = {
    now: yield* Clock.currentTimeMillis,
    exchanges: 0,
    calls: 0,
    mintStatus: 201,
    unauthorized: false,
    bodies: [] as unknown[],
    jwts: [] as Array<{ iat: number; exp: number; iss: string; verified: boolean }>,
    delayMint: false,
  }
  const server = createServer(async (request, response) => {
    if (request.url === '/app/installations/123/access_tokens') {
      state.exchanges++
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      state.bodies.push(Schema.decodeUnknownSync(Json)(Buffer.concat(chunks).toString()))
      if (state.delayMint) {
        await Effect.runPromiseWith(delay)(Deferred.succeed(started, undefined))
        await Effect.runPromiseWith(delay)(Deferred.await(release))
      }
      const jwt = request.headers.authorization?.slice('Bearer '.length) ?? ''
      const [header = '', claims = '', signature = ''] = jwt.split('.')
      state.jwts.push({
        ...Schema.decodeUnknownSync(Claims)(Buffer.from(claims, 'base64url').toString()),
        verified: verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')),
      })
      response.writeHead(state.mintStatus, { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999', 'x-ratelimit-resource': 'core' })
      response.end(Schema.encodeSync(Json)({ token: `installation-${state.exchanges}`, expires_at: new Date(state.now + 3_600_000).toISOString() }))
    } else {
      state.calls++
      response.writeHead(state.unauthorized ? 401 : 200, { 'content-type': 'application/json', 'x-ratelimit-remaining': '4998', 'x-ratelimit-resource': 'core' })
      response.end('{}')
    }
  })
  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))),
    () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  const address = server.address()
  if (address === null || typeof address === 'string') return yield* Effect.die('Expected TCP test server')
  const apiBase = new URL(`http://127.0.0.1:${address.port}`)
  const app = yield* makeGitHubApp({
    identity: { clientID: 'Iv1.fixture' },
    privateKey: Redacted.make(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
  }, { apiBase, consumer: 'fixture' }).pipe(Effect.provide(FetchHttpClient.layer))
  return { state, app, apiBase, started, release }
})

it.effect('signs real JWTs, caches concurrent requests, refreshes early, and isolates scope', () =>
  Effect.gen(function* () {
    const { state, app } = yield* fixture
    const tokens = yield* Effect.forEach([1, 2, 3, 4], () => app.token(scope), { concurrency: 'unbounded' })
    expect(tokens.map(Redacted.value)).toEqual(Array(4).fill('installation-1'))
    expect(state.exchanges).toBe(1)
    expect(state.bodies).toEqual([{ repositories: ['dotfiles'], permissions: { issues: 'write' } }])
    expect(state.jwts[0]).toEqual({ iat: Math.floor(state.now / 1000) - 60, exp: Math.floor(state.now / 1000) + 540, iss: 'Iv1.fixture', verified: true })
    expect(state.jwts[0]!.exp - state.jwts[0]!.iat).toBeLessThanOrEqual(600)
    state.now += 3_539_000
    yield* TestClock.adjust('3539 seconds')
    expect(Redacted.value(yield* app.token(scope))).toBe('installation-1')
    state.now += 1_000
    yield* TestClock.adjust('1 second')
    expect(Redacted.value(yield* app.token(scope))).toBe('installation-2')
    yield* app.token({ ...scope, permissions: { issues: 'read' } })
    yield* app.token({ ...scope, repositories: ['another-private-repo'] })
    expect(state.exchanges).toBe(4)
    expect(state.bodies[2]).toEqual({ repositories: ['dotfiles'], permissions: { issues: 'read' } })
    expect(state.bodies[3]).toEqual({ repositories: ['another-private-repo'], permissions: { issues: 'write' } })
  }),
)

it.effect('invalidates on 401 without replay and remints on the next explicit operation', () =>
  Effect.gen(function* () {
    const { state, app, apiBase } = yield* fixture
    const client = app.client(scope)
    state.unauthorized = true
    const failure = yield* client.post(new URL('/probe', apiBase)).pipe(Effect.flip)
    expect(failure).toMatchObject({ _tag: 'GitHubAppError', operation: 'authorize', status: 401 })
    expect(state.calls).toBe(1)
    expect(state.exchanges).toBe(1)
    state.unauthorized = false
    yield* client.get(new URL('/probe', apiBase))
    expect(state.exchanges).toBe(2)
    expect(state.calls).toBe(2)
  }),
)

it.effect('types mint 401, rejects empty permission scopes, and never sends credentials off-origin', () =>
  Effect.gen(function* () {
    const { state, app } = yield* fixture
    state.mintStatus = 401
    const mintFailure = yield* app.token(scope).pipe(Effect.flip)
    expect(mintFailure).toMatchObject({ _tag: 'GitHubAppError', operation: 'exchange', status: 401 })
    state.mintStatus = 201
    expect(yield* app.token({ ...scope, permissions: {} }).pipe(Effect.flip)).toMatchObject({ operation: 'config' })
    expect(yield* app.client(scope).get('https://not-github.invalid/').pipe(Effect.flip)).toMatchObject({ operation: 'authorize' })
    expect(state.exchanges).toBe(1)
  }),
)

it.effect('shares a failed mint across concurrent callers and allows the next call to recover', () =>
  Effect.gen(function* () {
    const { state, app, started, release } = yield* fixture
    state.delayMint = true
    state.mintStatus = 403
    const fibers = yield* Effect.forEach([1, 2, 3, 4], () => app.token(scope).pipe(Effect.flip, Effect.forkChild))
    yield* Deferred.await(started)
    yield* Deferred.succeed(release, undefined)
    const failures = yield* Effect.forEach(fibers, Fiber.join)
    expect(failures.every((failure) => failure.status === 403)).toBe(true)
    expect(state.exchanges).toBe(1)
    state.mintStatus = 201
    yield* app.token(scope)
    expect(state.exchanges).toBe(2)
  }),
)

it.effect('does not serialize independent scopes behind a stalled exchange', () =>
  Effect.gen(function* () {
    const { state, app, started, release } = yield* fixture
    state.delayMint = true
    const pending = yield* app.token(scope).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    state.delayMint = false
    yield* app.token({ ...scope, repositories: ['independent'] })
    expect(state.exchanges).toBe(2)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(pending)
  }),
)

it.effect('canonicalizes repository and permission ordering without widening authority', () =>
  Effect.gen(function* () {
    const { state, app } = yield* fixture
    yield* app.token({ ...scope, repositories: ['b', 'a', 'a'], permissions: { issues: 'write', contents: 'read' } })
    yield* app.token({ ...scope, repositories: ['a', 'b'], permissions: { contents: 'read', issues: 'write' } })
    expect(state.exchanges).toBe(1)
    expect(state.bodies).toEqual([{ repositories: ['a', 'b'], permissions: { contents: 'read', issues: 'write' } }])
  }),
)

it.effect('records safe per-consumer mint/failure, expiry, and bucket metrics', () =>
  Effect.gen(function* () {
    const { state, app, apiBase } = yield* fixture
    const attributes = { 'github.app.client_id': 'Iv1.fixture', 'github.installation.id': '123', 'github.consumer': 'fixture' }
    state.mintStatus = 403
    yield* app.token(scope).pipe(Effect.flip)
    state.mintStatus = 201
    yield* app.client(scope).get(new URL('/probe', apiBase))
    expect((yield* Metric.value(Metric.withAttributes(Metric.counter('github_app_mints_total'), attributes))).count).toBe(2)
    expect((yield* Metric.value(Metric.withAttributes(Metric.counter('github_app_mint_failures_total'), attributes))).count).toBe(1)
    expect((yield* Metric.value(Metric.withAttributes(Metric.gauge('github_app_token_expiry_seconds'), attributes))).value).toBe((state.now + 3_600_000) / 1000)
    expect((yield* Metric.value(Metric.withAttributes(Metric.gauge('github_app_rate_limit_remaining'), { ...attributes, 'github.resource': 'core' }))).value).toBe(4998)
    state.unauthorized = true
    yield* app.client(scope).get(new URL('/probe', apiBase)).pipe(Effect.flip)
    expect((yield* Metric.value(Metric.withAttributes(Metric.gauge('github_app_token_expiry_seconds'), attributes))).value).toBe(0)
  }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
)
