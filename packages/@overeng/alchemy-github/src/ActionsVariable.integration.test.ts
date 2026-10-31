// Preserve the upstream scratch harness's generic engine error/service channels.
/** @effect-diagnostics anyUnknownInErrorContext:off */
import { createServer } from 'node:http'

import { fromToken } from '@alchemy.run/github/Credentials'
import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { AlchemyContext } from 'alchemy/AlchemyContext'
import * as Provider from 'alchemy/Provider'
import { State } from 'alchemy/State'
import { scratchStack, toEffect } from 'alchemy/Test/Core'
import { Effect, FileSystem, Layer, Schema } from 'effect'
import { expect } from 'vitest'

import { ActionsError } from './ActionsCommon.ts'
import {
  ActionsVariable,
  ActionsVariableProvider,
  type ActionsVariableProps,
} from './ActionsVariable.ts'
import { Providers } from './Providers.ts'

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, value: Schema.String })),
)
const fixture = (environment?: string, retain = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ prefix: 'alchemy-variable-' }),
      (path) => fs.remove(path, { recursive: true }).pipe(Effect.orDie),
    )
    const live = {
      value: undefined as string | undefined,
      status: 200,
      requests: [] as string[],
      bodies: [] as { readonly name: string; readonly value: string }[],
    }
    const collection =
      environment === undefined
        ? '/repos/example/repo/actions/variables'
        : `/repos/example/repo/environments/${encodeURIComponent(environment)}/variables`
    const item = `${collection}/SETTING`
    const server = createServer((request, response) => {
      const path = (request.url ?? '').replace(/^\/api/, '')
      live.requests.push(`${request.method} ${path}`)
      response.setHeader('content-type', 'application/json')
      if (request.method === 'GET' && path === item) {
        response.statusCode =
          live.status !== 200 ? live.status : live.value === undefined ? 404 : 200
        response.end(
          encode(
            response.statusCode === 200
              ? { name: 'SETTING', value: live.value }
              : { message: 'Not Found' },
          ),
        )
      } else if (
        (request.method === 'POST' && path === collection) ||
        (request.method === 'PATCH' && path === item)
      ) {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          body += chunk
        })
        request.on('end', () => {
          const parsed = decode(body)
          live.bodies.push(parsed)
          if ((request.method === 'POST') === (live.value !== undefined)) {
            response.statusCode = request.method === 'POST' ? 409 : 404
            response.end('{}')
            return
          }
          live.value = parsed.value
          response.statusCode = request.method === 'POST' ? 201 : 204
          response.end()
        })
      } else if (request.method === 'DELETE' && path === item) {
        live.value = undefined
        response.statusCode = 204
        response.end()
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
    const baseUrl = `http://127.0.0.1:${address.port}/api`
    const providers = Layer.effect(Providers, Provider.collection([ActionsVariable])).pipe(
      Layer.provide(ActionsVariableProvider),
      Layer.provideMerge(fromToken('fixture-token', { baseUrl })),
    )
    const options = { providers, stage: 'test', dev: false, sidecar: false }
    const stack = scratchStack(options, 'github-variable-engine')
    const props: ActionsVariableProps = {
      owner: 'example',
      repository: 'repo',
      ...(environment === undefined ? {} : { environment }),
      name: 'setting',
      value: 'desired',
      retain,
    }
    const program = (changes: Partial<ActionsVariableProps> = {}) =>
      ActionsVariable('Variable', { ...props, ...changes })
    const persisted = Effect.gen(function* () {
      const state = yield* yield* State
      return yield* state.get({ stack: stack.name, stage: stack.stage, fqn: 'Variable' })
    }).pipe(Effect.provide(stack.state))
    const run = <TValue, TError, TRequirements>(
      effect: Effect.Effect<TValue, TError, TRequirements>,
    ) =>
      toEffect(effect, { ...options, state: stack.state }).pipe(
        Effect.provideService(AlchemyContext, { dotAlchemy: directory, dev: false, adopt: false }),
      )
    const refresh = Effect.gen(function* () {
      const provider = yield* Provider.Provider<ActionsVariable>(ActionsVariable.Type)
      if (provider.read === undefined) return yield* Effect.die('Expected variable read lifecycle')
      return yield* provider.read({
        id: 'Variable',
        fqn: 'Variable',
        instanceId: 'test',
        olds: props,
        output: undefined,
      })
    }).pipe(
      Effect.provide(
        ActionsVariableProvider.pipe(Layer.provideMerge(fromToken('fixture-token', { baseUrl }))),
      ),
    )
    return { live, collection, item, baseUrl, stack, props, program, persisted, refresh, run }
  }).pipe(Effect.provide(NodeServices.layer))

