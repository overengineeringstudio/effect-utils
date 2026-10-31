// The real Alchemy test runtime intentionally retains the engine's generic channels.
/** @effect-diagnostics anyUnknownInErrorContext:off */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { it } from '@effect/vitest'
import { AlchemyContext } from 'alchemy/AlchemyContext'
import { apply } from 'alchemy/Apply'
import { isResolved } from 'alchemy/Diff'
import * as Plan from 'alchemy/Plan'
import * as Provider from 'alchemy/Provider'
import { Resource } from 'alchemy/Resource'
import * as Stack from 'alchemy/Stack'
import { Stage } from 'alchemy/Stage'
import { State } from 'alchemy/State'
import { deploy, destroy, toEffect } from 'alchemy/Test/Core'
import {
  Clock,
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Redacted,
  Schema,
} from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as TestClock from 'effect/testing/TestClock'
import { expect } from 'vitest'

import { githubRepoState } from './RepoState.ts'
import { githubActionsOidc, RepoStateCredentials } from './RepoStateCredentials.ts'

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeExchange = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String })),
)
const prefix = 'alchemy/v1/example/project/'
const bucket = 'repository-state'
const actionsToken = 'fixture-actions-bearer-do-not-log'
const oidcToken = 'fixture-oidc-jwt-do-not-log'
const secretKey = 'fixture-secret-access-key-do-not-log'
const accessKey = (generation: number) => `fixture-access-key-${generation}`
const sessionToken = (generation: number) => `fixture-session-token-${generation}`

class FixtureProviders extends Provider.ProviderCollection<FixtureProviders>()(
  'RepoState.Fixtures',
) {}
type FixtureResource = Resource<
  'RepoState.Fixture',
  { value: string },
  { value: string },
  never,
  FixtureProviders
>
const FixtureResource = Resource<FixtureResource>('RepoState.Fixture')

