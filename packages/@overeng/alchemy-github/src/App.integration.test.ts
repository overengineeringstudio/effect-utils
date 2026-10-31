// Alchemy's Test/Core engine intentionally exposes generic error/service channels.
/** @effect-diagnostics anyUnknownInErrorContext:off */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fromToken } from '@alchemy.run/github/Credentials'
import { it } from '@effect/vitest'
import { AlchemyContext } from 'alchemy/AlchemyContext'
import { State } from 'alchemy/State'
import { encodeState } from 'alchemy/State/StateEncoding'
import { scratchStack, toEffect } from 'alchemy/Test/Core'
import { Clock, Deferred, Effect, Fiber, Layer, Logger, Redacted, Schema } from 'effect'
import sodium, {
  ready,
  from_base64,
  to_base64,
  base64_variants,
  to_string,
} from 'libsodium-wrappers'
import { expect } from 'vitest'

import { App, deleteApp, diffApp, readAppState, reconcileApp, type AppProps } from './App.ts'
import { fromPrompt } from './ManifestCodeSource.ts'
import { providers as githubProviders } from './Providers.ts'
import { SecretSource } from './SecretSource.ts'

const Json = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeSync(Json)
const decodeSecret = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ encrypted_value: Schema.String, key_id: Schema.String })),
)
const manifest: AppProps['manifest'] = {
  name: 'Example App',
  url: 'https://example.com',
  redirectUrl: 'https://example.com/callback',
  permissions: { contents: 'read' },
  events: ['push'],
}

const fixture = (environment?: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(async () => {
      await ready
    })
    const pair = sodium.crypto_box_keypair()
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const now = yield* Clock.currentTimeMillis
    const state = {
      conversionCalls: 0,
      conversionStatus: 201,
      invalidPem: false,
      writeCalls: 0,
      writeStatus: 201,
      secretStatus: 200,
      contents: '',
      seen: [] as string[],
      permission: 'read',
      secretName: 'APP_PRIVATE_KEY',
      updatedAt: new Date(now - 10_000).toISOString(),
    }
    const metadata = () => ({
      id: 123,
      slug: 'example-app',
      client_id: 'Iv1.example',
      owner: { login: 'example' },
      permissions: { contents: state.permission, metadata: 'read' },
      events: ['push'],
    })
    const server = createServer(async (request, response) => {
      const path = (request.url ?? '').replace(/^\/api/, '')
      state.seen.push(`${request.method} ${path}`)
      response.setHeader('content-type', 'application/json')
      if (path.endsWith('/public-key') === true) {
        response.end(
          encodeJson({
            key_id: 'key-1',
            key: to_base64(pair.publicKey, base64_variants.ORIGINAL),
          }),
        )
      } else if (path === '/app-manifests/one-use-code/conversions' && request.method === 'POST') {
        state.conversionCalls++
        response.statusCode = state.conversionStatus
        if (state.conversionStatus !== 201) {
          response.end(encodeJson({ message: `Invalid or consumed code: ${pem}` }))
          return
        }
        response.end(
          encodeJson({
            ...metadata(),
            pem: state.invalidPem === true ? 'invalid-private-key' : pem,
            client_secret: 'discard-client-secret',
            webhook_secret: 'discard-hook-secret',
          }),
        )
      } else if (path.endsWith('/APP_PRIVATE_KEY') === true && request.method === 'PUT') {
        state.writeCalls++
        if (state.writeStatus < 400) state.updatedAt = new Date(now).toISOString()
        let body = ''
        for await (const chunk of request) body += chunk.toString()
        const sealed = decodeSecret(body)
        state.contents = to_string(
          sodium.crypto_box_seal_open(
            from_base64(sealed.encrypted_value, base64_variants.ORIGINAL),
            pair.publicKey,
            pair.privateKey,
          ),
        )
        response.statusCode = state.writeStatus
        // Deliberately echo secrets in the failing response: none may survive in the error.
        response.end(
          encodeJson(
            state.writeStatus >= 400
              ? { message: pem, client_secret: 'discard-client-secret' }
              : {},
          ),
        )
      } else if (path.endsWith('/APP_PRIVATE_KEY') === true && request.method === 'GET') {
        response.statusCode = state.secretStatus
        response.end(
          encodeJson({
            name: state.secretName,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: state.updatedAt,
          }),
        )
      } else if (path === '/apps/example-app') {
        response.end(encodeJson(metadata()))
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
    }).pipe(
      Layer.merge(
        fromPrompt((state) => Effect.succeed({ state, code: Redacted.make('one-use-code') })),
      ),
    )
    const props: AppProps = {
      owner: 'example',
      manifest,
      privateKeySecret: {
        owner: 'example',
        repository: 'repo',
        name: 'APP_PRIVATE_KEY',
        ...(environment === undefined ? {} : { environment }),
      },
    }
    const pending = yield* reconcileApp(props).pipe(Effect.provide(credentials))
    if (pending.status !== 'pending') return yield* Effect.die('Expected pending manifest')
    state.seen.length = 0
    const converting: AppProps = {
      ...props,
      conversion: { state: pending.state },
    }
    return {
      state,
      pem,
      credentials,
      props,
      converting,
      pending,
      baseUrl: `http://127.0.0.1:${address.port}/api`,
    }
  })