for (const environment of [undefined, 'production / west']) {
  it.effect(
    `real engine creates, updates, repairs drift and deletes ${environment === undefined ? 'repository' : 'environment'} variables`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(environment)
        yield* f.run(
          Effect.gen(function* () {
            yield* f.stack.deploy(f.program())
            expect(f.live.requests).toContain(`POST ${f.collection}`)
            expect(f.live.bodies).toEqual([{ name: 'SETTING', value: 'desired' }])
            const before = yield* f.persisted
            expect(before).toMatchObject({
              props: f.props,
              attr: {
                owner: 'example',
                repository: 'repo',
                name: 'SETTING',
                value: 'desired',
                baseUrl: f.baseUrl,
              },
            })
            expect((yield* f.stack.plan(f.program())).resources.Variable?.action).toBe('noop')
            expect(
              (yield* f.stack.plan(f.program({ name: 'SETTING' }))).resources.Variable?.action,
            ).toBe('update')

            f.live.value = 'changed remotely'
            f.live.requests.length = 0
            // No manual read/refresh: unchanged persisted attributes enter beta84 Plan.make.
            expect((yield* f.stack.plan(f.program())).resources.Variable?.action).toBe('update')
            expect(f.live.requests).toEqual([`GET ${f.item}`])
            expect(yield* f.persisted).toEqual(before)
            yield* f.stack.deploy(f.program())
            expect(f.live.requests).toContain(`PATCH ${f.item}`)
            expect(f.live.value).toBe('desired')

            f.live.value = 'new declaration'
            expect(
              (yield* f.stack.plan(f.program({ value: 'new declaration' }))).resources.Variable
                ?.action,
            ).toBe('update')
            yield* f.stack.deploy(f.program({ value: 'new declaration' }))
            expect(f.live.value).toBe('new declaration')
            const updated = yield* f.persisted
            f.live.value = undefined
            f.live.requests.length = 0
            expect(
              (yield* f.stack.plan(f.program({ value: 'new declaration' }))).resources.Variable
                ?.action,
            ).toBe('update')
            expect(yield* f.persisted).toEqual(updated)
            yield* f.stack.deploy(f.program({ value: 'new declaration' }))
            expect(f.live.requests).toContain(`POST ${f.collection}`)
            expect(f.live.value).toBe('new declaration')
            yield* f.stack.destroy()
            expect(f.live.requests).toContain(`DELETE ${f.item}`)
            expect(f.live.value).toBeUndefined()
          }),
        )
      }),
  )
}

it.effect('retain forgets the resource without deleting the remote variable', () =>
  Effect.gen(function* () {
    const f = yield* fixture(undefined, true)
    yield* f.run(
      Effect.gen(function* () {
        yield* f.stack.deploy(f.program())
        f.live.requests.length = 0
        yield* f.stack.destroy()
        expect(f.live.requests.some((request) => request.startsWith('DELETE '))).toBe(false)
        expect(f.live.value).toBe('desired')
      }),
    )
  }),
)

for (const changes of [
  { owner: 'other' },
  { repository: 'other' },
  { environment: 'production' },
  { name: 'OTHER' },
  { baseUrl: 'http://127.0.0.1:1/api' },
]) {
  it.effect(`rejects an existing variable identity change: ${Object.keys(changes)[0]}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.run(
        Effect.gen(function* () {
          yield* f.stack.deploy(f.program())
          const before = yield* f.persisted
          f.live.requests.length = 0
          const error = yield* f.stack.plan(f.program(changes)).pipe(Effect.flip)
          expect(error).toBeInstanceOf(ActionsError)
          expect(error).toMatchObject({ operation: 'identity' })
          expect(f.live.requests).toEqual([])
          expect(yield* f.persisted).toEqual(before)
        }),
      )
    }),
  )
}

it.effect('authorization failure is typed and does not masquerade as a missing variable', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.run(
      Effect.gen(function* () {
        yield* f.stack.deploy(f.program())
        const before = yield* f.persisted
        f.live.status = 403
        f.live.requests.length = 0
        const error = yield* f.stack.deploy(f.program()).pipe(Effect.flip)
        expect(error).toBeInstanceOf(ActionsError)
        expect(f.live.requests).toEqual([`GET ${f.item}`])
        expect(yield* f.persisted).toEqual(before)
      }),
    )
  }),
)

it.effect('read returns live metadata and undefined for a missing variable', () =>
  Effect.gen(function* () {
    const f = yield* fixture('production / west')
    expect(yield* f.refresh).toBeUndefined()
    f.live.value = 'remote'
    expect(yield* f.refresh).toEqual({
      owner: 'example',
      repository: 'repo',
      environment: 'production / west',
      name: 'SETTING',
      value: 'remote',
      baseUrl: f.baseUrl,
    })
    f.live.value = undefined
    expect(yield* f.refresh).toBeUndefined()
  }),
)