/** A socket-level S3 fixture: no mocked State, bucket objects, broker, or HTTP responses. */
const fixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'alchemy-repo-state-'))),
    (path) => Effect.promise(() => rm(path, { recursive: true })),
  )
  const context = { dotAlchemy: directory, dev: false, adopt: false }
  const live = {
    objects: new Map<string, { body: string; etag: string }>(),
    requests: [] as { method: string; key: string; status: number; conditional: boolean }[],
    signatureFailures: [] as string[],
    credentialGenerations: [] as number[],
    brokerCalls: 0,
    oidcCalls: 0,
    writes: 0,
    brokerStatus: 200,
    storageStatus: 200,
    brokerPrefix: prefix,
    redirectPhase: '',
    redirectStatus: 307,
    redirectedRequests: 0,
    redirectResponses: 0,
    // Tests set this from Effect Clock, never wall-clock sleeps.
    now: yield* Clock.currentTimeMillis,
    origin: '',
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    response.setHeader('content-type', 'application/json')
    if (url.pathname === '/redirect-target') {
      live.redirectedRequests++
      response.end('{}')
      return
    }
    const phase =
      url.pathname === '/oidc' ? 'oidc' : url.pathname === '/broker' ? 'broker' : 'storage'
    if (live.redirectPhase === phase) {
      live.redirectResponses++
      response.writeHead(live.redirectStatus, { location: `${live.origin}/redirect-target` }).end()
      return
    }
    if (url.pathname === '/oidc') {
      live.oidcCalls++
      if (
        request.method !== 'GET' ||
        request.headers.authorization !== `Bearer ${actionsToken}` ||
        url.searchParams.get('audience') !== `${live.origin}/broker` ||
        url.searchParams.get('existing') !== 'kept'
      ) {
        response.writeHead(400).end('{}')
        return
      }
      response.end(encodeJson({ value: oidcToken }))
      return
    }
    if (url.pathname === '/broker') {
      live.brokerCalls++
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      if (request.method !== 'POST' || decodeExchange(body).token !== oidcToken) {
        response.writeHead(400).end('{}')
        return
      }
      response.statusCode = live.brokerStatus
      response.end(
        encodeJson(
          live.brokerStatus === 200
            ? {
                accessKeyId: accessKey(live.brokerCalls),
                secretAccessKey: secretKey,
                sessionToken: sessionToken(live.brokerCalls),
                endpoint: 'https://objects.example.com',
                bucket,
                prefix: live.brokerPrefix,
                expiresAt: new Date(live.now + 300_000).toISOString(),
              }
            : { message: `${actionsToken} ${oidcToken} ${secretKey}` },
        ),
      )
      return
    }
    const key = decodeURIComponent(url.pathname.slice(`/${bucket}/`.length))
    const conditional =
      request.headers['if-match'] !== undefined || request.headers['if-none-match'] !== undefined
    const finish = (status: number, body = '') => {
      live.requests.push({ method: request.method ?? '', key, status, conditional })
      response.statusCode = status
      response.end(body)
    }
    const authorization = request.headers.authorization ?? ''
    const generation = Number(/Credential=fixture-access-key-(\d+)\//.exec(authorization)?.[1])
    if (
      url.pathname.startsWith(`/${bucket}/`) === false ||
      authorization.startsWith('AWS4-HMAC-SHA256 ') === false ||
      /\/auto\/s3\/aws4_request, SignedHeaders=.*Signature=[a-f0-9]{64}$/.test(authorization) ===
        false ||
      /^\d{8}T\d{6}Z$/.test(String(request.headers['x-amz-date'])) === false ||
      /^[a-f0-9]{64}$/.test(String(request.headers['x-amz-content-sha256'])) === false ||
      request.headers['x-amz-security-token'] !== sessionToken(generation)
    ) {
      live.signatureFailures.push(`${request.method} ${url.pathname}`)
      finish(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>')
      return
    }
    live.credentialGenerations.push(generation)
    if (live.storageStatus !== 200) {
      finish(
        live.storageStatus,
        `${actionsToken} ${oidcToken} ${secretKey} ${sessionToken(generation)}`,
      )
      return
    }
    if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const requestedPrefix = url.searchParams.get('prefix') ?? ''
      const delimiter = url.searchParams.get('delimiter')
      const entries = new Map<string, 'Key' | 'Prefix'>()
      for (const objectKey of [...live.objects.keys()].toSorted()) {
        if (objectKey.startsWith(requestedPrefix) === false) continue
        const separator = delimiter === '/' ? objectKey.indexOf('/', requestedPrefix.length) : -1
        if (separator === -1) entries.set(objectKey, 'Key')
        else entries.set(objectKey.slice(0, separator + 1), 'Prefix')
      }
      // Deliberately paginate tiny responses to exercise continuation-token handling.
      const offset = Number(url.searchParams.get('continuation-token') ?? '0')
      const page = [...entries].slice(offset, offset + 2)
      const truncated = offset + page.length < entries.size
      response.setHeader('content-type', 'application/xml')
      finish(
        200,
        `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><EncodingType>url</EncodingType><IsTruncated>${truncated}</IsTruncated>${page
          .map(([name, tag]) =>
            tag === 'Key'
              ? `<Contents><Key>${encodeURIComponent(name)}</Key></Contents>`
              : `<CommonPrefixes><Prefix>${encodeURIComponent(name)}</Prefix></CommonPrefixes>`,
          )
          .join(
            '',
          )}${truncated === true ? `<NextContinuationToken>${offset + page.length}</NextContinuationToken>` : ''}</ListBucketResult>`,
      )
      return
    }
    if (key.startsWith(prefix) === false) {
      finish(403)
      return
    }
    const object = live.objects.get(key)
    if (
      (request.headers['if-none-match'] === '*' && object !== undefined) ||
      (request.headers['if-match'] !== undefined && request.headers['if-match'] !== object?.etag)
    ) {
      finish(412)
      return
    }
    if (request.method === 'GET') {
      if (object === undefined) finish(404, '<Error><Code>NoSuchKey</Code></Error>')
      else {
        response.setHeader('etag', object.etag)
        finish(200, object.body)
      }
    } else if (request.method === 'PUT') {
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      if (
        createHash('sha256').update(body).digest('hex') !== request.headers['x-amz-content-sha256']
      ) {
        live.signatureFailures.push('payload hash')
        finish(403)
        return
      }
      const etag = `"version-${++live.writes}"`
      live.objects.set(key, { body, etag })
      response.setHeader('etag', etag)
      finish(200)
    } else if (request.method === 'DELETE') {
      live.objects.delete(key)
      finish(204)
    } else finish(405)
  })
  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections()
          }),
      ),
  )
  const address = server.address()
  if (address === null || typeof address === 'string')
    return yield* Effect.die('Expected TCP fixture')
  live.origin = `http://127.0.0.1:${address.port}`
  // Preserve production HTTPS endpoint validation. Only this fixture's transport
  // redirects its fictional storage origin onto the real local socket server.
  const transport = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      HttpClient.mapRequest(client, (request) =>
        request.url.startsWith('https://objects.example.com/') === true
          ? HttpClientRequest.setUrl(
              request,
              request.url.replace('https://objects.example.com', live.origin),
            )
          : request,
      ),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer))
  const credentials = githubActionsOidc({ brokerUrl: `${live.origin}/broker` }).pipe(
    Layer.provide(transport),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ACTIONS_ID_TOKEN_REQUEST_URL: `${live.origin}/oidc?existing=kept`,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: actionsToken,
        }),
      ),
    ),
  )
  const state = githubRepoState().pipe(Layer.provide(credentials), Layer.provide(transport))
  const provider = Provider.succeed(FixtureResource, {
    list: () => Effect.succeed([]),
    read: ({ output }) => Effect.succeed(output),
    diff: ({ news, output }) =>
      Effect.succeed(
        isResolved(news) === true && news.value !== output?.value
          ? { action: 'update' as const }
          : undefined,
      ),
    reconcile: ({ news }) => Effect.succeed({ value: news.value }),
    delete: () => Effect.void,
  })
  const providers = Layer.effect(FixtureProviders, Provider.collection([FixtureResource])).pipe(
    Layer.provide(provider),
  )
  const options = { state, providers, stage: 'test', dev: false, sidecar: false }
  const program = (value: string) =>
    Effect.gen(function* () {
      const resource = yield* FixtureResource('Object', { value })
      yield* FixtureResource('Other', { value: 'unchanged' })
      return { value: resource.value }
    })
  const compiled = (value: string) =>
    program(value).pipe(
      Stack.make({ name: 'repo-state-fixture', state, providers }),
      Effect.provideService(Stage, 'test'),
    )
  const inspect = Effect.gen(function* () {
    const store = yield* yield* State
    return {
      row: yield* store.get({ stack: 'repo-state-fixture', stage: 'test', fqn: 'Object' }),
      output: yield* store.getOutput({ stack: 'repo-state-fixture', stage: 'test' }),
      stacks: yield* store.listStacks(),
      stages: yield* store.listStages('repo-state-fixture'),
      resources: yield* store.list({ stack: 'repo-state-fixture', stage: 'test' }),
    }
  }).pipe(Effect.provide(state))
  const secrets = () => [
    actionsToken,
    oidcToken,
    secretKey,
    ...Array.from({ length: live.brokerCalls }, (_, index) => [
      accessKey(index + 1),
      sessionToken(index + 1),
    ]).flat(),
  ]
  const assertNoSecrets = (value: unknown) => {
    const encoded = encodeJson(value)
    for (const secret of secrets()) expect(encoded).not.toContain(secret)
  }
  return {
    live,
    state,
    credentials,
    transport,
    options,
    compiled,
    inspect,
    assertNoSecrets,
    context,
  }
})

