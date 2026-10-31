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
import { encodeState } from 'alchemy/State/StateEncoding'
import { scratchStack, toEffect } from 'alchemy/Test/Core'
import { Effect, Layer, Logger, Schema } from 'effect'
import sodium, {
  ready,
  to_base64,
  from_base64,
  base64_variants,
  to_string,
} from 'libsodium-wrappers'
import { expect } from 'vitest'

import { ActionsError } from './ActionsCommon.ts'
import { ActionsSecret, ActionsSecretProvider, type ActionsSecretProps } from './ActionsSecret.ts'
import { Providers } from './Providers.ts'
import { SecretSource } from './SecretSource.ts'

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodePut = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ encrypted_value: Schema.String, key_id: Schema.String })),
)
const fixture = (environment?: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => ready)
    const pair = sodium.crypto_box_keypair()
    const secret = 'sensitive-secret-test-sentinel'
    const hashKey = 'sensitive-hmac-test-sentinel'
    const state = {
      value: secret,
      exists: false,
      updated: '2026-01-01T00:00:00Z',
      reads: 0,
      puts: 0,
      deletes: 0,
      reject: false,
      failSource: false,
      sink: '',
      buffers: [] as Uint8Array[],
      logs: [] as string[],
    }
    const path = `/repos/example/repo/${environment === undefined ? 'actions' : `environments/${environment}`}/secrets`
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json')
      const url = (req.url ?? '').replace(/^\/api\/v3/, '')
      if (req.method === 'GET' && url === `${path}/public-key`)
        return res.end(
          encode({
            key: to_base64(pair.publicKey, base64_variants.ORIGINAL),
            key_id: 'fixture-public-key',
          }),
        )
      if (url !== `${path}/EXAMPLE_SECRET`) {
        res.statusCode = 404
        return res.end('{}')
      }
      if (req.method === 'GET') {
        res.statusCode = state.exists === true ? 200 : 404
        return res.end(encode({ name: 'EXAMPLE_SECRET', updated_at: state.updated }))
      }
      if (req.method === 'DELETE') {
        state.deletes++
        state.exists = false
        res.statusCode = 204
        return res.end()
      }
      if (req.method === 'PUT') {
        state.puts++
        let body = ''
        for await (const chunk of req) body += chunk.toString()
        const sealed = decodePut(body)
        expect(sealed.key_id).toBe('fixture-public-key')
        expect(body).not.toContain(secret)
        state.sink = to_string(
          sodium.crypto_box_seal_open(
            from_base64(sealed.encrypted_value, base64_variants.ORIGINAL),
            pair.publicKey,
            pair.privateKey,
          ),
        )
        state.exists = true
        state.updated = `2026-01-0${state.puts + 1}T00:00:00Z`
        res.statusCode = state.reject === true ? 403 : 201
        return res.end(encode(state.reject === true ? { message: state.value } : {}))
      }
      res.statusCode = 405
      return res.end('{}')
    })
    yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<void>((r) => server.listen(0, '127.0.0.1', r))),
      () => Effect.promise(() => new Promise<void>((r) => server.close(() => r()))),
    )
    const address = server.address()
    if (address === null || typeof address === 'string')
      return yield* Effect.die('Expected TCP fixture')
    const credentials = fromToken('fixture-token', { baseUrl: `http://127.0.0.1:${address.port}` })
    const source = Layer.succeed(SecretSource, {
      read: (handle) =>
        Effect.suspend(() => {
          state.reads++
          if (state.failSource === true)
            return Effect.fail(new ActionsError({ operation: 'read', message: state.value }))
          const bytes = new TextEncoder().encode(
            handle.ref.endsWith('/hash') === true ? hashKey : state.value,
          )
          state.buffers.push(bytes)
          return Effect.succeed(bytes)
        }),
    })
    const logger = Logger.layer([Logger.make((entry) => state.logs.push(encode(entry.message)))], {
      mergeWithExisting: false,
    })
    const providers = Layer.effect(Providers, Provider.collection([ActionsSecret])).pipe(
      Layer.provide(ActionsSecretProvider),
      Layer.provideMerge(credentials),
      Layer.provideMerge(source),
      Layer.provideMerge(logger),
    )
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), 'github-actions-secret-'))),
      (path) => Effect.promise(() => rm(path, { recursive: true })),
    )
    const options = { providers, stage: 'test', dev: false, sidecar: false }
    const stack = scratchStack(options, 'actions-secret')
    const props: ActionsSecretProps = {
      owner: 'example',
      repository: 'repo',
      name: 'EXAMPLE_SECRET',
      ...(environment === undefined ? {} : { environment }),
      value: {
        ref: 'op://aaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbb/value',
        reason: 'Publish declared Actions secret',
      },
      hashKey: {
        ref: 'op://aaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbb/hash',
        reason: 'Compute stack secret drift HMAC',
      },
    }
    const persisted = Effect.gen(function* () {
      const store = yield* yield* State
      const row = yield* store.get({ stack: stack.name, stage: stack.stage, fqn: 'Secret' })
      return row?.kind === 'action' ? undefined : row
    }).pipe(Effect.provide(stack.state))
    const run = <A>(effect: Parameters<typeof toEffect<A>>[0]) =>
      toEffect(effect, { ...options, state: stack.state }).pipe(
        Effect.provideService(AlchemyContext, { dotAlchemy: directory, dev: false, adopt: false }),
      )
    return { state, props, stack, run, persisted, secret, hashKey }
  })
