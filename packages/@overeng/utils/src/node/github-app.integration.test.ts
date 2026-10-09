import { generateKeyPairSync, verify } from 'node:crypto'
import { createServer } from 'node:http'

import { NodeHttpClient } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Clock, Context, Deferred, Effect, Fiber, Layer, Metric, Redacted, Schema } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'
import { expect } from 'vitest'

import { makeGitHubApp, InstallationScope } from './github-app.ts'

const Json = Schema.fromJsonString(Schema.Unknown)
const Claims = Schema.fromJsonString(Schema.Struct({ iat: Schema.Int, exp: Schema.Int, iss: Schema.String }))
const scope: InstallationScope = { installationID: 123, repositories: { _tag: 'Selected', names: ['dotfiles'] }, permissions: { issues: 'write' } }

const fixture = (transport: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer) => Effect.gen(function* () {
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
    delayResponse: false,
    disconnect: false,
    malformed: false,
    expirySeconds: 3600,
    redirect: '',
    authorization: [] as string[],
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
      response.end(Schema.encodeSync(Json)({ token: `installation-${state.exchanges}`, expires_at: new Date(state.now + state.expirySeconds * 1000).toISOString() }))
    } else {
      state.calls++
      state.authorization.push(request.headers.authorization ?? '')
      if (state.disconnect) {
        request.socket.destroy()
        return
      }
      if (request.url === '/redirect' && state.redirect !== '') {
        response.writeHead(302, { location: state.redirect })
        response.end()
        return
      }
      if (state.delayResponse) {
        await Effect.runPromiseWith(delay)(Deferred.succeed(started, undefined))
        await Effect.runPromiseWith(delay)(Deferred.await(release))
      }
      response.writeHead(state.unauthorized ? 401 : 200, { 'content-type': 'application/json', 'x-ratelimit-remaining': '4998', 'x-ratelimit-resource': 'core' })
      response.end(state.malformed ? '{invalid' : '{}')
    }
  })
  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))),
    () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  const address = server.address()
  if (address === null || typeof address === 'string') return yield* Effect.die('Expected TCP test server')
  const apiBase = new URL(`http://127.0.0.1:${address.port}`)
  const services = yield* Layer.build(transport)
  const app = yield* makeGitHubApp({
    identity: { clientID: 'Iv1.fixture' },
    privateKey: Redacted.make(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
  }, { apiBase, consumer: 'fixture' }).pipe(Effect.provideService(HttpClient.HttpClient, Context.get(services, HttpClient.HttpClient)))
  return { state, app, apiBase, started, release }
})

it.effect('signs real JWTs, caches concurrent requests, refreshes early, and isolates scope', () =>
  Effect.gen(function* () {
    const { state, app } = yield* fixture()
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
    yield* app.token({ ...scope, repositories: { _tag: 'Selected', names: ['another-private-repo'] } })
    expect(state.exchanges).toBe(4)
    expect(state.bodies[2]).toEqual({ repositories: ['dotfiles'], permissions: { issues: 'read' } })
    expect(state.bodies[3]).toEqual({ repositories: ['another-private-repo'], permissions: { issues: 'write' } })
  }),
)

it.effect('invalidates on 401 without replay and remints on the next explicit operation', () =>
  Effect.gen(function* () {
    const { state, app, apiBase } = yield* fixture()
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
    const { state, app } = yield* fixture()
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
    const { state, app, started, release } = yield* fixture()
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
    const { state, app, started, release } = yield* fixture()
    state.delayMint = true
    const pending = yield* app.token(scope).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    state.delayMint = false
    yield* app.token({ ...scope, repositories: { _tag: 'Selected', names: ['independent'] } })
    expect(state.exchanges).toBe(2)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(pending)
  }),
)

it.effect('canonicalizes repository and permission ordering without widening authority', () =>
  Effect.gen(function* () {
    const { state, app } = yield* fixture()
    yield* app.token({ ...scope, repositories: { _tag: 'Selected', names: ['b', 'a', 'a'] }, permissions: { issues: 'write', contents: 'read' } })
    yield* app.token({ ...scope, repositories: { _tag: 'Selected', names: ['a', 'b'] }, permissions: { contents: 'read', issues: 'write' } })
    expect(state.exchanges).toBe(1)
    expect(state.bodies).toEqual([{ repositories: ['a', 'b'], permissions: { contents: 'read', issues: 'write' } }])
  }),
)