it.effect(
  'real Plan/Deploy persists resource state and outputs across independent R2 clients',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const logs: unknown[] = []
      const logger = Logger.make((entry) => {
        logs.push(entry.message)
      })
      yield* toEffect(deploy(f.options, f.compiled('first')), f.options).pipe(
        Effect.provideService(AlchemyContext, f.context),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      )
      expect((yield* f.inspect).row).toMatchObject({
        props: { value: 'first' },
        attr: { value: 'first' },
      })
      expect((yield* f.inspect).output).toEqual({ value: 'first' })
      const plan = yield* toEffect(
        Effect.gen(function* () {
          const compiled = yield* f.compiled('first')
          return yield* Plan.make(compiled, {}).pipe(Effect.provide(compiled.services))
        }),
        f.options,
      ).pipe(Effect.provideService(AlchemyContext, f.context))
      expect(plan.resources.Object?.action).toBe('noop')
      expect(
        yield* toEffect(deploy(f.options, f.compiled('second')), f.options).pipe(
          Effect.provideService(AlchemyContext, f.context),
        ),
      ).toEqual({
        value: 'second',
      })
      const persisted = yield* f.inspect
      expect(persisted).toMatchObject({
        row: { props: { value: 'second' }, attr: { value: 'second' } },
        output: { value: 'second' },
        stacks: ['repo-state-fixture'],
        stages: ['test'],
        resources: ['Object', 'Other'],
      })
      expect(f.live.objects.has(`${prefix}repo-state-fixture/test/__lease__.json`)).toBe(false)
      expect(
        f.live.requests.some((request) => request.method === 'DELETE' && request.conditional),
      ).toBe(true)
      expect(f.live.signatureFailures).toEqual([])
      f.assertNoSecrets([...f.live.objects.values(), logs])
      yield* toEffect(destroy(f.options, f.compiled('second')), f.options).pipe(
        Effect.provideService(AlchemyContext, f.context),
      )
      expect(yield* f.inspect).toEqual({
        row: undefined,
        output: undefined,
        // Reading output acquires a new lease until this inspection scope closes.
        stacks: ['repo-state-fixture'],
        stages: ['test'],
        resources: [],
      })
      expect(f.live.objects.size).toBe(0)
    }),
)