for (const environment of [undefined, 'production']) {
  it.effect(
    `seals to ${environment ?? 'repository'} scope and detects value/outside-write/deletion drift through real engine`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(environment)
        yield* f.run(
          Effect.gen(function* () {
            const program = ActionsSecret('Secret', f.props)
            const deployed = yield* f.stack.deploy(program)
            expect(encode({ deployed })).not.toContain(f.secret)
            expect(encode({ deployed })).not.toContain(f.hashKey)
            yield* Effect.log({ deployed })
            expect(f.state.sink).toBe(f.secret)
            const row = yield* f.persisted
            expect(row?.attr).toMatchObject({
              name: 'EXAMPLE_SECRET',
              scope: environment === undefined ? 'repository' : 'environment',
              hashKeyId: f.props.hashKey?.ref,
            })
            expect(row?.attr?.hash).toMatch(/^[a-f0-9]{64}$/)
            expect(encode(encodeState(row))).not.toContain(f.secret)
            expect(encode(encodeState(row))).not.toContain(f.hashKey)
            expect((yield* f.stack.plan(program)).resources.Secret?.action).toBe('noop')
            f.state.value = 'changed-source-sentinel'
            expect((yield* f.stack.plan(program)).resources.Secret?.action).toBe('update')
            yield* f.stack.deploy(program)
            f.state.updated = '2026-02-01T00:00:00Z'
            expect((yield* f.stack.plan(program)).resources.Secret?.action).toBe('update')
            f.state.exists = false
            expect((yield* f.stack.plan(program)).resources.Secret?.action).toBe('update')
            expect(f.state.buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
            expect(f.state.logs.join('\n')).not.toContain(f.secret)
            expect(f.state.logs.join('\n')).not.toContain(f.hashKey)
          }),
        )
      }),
  )
}
it.effect('updatedAtOnly plans do not read values or keys; retain prevents deletion', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.run(
      Effect.gen(function* () {
        const program = ActionsSecret('Secret', {
          ...f.props,
          driftMode: 'updatedAtOnly',
          retain: true,
        })
        yield* f.stack.deploy(program)
        const reads = f.state.reads
        f.state.value = 'unobserved-source'
        expect((yield* f.stack.plan(program)).resources.Secret?.action).toBe('noop')
        expect(f.state.reads).toBe(reads)
        f.state.updated = '2026-04-01T00:00:00Z'
        expect((yield* f.stack.plan(program)).resources.Secret?.action).toBe('update')
        expect(f.state.reads).toBe(reads)
        yield* f.stack.destroy()
        expect(f.state.deletes).toBe(0)
      }),
    )
  }),
)
it.effect('deletes managed secrets and stores no HMAC without hashKey', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.run(
      Effect.gen(function* () {
        const { hashKey: _hashKey, ...props } = f.props
        yield* f.stack.deploy(ActionsSecret('Secret', props))
        expect((yield* f.persisted)?.attr?.hash).toBeUndefined()
        expect((yield* f.persisted)?.attr?.hashKeyId).toBeUndefined()
        yield* f.stack.destroy()
        expect(f.state.deletes).toBe(1)
      }),
    )
  }),
)
it.effect('sanitizes failed PUT and source errors and zeroes transient buffers', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.run(
      Effect.gen(function* () {
        f.state.reject = true
        const program = ActionsSecret('Secret', f.props)
        const error = yield* f.stack.deploy(program).pipe(Effect.flip)
        expect(encode(error)).not.toContain(f.secret)
        expect(encode(error)).not.toContain(f.hashKey)
        expect(encode(encodeState(yield* f.persisted))).not.toContain(f.secret)
        expect(f.state.buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
        f.state.reject = false
        f.state.failSource = true
        const sourceError = yield* f.stack.deploy(program).pipe(Effect.flip)
        expect(encode(sourceError)).not.toContain(f.secret)
      }),
    )
  }),
)