it.effect('allows explicit installation-wide reads without conflating selected scope', () =>
  Effect.gen(function* () {
    const { state, app } = yield* fixture()
    const readScope: InstallationScope = { ...scope, permissions: { issues: 'read' } }
    yield* app.token(readScope)
    yield* app.token({ ...readScope, repositories: { _tag: 'AllInstallation' } })
    yield* app.token({ ...readScope, repositories: { _tag: 'AllInstallation' } })
    expect(state.exchanges).toBe(2)
    expect(state.bodies).toEqual([
      { repositories: ['dotfiles'], permissions: { issues: 'read' } },
      { permissions: { issues: 'read' } },
    ])
  }),
)

it.effect('rejects broad writes and invalid repository selectors at the schema boundary', () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(InstallationScope)
    for (const repositories of [
      { _tag: 'AllInstallation' },
      { _tag: 'Selected', names: [] },
      { _tag: 'Selected', names: ['owner/repo'] },
      { _tag: 'Selected', names: ['   '] },
    ]) {
      expect((yield* decode({ ...scope, repositories }).pipe(Effect.result))._tag).toBe('Failure')
    }
    const { state, app } = yield* fixture()
    expect(yield* app.token({ ...scope, repositories: { _tag: 'AllInstallation' } }).pipe(Effect.flip))
      .toMatchObject({ operation: 'config' })
    expect(state.exchanges).toBe(0)
  }),
)

it.effect('records safe per-consumer mint/failure, expiry, and bucket metrics', () =>
  Effect.gen(function* () {
    const { state, app, apiBase } = yield* fixture()
    const attributes = { 'github.app.client_id': 'Iv1.fixture', 'github.installation.id': '123', 'github.consumer': 'fixture' }
    state.mintStatus = 403
    yield* app.token(scope).pipe(Effect.flip)
    state.mintStatus = 201
    yield* app.client(scope).get(new URL('/probe', apiBase))
    // Effect's registry identity includes the descriptor: inspect emitted snapshots,
    // rather than accidentally constructing another same-name metric without its description.
    const metrics = yield* Metric.snapshot
    expect(metrics).toHaveLength(4)
    expect(metrics.find((metric) => metric.id === 'github_app_mints_total')).toMatchObject({ type: 'Counter', attributes, state: { count: 2 } })
    expect(metrics.find((metric) => metric.id === 'github_app_mint_failures_total')).toMatchObject({ type: 'Counter', attributes, state: { count: 1 } })
    expect(metrics.find((metric) => metric.id === 'github_app_token_expiry_seconds')).toMatchObject({ type: 'Gauge', attributes, state: { value: (state.now + 3_600_000) / 1000 } })
    expect(metrics.find((metric) => metric.id === 'github_app_rate_limit_remaining')).toMatchObject({ type: 'Gauge', attributes: { ...attributes, 'github.resource': 'core' }, state: { value: 4998 } })
    state.unauthorized = true
    yield* app.client(scope).get(new URL('/probe', apiBase)).pipe(Effect.flip)
    expect((yield* Metric.snapshot).find((metric) => metric.id === 'github_app_token_expiry_seconds')).toMatchObject({ state: { value: 0 } })
  }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
)

it.effect('a late 401 cannot evict the replacement minted during the old request', () =>
  Effect.gen(function* () {
    const { state, app, apiBase, started, release } = yield* fixture()
    state.delayResponse = true
    const pending = yield* app.client(scope).get(new URL('/probe', apiBase)).pipe(Effect.flip, Effect.forkChild)
    yield* Deferred.await(started)
    state.now += 3_540_000
    yield* TestClock.adjust('3540 seconds')
    expect(Redacted.value(yield* app.token(scope))).toBe('installation-2')
    state.unauthorized = true
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(pending)).toMatchObject({ operation: 'authorize', status: 401 })
    expect(Redacted.value(yield* app.token(scope))).toBe('installation-2')
    expect(state.exchanges).toBe(2)
  }),
)