it.effect('concurrent real applies cannot acquire the same repository state lease', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const held = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const holder = yield* toEffect(
      Effect.gen(function* () {
        const compiled = yield* f.compiled('holder')
        yield* Plan.make(compiled, {}).pipe(
          Effect.flatMap(apply),
          Effect.provide(compiled.services),
        )
        yield* Deferred.succeed(held, undefined)
        yield* Deferred.await(release)
      }),
      f.options,
    ).pipe(Effect.provideService(AlchemyContext, f.context), Effect.forkChild)
    yield* Deferred.await(held)
    const before = [...f.live.objects.entries()]
    const error = yield* toEffect(deploy(f.options, f.compiled('contender')), f.options).pipe(
      Effect.provideService(AlchemyContext, f.context),
      Effect.flip,
    )
    expect(error).toMatchObject({ _tag: 'StateStoreError' })
    expect(String(error)).toContain('another deploy holds')
    expect([...f.live.objects.entries()]).toEqual(before)
    expect(
      f.live.requests.some(
        (request) => request.method === 'PUT' && request.status === 412 && request.conditional,
      ),
    ).toBe(true)
    f.assertNoSecrets(error)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    expect(
      yield* toEffect(deploy(f.options, f.compiled('after-release')), f.options).pipe(
        Effect.provideService(AlchemyContext, f.context),
      ),
    ).toEqual({
      value: 'after-release',
    })
    expect((yield* f.inspect).output).toEqual({ value: 'after-release' })
    expect(f.live.signatureFailures).toEqual([])
  }),
)

it.effect(
  'refreshes broker credentials before expiry and signs subsequent real HTTP state reads with the new session',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* Effect.gen(function* () {
        const credentials = yield* RepoStateCredentials
        const first = yield* credentials.get
        expect(Redacted.value(first.accessKeyId)).toBe(accessKey(1))
        const store = yield* yield* State
        yield* store.getOutput({ stack: 'repo-state-fixture', stage: 'test' })
        expect(f.live.brokerCalls).toBe(1)
        yield* TestClock.adjust('239 seconds')
        f.live.now += 239_000
        yield* store.getOutput({ stack: 'repo-state-fixture', stage: 'test' })
        expect(f.live.brokerCalls).toBe(1)
        yield* TestClock.adjust('1 second')
        f.live.now += 1_000
        yield* store.getOutput({ stack: 'repo-state-fixture', stage: 'test' })
        expect(f.live.brokerCalls).toBe(2)
        expect(f.live.oidcCalls).toBe(2)
        // Lease checks and renewal add requests; every request after rotation must use session 2.
        expect(f.live.credentialGenerations[0]).toBe(1)
        expect(f.live.credentialGenerations.at(-1)).toBe(2)
        const rotation = f.live.credentialGenerations.indexOf(2)
        expect(rotation).toBeGreaterThan(0)
        expect(
          f.live.credentialGenerations.slice(rotation).every((generation) => generation === 2),
        ).toBe(true)
        f.assertNoSecrets([first, yield* credentials.get])
        expect(f.live.signatureFailures).toEqual([])
      }).pipe(
        Effect.provide(
          githubRepoState().pipe(Layer.provideMerge(f.credentials), Layer.provide(f.transport)),
        ),
      )
    }),
)