for (const environment of [undefined, 'production']) {
  it.effect(
    `converts and seals directly to ${environment ?? 'repository'} Actions secret without returning PEM`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(environment)
        const logs: string[] = []
        const logger = Logger.make((entry) => {
          logs.push(encodeJson(entry.message))
        })
        const result = yield* reconcileApp(f.converting, f.pending).pipe(
          Effect.tap((output) => Effect.log(output)),
          Effect.provide(
            Layer.mergeAll(f.credentials, Logger.layer([logger], { mergeWithExisting: false })),
          ),
        )
        expect(result.status).toBe('registered')
        if (result.status !== 'registered') return yield* Effect.die('Expected registration')
        expect(result.appId).toBe(123)
        expect(result.integrationId).toBe(123)
        expect(result.keyFingerprint).toMatch(/^[a-f0-9]{64}$/)
        expect(result.privateKeySecret).toMatchObject({
          name: 'APP_PRIVATE_KEY',
          scope: environment === undefined ? 'repository' : 'environment',
          updatedAt: f.state.updatedAt,
        })
        expect(f.state.contents).toBe(f.pem)
        expect(f.state.conversionCalls).toBe(1)
        expect(f.state.writeCalls).toBe(1)
        expect(f.state.seen[0]).toBe(
          `GET /repos/example/repo/${environment === undefined ? 'actions' : 'environments/production'}/secrets/APP_PRIVATE_KEY`,
        )
        const serialized = encodeJson(result)
        expect(serialized).not.toContain('PRIVATE KEY')
        expect(serialized).not.toContain('discard-client-secret')
        expect(serialized).not.toContain('discard-hook-secret')
        const state = encodeJson(encodeState({ props: f.converting, attr: result }))
        expect(state).not.toContain(f.pem)
        expect(state).not.toContain('PRIVATE KEY')
        expect(logs.join('\n')).not.toContain('PRIVATE KEY')
      }),
  )
}

it.effect(
  'returns sanitized manual-recovery error after one-use conversion and a failed sink',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      f.state.writeStatus = 403
      const error = yield* reconcileApp(f.converting, f.pending).pipe(
        Effect.provide(f.credentials),
        Effect.flip,
      )
      expect(error._tag).toBe('AppConversionRecoveryError')
      const serialized = encodeJson(error)
      expect(serialized).not.toContain('PRIVATE KEY')
      expect(serialized).not.toContain('discard-client-secret')
      expect(serialized).not.toContain('one-use-code')
      expect(serialized).toContain('revoke')
      expect(f.state.conversionCalls).toBe(1)
      expect(f.state.writeCalls).toBe(1)
    }),
)

it.effect('recovers post-conversion drift by adoption without replaying the consumed code', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    f.state.permission = 'write'
    const drift = yield* reconcileApp(f.converting, f.pending).pipe(
      Effect.provide(f.credentials),
      Effect.flip,
    )
    expect(drift._tag).toBe('AppManifestDriftError')
    if (drift._tag !== 'AppManifestDriftError') return yield* Effect.die('Expected typed drift')
    expect(drift.permissions).toContainEqual({
      permission: 'contents',
      desired: 'read',
      observed: 'write',
    })
    expect(drift.remedy).toContain('example-app')
    expect(drift.remedy).toContain('remove conversion')
    expect(drift.remedy).toContain('adopt:')
    expect(encodeJson(drift)).not.toContain(f.pem)
    expect(f.state.contents).toBe(f.pem)
    const retry = yield* reconcileApp(f.converting, f.pending).pipe(
      Effect.provide(f.credentials),
      Effect.flip,
    )
    expect(retry._tag).toBe('AppConversionRecoveryError')
    expect(f.state.conversionCalls).toBe(1)
    expect(f.state.writeCalls).toBe(1)
    f.state.permission = 'read'
    const recovered = yield* reconcileApp(
      { ...f.props, adopt: { slug: 'example-app' } },
      f.pending,
    ).pipe(Effect.provide(f.credentials))
    expect(recovered.status).toBe('registered')
    expect(f.state.conversionCalls).toBe(1)
    expect(encodeJson(recovered)).not.toContain(f.pem)
  }),
)