/** Inspect non-enumerable properties too: error serializers need not use toJSON. */
const expectCredentialFree = (value: unknown, credential: string) => {
  const seen = new Set<object>()
  const walk = (item: unknown): void => {
    if (typeof item === 'string') expect(item).not.toContain(credential)
    if (item === null || (typeof item !== 'object' && typeof item !== 'function') || seen.has(item)) return
    seen.add(item)
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (descriptor && 'value' in descriptor) walk(descriptor.value)
    }
  }
  walk(value)
  expect(Schema.encodeSync(Json)(value)).not.toContain(credential)
}

for (const [name, transport] of [
  ['fetch', FetchHttpClient.layer],
  ['node-http', NodeHttpClient.layerNodeHttp],
  ['undici', NodeHttpClient.layerUndici],
] as const) {
  it.effect(`${name}: excludes credentials from transport and decoding failures`, () =>
    Effect.gen(function* () {
      const { state, app, apiBase } = yield* fixture(transport)
      const credential = Redacted.value(yield* app.token(scope))
      state.disconnect = true
      const failure = yield* app.client(scope).get(new URL('/probe', apiBase)).pipe(Effect.flip)
      expectCredentialFree(failure, credential)
      expectCredentialFree({ cause: failure }, credential)
      state.disconnect = false
      state.malformed = true
      const response = yield* app.client(scope).get(new URL('/probe', apiBase))
      const decoding = yield* response.json.pipe(Effect.flip)
      expectCredentialFree(decoding, credential)
      expectCredentialFree({ cause: decoding }, credential)
      expect(decoding.request.headers.authorization).toBeUndefined()
      expect(decoding.response?.status).toBe(200)
    }),
  )

  it.effect(`${name}: real transport redirects never send the token to another origin`, () =>
    Effect.gen(function* () {
      const { state, app, apiBase } = yield* fixture(transport)
      const received: string[] = []
      const destination = createServer((request, response) => {
        received.push(request.headers.authorization ?? '')
        response.end('{}')
      })
      yield* Effect.acquireRelease(
        Effect.promise(() => new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve))),
        () => Effect.promise(() => new Promise<void>((resolve) => destination.close(() => resolve()))),
      )
      const address = destination.address()
      if (address === null || typeof address === 'string') return yield* Effect.die('Expected redirect fixture address')
      state.redirect = `http://127.0.0.1:${address.port}/destination`
      const response = yield* app.client(scope).get(new URL('/redirect', apiBase))
      expect([200, 302]).toContain(response.status)
      expect(state.authorization).toEqual(['Bearer installation-1'])
      expect(received.every((authorization) => authorization === '')).toBe(true)
      if (response.status === 200) expect(received).toEqual([''])
      else expect(received).toEqual([])
    }),
  )
}

it.effect('cancelling a shared-mint waiter does not cancel the mint or strand later callers', () =>
  Effect.gen(function* () {
    const { state, app, started, release } = yield* fixture()
    state.delayMint = true
    const owner = yield* app.token(scope).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    const waiter = yield* app.token(scope).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(waiter)
    yield* Deferred.succeed(release, undefined)
    expect(Redacted.value(yield* Fiber.join(owner))).toBe('installation-1')
    expect(Redacted.value(yield* app.token(scope))).toBe('installation-1')
    expect(state.exchanges).toBe(1)
  }),
)

it.effect('rejects tokens expiring inside the refresh window without caching them', () =>
  Effect.gen(function* () {
    const { state, app } = yield* fixture()
    state.expirySeconds = 60
    expect(yield* app.token(scope).pipe(Effect.flip)).toMatchObject({
      operation: 'exchange', message: 'Installation token expires inside refresh window',
    })
    state.expirySeconds = 3600
    expect(Redacted.value(yield* app.token(scope))).toBe('installation-2')
    expect(state.exchanges).toBe(2)
  }),
)