it.effect('sanitizes credential-bearing storage failures without persisting credentials', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    f.live.storageStatus = 403
    const error = yield* f.inspect.pipe(Effect.flip)
    expect(error).toMatchObject({ _tag: 'StateStoreError' })
    expect(String(error)).toContain('GitHub repository state')
    f.assertNoSecrets(error)
    expect(f.live.objects.size).toBe(0)
  }),
)

it.effect('sanitizes a real broker failure before issuing any storage request', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    f.live.brokerStatus = 503
    const error = yield* RepoStateCredentials.use((credentials) => credentials.get).pipe(
      Effect.provide(f.credentials),
      Effect.flip,
    )
    expect(error).toMatchObject({ _tag: 'RepoStateError', operation: 'credential-acquisition' })
    f.assertNoSecrets(error)
    expect(f.live.oidcCalls).toBe(1)
    expect(f.live.brokerCalls).toBe(1)
    expect(f.live.requests).toEqual([])
    expect(f.live.objects.size).toBe(0)
  }),
)

for (const phase of ['oidc', 'broker', 'storage'] as const) {
  for (const status of [301, 302, 303, 307, 308]) {
    it.effect(`rejects ${status} ${phase} redirects without forwarding credentials`, () =>
      Effect.gen(function* () {
        const f = yield* fixture
        f.live.redirectPhase = phase
        f.live.redirectStatus = status
        const result =
          phase === 'storage'
            ? yield* f.inspect.pipe(Effect.flip)
            : yield* RepoStateCredentials.use((credentials) => credentials.get).pipe(
                Effect.provide(f.credentials),
                Effect.flip,
              )
        expect(result).toMatchObject({
          _tag: phase === 'storage' ? 'StateStoreError' : 'RepoStateError',
        })
        expect(f.live.redirectResponses).toBe(1)
        expect(f.live.redirectedRequests).toBe(0)
        expect(f.live.objects.size).toBe(0)
        f.assertNoSecrets(result)
      }),
    )
  }
}

for (const invalidPrefix of [
  'alchemy/v1/../project/',
  'alchemy/v1/example/./',
  'alchemy/v1/%2e%2e/project/',
  'alchemy/v1/example/%2E%2E/',
  'alchemy/v1/example/a%2fb/',
  'alchemy/v1/ex ample/project/',
]) {
  it.effect(`rejects unsafe broker prefix ${invalidPrefix}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture
      f.live.brokerPrefix = invalidPrefix
      const error = yield* RepoStateCredentials.use((credentials) => credentials.get).pipe(
        Effect.provide(f.credentials),
        Effect.flip,
      )
      expect(error).toMatchObject({ _tag: 'RepoStateError' })
      expect(f.live.requests).toEqual([])
      f.assertNoSecrets(error)
    }),
  )
}

it.effect(
  'rejects dot-segment keys and preserves literal percent-encoded dot names inside the prefix',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* Effect.gen(function* () {
        const store = yield* yield* State
        for (const stack of ['.', '..']) {
          const error = yield* store.getOutput({ stack, stage: 'test' }).pipe(Effect.flip)
          expect(error).toMatchObject({ _tag: 'StateStoreError' })
        }
        expect(f.live.requests).toEqual([])
        for (const stack of ['%2e%2e', '%2E%2E', '%2e.', '.%2e']) {
          expect(yield* store.getOutput({ stack, stage: 'test' })).toBeUndefined()
          expect(
            f.live.requests.some((request) => request.key.startsWith(`${prefix}${stack}/`)),
          ).toBe(true)
        }
      }).pipe(Effect.provide(f.state))
      expect(f.live.requests.every((request) => request.key.startsWith(prefix))).toBe(true)
      expect(f.live.signatureFailures).toEqual([])
    }),
)