it.effect('rejects expired codes and wrong callback states before any HTTP request', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const expired = { ...f.pending, expiresAt: 0 }
    const error = yield* reconcileApp(f.converting, expired).pipe(
      Effect.provide(f.credentials),
      Effect.flip,
    )
    expect(error._tag).toBe('GitHubAppResourceError')
    const mismatch = {
      ...f.converting,
      conversion: { state: 'wrong' },
    }
    yield* reconcileApp(mismatch, f.pending).pipe(Effect.provide(f.credentials), Effect.flip)
    expect(f.state.seen).toEqual([])
  }),
)

for (const skew of [-86_400_000, 86_400_000]) {
  it.effect(`converts an unchanged existing secret despite local starting-clock skew ${skew}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      expect(f.pending.secretBaseline).toBe(f.state.updatedAt)
      const result = yield* reconcileApp(f.converting, {
        ...f.pending,
        startedAt: f.pending.startedAt + skew,
      }).pipe(Effect.provide(f.credentials))
      expect(result.status).toBe('registered')
      expect(f.state.conversionCalls).toBe(1)
    }),
  )
}

it.effect('refuses a changed GitHub secret baseline without assuming an App exists', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    f.state.updatedAt = '2030-01-01T00:00:00Z'
    const error = yield* reconcileApp(f.converting, f.pending).pipe(
      Effect.provide(f.credentials),
      Effect.flip,
    )
    expect(error._tag).toBe('AppConversionRecoveryError')
    expect(encodeJson(error)).toContain('if an App was created')
    expect(encodeJson(error)).toContain('otherwise')
    expect(encodeJson(error)).toContain('new form')
    expect(f.state.conversionCalls).toBe(0)
  }),
)

for (const status of [404, 422]) {
  it.effect(`maps GitHub conversion rejection ${status} to sanitized typed recovery`, () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      f.state.conversionStatus = status
      const error = yield* reconcileApp(f.converting, f.pending).pipe(
        Effect.provide(f.credentials),
        Effect.flip,
      )
      expect(error._tag).toBe('AppConversionRecoveryError')
      expect(encodeJson(error)).not.toContain(f.pem)
      expect(encodeJson(error)).not.toContain('one-use-code')
      expect(f.state.conversionCalls).toBe(1)
      expect(f.state.writeCalls).toBe(0)
    }),
  )
}

it.effect('adopts metadata without conversion or key access and reports typed live drift', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const adopting: AppProps = {
      ...f.props,
      adopt: { slug: 'example-app', appId: 123, installationId: 456 },
    }
    const registered = yield* reconcileApp(adopting).pipe(Effect.provide(f.credentials))
    expect(registered).toMatchObject({ status: 'registered', appId: 123, installationId: 456 })
    expect(registered).not.toHaveProperty('keyFingerprint')
    expect(f.state.conversionCalls).toBe(0)
    expect(f.state.writeCalls).toBe(0)
    f.state.permission = 'write'
    const drift = yield* reconcileApp(adopting, registered).pipe(
      Effect.provide(f.credentials),
      Effect.flip,
    )
    expect(drift._tag).toBe('AppManifestDriftError')
    expect(drift).toMatchObject({
      permissions: [{ permission: 'contents', desired: 'read', observed: 'write' }],
    })
  }),
)

it.effect('refuses adoption when the declared Actions secret is missing', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    f.state.secretStatus = 404
    const error = yield* reconcileApp({ ...f.props, adopt: { slug: 'example-app' } }).pipe(
      Effect.provide(f.credentials),
      Effect.flip,
    )
    expect(error._tag).toBe('GitHubAppResourceError')
    expect(f.state.seen).toHaveLength(1)
  }),
)

it.effect('resumes the same pending form and refreshes only after its hour expires', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const resumed = yield* reconcileApp(f.props, f.pending).pipe(Effect.provide(f.credentials))
    expect(resumed).toEqual(f.pending)
    expect(f.state.seen).toEqual([])
    expect(f.pending.manifestHtml).toContain('method="post"')
    expect(f.pending.expiresAt - f.pending.startedAt).toBe(3_600_000)
    const refreshed = yield* reconcileApp(f.props, { ...f.pending, expiresAt: 0 }).pipe(
      Effect.provide(f.credentials),
    )
    expect(refreshed.status).toBe('pending')
    if (refreshed.status !== 'pending') return yield* Effect.die('Expected pending form')
    expect(refreshed.state).not.toBe(f.pending.state)
    expect(f.state.seen).toEqual(['GET /repos/example/repo/actions/secrets/APP_PRIVATE_KEY'])
    expect(refreshed.secretBaseline).toBe(f.state.updatedAt)
  }),
)

it.effect(
  'persists an absent sink baseline and rejects later secret creation before conversion',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      f.state.secretStatus = 404
      const pending = yield* reconcileApp(f.props, { ...f.pending, expiresAt: 0 }).pipe(
        Effect.provide(f.credentials),
      )
      if (pending.status !== 'pending') return yield* Effect.die('Expected pending form')
      expect(pending.secretBaseline).toBeNull()
      f.state.secretStatus = 200
      const error = yield* reconcileApp(
        {
          ...f.converting,
          conversion: { state: pending.state },
        },
        pending,
      ).pipe(Effect.provide(f.credentials), Effect.flip)
      expect(error._tag).toBe('AppConversionRecoveryError')
      expect(f.state.conversionCalls).toBe(0)
    }),
)

it.effect(
  'sinks the one-time key even when the owner changed manifest permissions in the browser',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      f.state.permission = 'write'
      const error = yield* reconcileApp(f.converting, f.pending).pipe(
        Effect.provide(f.credentials),
        Effect.flip,
      )
      expect(error._tag).toBe('AppManifestDriftError')
      expect(f.state.writeCalls).toBe(1)
      expect(f.state.contents).toBe(f.pem)
      expect(encodeJson(error)).not.toContain('PRIVATE KEY')
    }),
)

it.effect('observes secret timestamp drift and removes a stale key fingerprint', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const registered = yield* reconcileApp(f.converting, f.pending).pipe(
      Effect.provide(f.credentials),
    )
    expect(registered.status).toBe('registered')
    f.state.updatedAt = '2026-02-01T00:00:00Z'
    const observed = yield* reconcileApp(f.props, registered).pipe(Effect.provide(f.credentials))
    expect(observed).not.toHaveProperty('keyFingerprint')
    expect(observed).toMatchObject({ privateKeySecret: { updatedAt: f.state.updatedAt } })
  }),
)

it.effect('refuses mismatched secret metadata names', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    f.state.secretName = 'DIFFERENT_KEY'
    const error = yield* reconcileApp({ ...f.props, adopt: { slug: 'example-app' } }).pipe(
      Effect.provide(f.credentials),
      Effect.flip,
    )
    expect(error._tag).toBe('GitHubAppResourceError')
    expect(f.state.conversionCalls).toBe(0)
  }),
)

it.effect(
  'observes remote drift before a no-op plan and accepts browser-remedied declarations',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const registered = yield* reconcileApp(f.converting, f.pending).pipe(
        Effect.provide(f.credentials),
      )
      f.state.permission = 'write'
      const observed = yield* readAppState(f.props, registered).pipe(Effect.provide(f.credentials))
      expect(observed).toMatchObject({ permissions: { contents: 'write' } })
      const drift = yield* diffApp(f.props, observed, f.props).pipe(
        Effect.provide(f.credentials),
        Effect.flip,
      )
      expect(drift._tag).toBe('AppManifestDriftError')
      const desired: AppProps = {
        ...f.props,
        manifest: { ...f.props.manifest, permissions: { contents: 'write' } },
      }
      yield* diffApp(desired, observed, f.props).pipe(Effect.provide(f.credentials))
      const reconciled = yield* reconcileApp(desired, observed, f.props).pipe(
        Effect.provide(f.credentials),
      )
      expect(reconciled).toMatchObject({ permissions: { contents: 'write' } })
      f.state.secretStatus = 404
      const missing = yield* readAppState(desired, reconciled).pipe(
        Effect.provide(f.credentials),
        Effect.flip,
      )
      expect(missing._tag).toBe('GitHubAppResourceError')
    }),
)

it.effect(
  'plans conversion and expiration updates while keeping unchanged pending plans stable',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      expect(yield* readAppState(f.props, f.pending).pipe(Effect.provide(f.credentials))).toEqual(
        f.pending,
      )
      expect(
        yield* diffApp(f.props, f.pending, f.props).pipe(Effect.provide(f.credentials)),
      ).toBeUndefined()
      expect(
        yield* diffApp(f.converting, f.pending, f.props).pipe(Effect.provide(f.credentials)),
      ).toEqual({ action: 'update' })
      expect(
        yield* diffApp(f.props, { ...f.pending, expiresAt: 0 }, f.props).pipe(
          Effect.provide(f.credentials),
        ),
      ).toEqual({ action: 'update' })
      expect(f.state.seen).toEqual([])
    }),
)

it.effect(
  'allows pending removal but fails closed for registered deletion unless explicitly orphaned',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* deleteApp(f.props, f.pending)
      const registered = yield* reconcileApp(f.converting, f.pending).pipe(
        Effect.provide(f.credentials),
      )
      const error = yield* deleteApp(f.props, registered).pipe(Effect.flip)
      expect(error._tag).toBe('GitHubAppResourceError')
      yield* deleteApp({ ...f.props, destroy: 'orphan' }, registered)
      expect(f.state.seen.some((request) => request.startsWith('DELETE'))).toBe(false)
    }),
)

for (const outcome of ['interrupt-before-post', 'fail-before-put', 'success'] as const) {
  it.effect(`real engine keeps manifest code ephemeral: ${outcome}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), 'app-code-engine-'))),
        (path) => Effect.promise(() => rm(path, { recursive: true })),
      )
      const reached = yield* Deferred.make<void>()
      const code = 'one-use-code'
      let reads = 0
      const providers = githubProviders({
        secretSource: Layer.succeed(SecretSource, {
          read: () => Effect.die('App conversion must not read ActionsSecret sources'),
        }),
        manifestCodeSource: fromPrompt((state) =>
          Effect.gen(function* () {
            reads++
            yield* Deferred.succeed(reached, undefined)
            if (outcome === 'interrupt-before-post') return yield* Effect.never
            return { state, code: Redacted.make(code) }
          }),
        ),
      }).pipe(Layer.merge(fromToken('fixture-token', { baseUrl: f.baseUrl })))
      const options = { providers, stage: 'test', dev: false, sidecar: false }
      const stack = scratchStack(options, 'app-code-engine')
      const program = (props: AppProps) => App('App', props)
      const persisted = Effect.gen(function* () {
        const store = yield* yield* State
        return yield* store.get({ stack: stack.name, stage: stack.stage, fqn: 'App' })
      }).pipe(Effect.provide(stack.state))
      yield* toEffect(
        Effect.gen(function* () {
          yield* stack.deploy(program(f.props))
          const row = yield* persisted
          if (row?.kind === 'action' || row?.attr?.status !== 'pending')
            return yield* Effect.die('Expected durable pending form')
          const converting: AppProps = { ...f.props, conversion: { state: row.attr.state } }
          yield* stack.plan(program(converting))
          expect(reads).toBe(0)
          f.state.invalidPem = outcome === 'fail-before-put'
          if (outcome === 'interrupt-before-post') {
            const fiber = yield* Effect.forkChild(stack.deploy(program(converting)))
            yield* Deferred.await(reached)
            yield* Fiber.interrupt(fiber)
          } else if (outcome === 'fail-before-put') {
            const result = yield* stack.deploy(program(converting)).pipe(Effect.exit)
            expect(result._tag).toBe('Failure')
          } else {
            yield* stack.deploy(program(converting))
          }
          const after = yield* persisted
          if (after === undefined || after.kind === 'action')
            return yield* Effect.die('Expected persisted resource')
          const encoded = encodeJson(encodeState(after))
          for (let offset = 0; offset <= code.length - 8; offset++)
            expect(encoded).not.toContain(code.slice(offset, offset + 8))
          expect(encoded).not.toContain(f.pem)
          expect(after?.props).not.toHaveProperty('conversion.code')
          expect(f.state.conversionCalls).toBe(outcome === 'interrupt-before-post' ? 0 : 1)
          expect(f.state.writeCalls).toBe(outcome === 'success' ? 1 : 0)
          if (outcome === 'success') {
            expect(after?.attr).toMatchObject({ status: 'registered', appId: 123 })
            expect(f.state.contents).toBe(f.pem)
          } else {
            expect(after?.attr).toMatchObject({
              status: 'pending',
              state: row.attr.state,
              secretBaseline: row.attr.secretBaseline,
            })
          }
        }),
        { ...options, state: stack.state },
      ).pipe(
        Effect.provideService(AlchemyContext, { dotAlchemy: directory, dev: false, adopt: false }),
      )
    }),
  )
}
