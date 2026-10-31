import { it } from '@effect/vitest'
import { Clock, ConfigProvider, Deferred, Effect, Fiber, Layer, Redacted, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import * as TestClock from 'effect/testing/TestClock'
import { expect } from 'vitest'

import { githubActionsOidc, RepoStateCredentials } from './RepoStateCredentials.ts'

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const brokerUrl = 'https://broker.example.com/credentials'
const fixtureSecrets = [
  'fixture-actions-token',
  'fixture-jwt',
  'fixture-key-id',
  'fixture-secret-key',
  'fixture-session-token',
]
const configuration = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example.com/token?existing=value',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: fixtureSecrets[0],
  }),
)

it.effect(
  'exchanges an audience-bound OIDC token and shares cached, early-refreshed credentials',
  () =>
    Effect.gen(function* () {
      let tokenRequests = 0
      let brokerRequests = 0
      const client = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          expect(yield* HttpClient.TracerPropagationEnabled).toBe(false)
          expect((yield* HttpClient.TracerDisabledWhen)(request)).toBe(true)
          expect(request.headers.traceparent).toBeUndefined()
          if (url.hostname === 'actions.example.com') {
            tokenRequests++
            expect(url.searchParams.get('audience')).toBe(brokerUrl)
            expect(url.searchParams.get('existing')).toBe('value')
            expect(request.headers.authorization).toBe(`Bearer ${fixtureSecrets[0]}`)
            return HttpClientResponse.fromWeb(request, Response.json({ value: fixtureSecrets[1] }))
          }
          brokerRequests++
          expect(request.method).toBe('POST')
          if (request.body._tag === 'Uint8Array') {
            expect(new TextDecoder().decode(request.body.body)).toBe(
              `{"token":"${fixtureSecrets[1]}"}`,
            )
          } else {
            expect.fail('Expected a JSON byte body')
          }
          const now = yield* Clock.currentTimeMillis
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              accessKeyId: fixtureSecrets[2],
              secretAccessKey: fixtureSecrets[3],
              sessionToken: fixtureSecrets[4],
              endpoint: 'https://objects.example.com',
              bucket: 'state',
              prefix: 'alchemy/v1/example/project/',
              expiresAt: new Date(now + 300_000).toISOString(),
            }),
          )
        }),
      )
      yield* Effect.gen(function* () {
        const credentials = yield* RepoStateCredentials
        const initial = yield* Effect.all(
          Array.from({ length: 16 }, () => credentials.get),
          { concurrency: 'unbounded' },
        )
        expect(tokenRequests).toBe(1)
        expect(brokerRequests).toBe(1)
        expect(initial.every((credential) => credential === initial[0])).toBe(true)
        expect(Redacted.value(initial[0]!.secretAccessKey)).toBe(fixtureSecrets[3])
        for (const secret of fixtureSecrets) expect(encodeJson(initial)).not.toContain(secret)
        yield* TestClock.adjust('239 seconds')
        yield* credentials.get
        expect(brokerRequests).toBe(1)
        yield* TestClock.adjust('1 second')
        yield* Effect.all([credentials.get, credentials.get], { concurrency: 'unbounded' })
        expect(tokenRequests).toBe(2)
        expect(brokerRequests).toBe(2)
      }).pipe(
        Effect.provide(
          githubActionsOidc({ brokerUrl }).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          ),
        ),
      )
    }).pipe(Effect.provide(configuration)),
)

it.effect('single-flights a pending exchange', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let calls = 0
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        calls++
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ value: fixtureSecrets[1] }, { status: 503 }),
        )
      }),
    )
    yield* Effect.gen(function* () {
      const credentials = yield* RepoStateCredentials
      const pending = yield* Effect.all(
        [Effect.exit(credentials.get), Effect.exit(credentials.get)],
        {
          concurrency: 'unbounded',
        },
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(pending)
      expect(calls).toBe(1)
    }).pipe(
      Effect.provide(
        githubActionsOidc({ brokerUrl }).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
    )
  }).pipe(Effect.provide(configuration)),
)

for (const failure of ['status', 'malformed', 'defect', 'expired', 'invalid-schema'] as const) {
  it.effect(`sanitizes ${failure} responses and never retains failed credentials`, () =>
    Effect.gen(function* () {
      let calls = 0
      const client = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          calls++
          if (url.hostname === 'actions.example.com') {
            return HttpClientResponse.fromWeb(request, Response.json({ value: fixtureSecrets[1] }))
          }
          if (failure === 'defect') return yield* Effect.die({ request, secrets: fixtureSecrets })
          if (failure === 'status') {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ secrets: fixtureSecrets }, { status: 403 }),
            )
          }
          if (failure === 'malformed') {
            return HttpClientResponse.fromWeb(request, new Response(fixtureSecrets.join(' ')))
          }
          const now = yield* Clock.currentTimeMillis
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              accessKeyId: fixtureSecrets[2],
              secretAccessKey: fixtureSecrets[3],
              sessionToken: fixtureSecrets[4],
              endpoint: 'https://objects.example.com',
              bucket: 'state',
              prefix:
                failure === 'invalid-schema' ? fixtureSecrets[3] : 'alchemy/v1/example/project/',
              expiresAt: new Date(now + (failure === 'expired' ? 30_000 : 300_000)).toISOString(),
            }),
          )
        }),
      )
      yield* Effect.gen(function* () {
        const credentials = yield* RepoStateCredentials
        const result = yield* Effect.exit(credentials.get)
        expect(result._tag).toBe('Failure')
        for (const secret of fixtureSecrets) {
          expect(encodeJson(result)).not.toContain(secret)
          expect(String(result)).not.toContain(secret)
        }
        expect(encodeJson(result)).toContain('RepoStateError')
        yield* Effect.exit(credentials.get)
        expect(calls).toBe(4)
      }).pipe(
        Effect.provide(
          githubActionsOidc({ brokerUrl }).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          ),
        ),
      )
    }).pipe(Effect.provide(configuration)),
  )
}

it.effect('fails closed without Actions configuration', () =>
  Effect.gen(function* () {
    let calls = 0
    const client = HttpClient.make(() => {
      calls++
      return Effect.die('must not request a token without Actions configuration')
    })
    const result = yield* Effect.gen(function* () {
      return yield* (yield* RepoStateCredentials).get
    }).pipe(
      Effect.provide(
        githubActionsOidc({ brokerUrl }).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        ),
      ),
      Effect.exit,
    )
    expect(result._tag).toBe('Failure')
    expect(calls).toBe(0)
    expect(encodeJson(result)).toContain('RepoStateError')
  }),
)
