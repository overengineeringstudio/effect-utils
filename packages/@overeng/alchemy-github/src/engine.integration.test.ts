// The upstream Test/Core adapter intentionally exposes generic engine error/service
// channels; keep them intact so these tests exercise the real engine, not a cast facade.
/** @effect-diagnostics anyUnknownInErrorContext:off */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fromToken } from '@alchemy.run/github/Credentials'
import { it } from '@effect/vitest'
import { AlchemyContext } from 'alchemy/AlchemyContext'
import * as Provider from 'alchemy/Provider'
import { State } from 'alchemy/State'
import { scratchStack, toEffect } from 'alchemy/Test/Core'
import { Effect, Layer, Schema } from 'effect'
import { expect } from 'vitest'

import { App, AppProvider, type AppProps } from './App.ts'
import { AppError, AppManifestDriftError } from './AppErrors.ts'
import { Providers } from './Providers.ts'

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const fixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'alchemy-github-engine-'))),
    (path) => Effect.promise(() => rm(path, { recursive: true })),
  )
  const context = { dotAlchemy: directory, dev: false, adopt: false }
  const live = {
    permissions: { contents: 'read', metadata: 'read' },
    events: ['push'],
    secretStatus: 200,
    requests: [] as string[],
  }
  const server = createServer((request, response) => {
    const path = (request.url ?? '').replace(/^\/api/, '')
    live.requests.push(`${request.method} ${path}`)
    response.setHeader('content-type', 'application/json')
    if (request.method === 'GET' && path === '/apps/example-app') {
      response.end(
        encodeJson({
          id: 123,
          slug: 'example-app',
          client_id: 'Iv1.example',
          owner: { login: 'example' },
          permissions: live.permissions,
          events: live.events,
        }),
      )
    } else if (
      request.method === 'GET' &&
      path === '/repos/example/repo/actions/secrets/APP_PRIVATE_KEY'
    ) {
      response.statusCode = live.secretStatus
      response.end(
        encodeJson(
          live.secretStatus === 200
            ? { name: 'APP_PRIVATE_KEY', updated_at: '2026-01-02T00:00:00Z' }
            : { message: 'Not Found' },
        ),
      )
    } else {
      response.statusCode = 404
      response.end('{}')
    }
  })
  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))),
    () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  const address = server.address()
  if (address === null || typeof address === 'string')
    return yield* Effect.die('Expected TCP fixture')
  const credentials = fromToken('fixture-token', {
    baseUrl: `http://127.0.0.1:${address.port}/api`,
  })
  const providers = Layer.effect(Providers, Provider.collection([App])).pipe(
    Layer.provide(AppProvider),
    Layer.provideMerge(credentials),
  )
  const options = { providers, stage: 'test', dev: false, sidecar: false }
  // Core's scratch harness uses the real beta84 Plan.make -> apply pipeline,
  // with an isolated in-memory store shared across deploys and plans.
  const stack = scratchStack(options, 'github-app-engine')
  const props: AppProps = {
    owner: 'example',
    manifest: {
      name: 'Example App',
      url: 'https://example.com',
      redirectUrl: 'https://example.com/callback',
      permissions: { contents: 'read' },
      events: ['push'],
    },
    privateKeySecret: { owner: 'example', repository: 'repo', name: 'APP_PRIVATE_KEY' },
    adopt: { slug: 'example-app', appId: 123 },
  }
  const program = App('App', props)
  const persisted = Effect.gen(function* () {
    const state = yield* yield* State
    return yield* state.get({ stack: stack.name, stage: stack.stage, fqn: 'App' })
  }).pipe(Effect.provide(stack.state))
  return {
    live,
    stack,
    props,
    program,
    persisted,
    context,
    options: { ...options, state: stack.state },
  }
})

for (const drift of ['permissions', 'events'] as const) {
  it.effect(
    `real engine rejects live ${drift} drift with unchanged persisted props and attrs`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* toEffect(
          Effect.gen(function* () {
            yield* f.stack.deploy(f.program)
            const before = yield* f.persisted
            expect(before).toMatchObject({
              props: f.props,
              attr: {
                status: 'registered',
                permissions: { contents: 'read', metadata: 'read' },
                events: ['push'],
              },
            })
            const control = yield* f.stack.plan(f.program)
            expect(control.resources.App?.action).toBe('noop')
            f.live.requests.length = 0
            if (drift === 'permissions') f.live.permissions.contents = 'write'
            else f.live.events = ['issues']

            // No provider.read or manual refresh precedes this engine call:
            // Plan.make receives exactly the original persisted attributes.
            const error = yield* f.stack.plan(f.program).pipe(Effect.flip)
            expect(error).toBeInstanceOf(AppManifestDriftError)
            expect(error).toMatchObject(
              drift === 'permissions'
                ? {
                    _tag: 'AppManifestDriftError',
                    permissions: [{ permission: 'contents', desired: 'read', observed: 'write' }],
                  }
                : {
                    _tag: 'AppManifestDriftError',
                    events: { desired: ['push'], observed: ['issues'] },
                  },
            )
            expect(f.live.requests).toContain('GET /apps/example-app')
            expect(f.live.requests).toContain(
              'GET /repos/example/repo/actions/secrets/APP_PRIVATE_KEY',
            )
            expect(yield* f.persisted).toEqual(before)
          }),
          f.options,
        ).pipe(Effect.provideService(AlchemyContext, f.context))
      }),
  )
}

it.effect('real engine rejects a missing secret during an otherwise unchanged redeploy', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* toEffect(
      Effect.gen(function* () {
        yield* f.stack.deploy(f.program)
        const before = yield* f.persisted
        f.live.secretStatus = 404
        f.live.requests.length = 0
        const error = yield* f.stack.deploy(f.program).pipe(Effect.flip)
        expect(error).toBeInstanceOf(AppError)
        expect(error).toMatchObject({
          _tag: 'GitHubAppResourceError',
          operation: 'verify Actions secret',
        })
        expect(f.live.requests).toEqual(['GET /repos/example/repo/actions/secrets/APP_PRIVATE_KEY'])
        expect(yield* f.persisted).toEqual(before)
      }),
      f.options,
    ).pipe(Effect.provideService(AlchemyContext, f.context))
  }),
)

it.effect('real engine refuses fresh adoption without the declared secret', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    f.live.secretStatus = 404
    yield* toEffect(
      Effect.gen(function* () {
        const error = yield* f.stack.deploy(f.program).pipe(Effect.flip)
        expect(error).toBeInstanceOf(AppError)
        expect(error).toMatchObject({
          _tag: 'GitHubAppResourceError',
          operation: 'verify Actions secret',
        })
        expect(f.live.requests).toEqual(['GET /repos/example/repo/actions/secrets/APP_PRIVATE_KEY'])
        expect(yield* f.persisted).not.toMatchObject({ attr: { status: 'registered' } })
      }),
      f.options,
    ).pipe(Effect.provideService(AlchemyContext, f.context))
  }),
)
