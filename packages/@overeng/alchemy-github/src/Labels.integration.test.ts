// Preserve the upstream real-engine harness's generic error/service channels.
/** @effect-diagnostics anyUnknownInErrorContext:off */
import { createServer } from 'node:http'

import { fromToken } from '@alchemy.run/github/Credentials'
import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { AlchemyContext } from 'alchemy/AlchemyContext'
import * as Provider from 'alchemy/Provider'
import { State } from 'alchemy/State'
import { scratchStack, toEffect } from 'alchemy/Test/Core'
import { Effect, FileSystem, Layer, Logger, Schema } from 'effect'
import { expect } from 'vitest'

import {
  Labels,
  LabelsProvider,
  loadLabelsFile,
  type LabelDefinition,
  type LabelsAttributes,
  type LabelsProps,
} from './Labels.ts'
import { providers as githubProviders } from './Providers.ts'

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      color: Schema.String,
      description: Schema.optional(Schema.String),
    }),
  ),
)
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: 'alchemy-labels-' }),
    (path) => fs.remove(path, { recursive: true }).pipe(Effect.orDie),
  )
  const labels = new Map<string, LabelDefinition>()
  const state = {
    status: 200,
    requests: [] as string[],
    bodies: [] as unknown[],
    logs: [] as string[],
  }
  const server = createServer(async (request, response) => {
    const url = new URL((request.url ?? '').replace(/^\/api/, ''), 'http://fixture')
    state.requests.push(`${request.method} ${url.pathname}${url.search}`)
    response.setHeader('content-type', 'application/json')
    if (state.status !== 200) {
      response.statusCode = state.status
      return response.end('{}')
    }
    const collection = '/repos/example/repo/labels'
    if (request.method === 'GET' && url.pathname === collection) {
      const page = Number(url.searchParams.get('page'))
      const perPage = Number(url.searchParams.get('per_page'))
      return response.end(
        encode(
          [...labels.values()].slice((page - 1) * perPage, page * perPage).map((label) => ({
            name: label.name,
            color: label.color,
            description: label.description ?? null,
          })),
        ),
      )
    }
    const name = decodeURIComponent(url.pathname.slice(collection.length + 1))
    if (request.method === 'DELETE') {
      response.statusCode = labels.delete(name.toLowerCase()) === true ? 204 : 404
      return response.end()
    }
    if (request.method === 'POST' || request.method === 'PATCH') {
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      const parsed = decode(body)
      state.bodies.push(parsed)
      const previous = labels.get(name.toLowerCase())
      const applied = {
        name: parsed.name ?? previous?.name ?? name,
        color: parsed.color,
        description: parsed.description ?? '',
      }
      labels.set(applied.name.toLowerCase(), applied)
      response.statusCode = request.method === 'POST' ? 201 : 200
      return response.end(encode(applied))
    }
    response.statusCode = 404
    return response.end('{}')
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
  const providers = githubProviders().pipe(
    Layer.merge(credentials),
    Layer.provideMerge(
      Logger.layer([Logger.make((entry) => state.logs.push(encode(entry.message)))], {
        mergeWithExisting: false,
      }),
    ),
  )
  const options = { providers, stage: 'test', dev: false, sidecar: false }
  const stack = scratchStack(options, 'labels-engine')
  const props: LabelsProps = {
    owner: 'example',
    repo: 'repo',
    labels: [
      { name: 'bug', color: 'AA0000', description: 'New description' },
      { name: 'feature', color: '00ff00' },
    ],
  }
  const program = (changes: Partial<LabelsProps> = {}) => Labels('Labels', { ...props, ...changes })
  const persisted = Effect.gen(function* () {
    const store = yield* yield* State
    const row = yield* store.get({ stack: stack.name, stage: stack.stage, fqn: 'Labels' })
    return row?.kind === 'action' ? undefined : row
  }).pipe(Effect.provide(stack.state))
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    toEffect(effect, { ...options, state: stack.state }).pipe(
      Effect.provideService(AlchemyContext, { dotAlchemy: directory, dev: false, adopt: false }),
    )
  const refresh = (output: LabelsAttributes) =>
    Effect.gen(function* () {
      const provider = yield* Provider.Provider<Labels>(Labels.Type)
      if (provider.read === undefined) return yield* Effect.die('Missing read lifecycle')
      return yield* provider.read({
        id: 'Labels',
        fqn: 'Labels',
        instanceId: 'test',
        olds: props,
        output,
      })
    }).pipe(Effect.provide(LabelsProvider.pipe(Layer.provideMerge(credentials))))
  return { fs, directory, labels, state, props, stack, program, persisted, run, refresh }
}).pipe(Effect.provide(NodeServices.layer))

it.effect(
  'creates, updates drift, matches names ignoring case, reports unmanaged labels and plans no-op',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      f.labels.set('bug', { name: 'Bug', color: 'ffffff', description: 'Old description' })
      f.labels.set('keep', { name: 'keep', color: '123456' })
      yield* f.run(
        Effect.gen(function* () {
          yield* f.stack.deploy(f.program())
          expect(f.labels.get('bug')).toEqual({
            name: 'Bug',
            color: 'aa0000',
            description: 'New description',
          })
          expect(f.labels.get('feature')).toMatchObject({ color: '00ff00', description: '' })
          expect(f.labels.has('keep')).toBe(true)
          expect(f.state.bodies[0]).not.toHaveProperty('name')
          const row = yield* f.persisted
          expect(row?.attr).toEqual({
            managed: [
              { name: 'bug', color: 'aa0000', description: 'New description' },
              { name: 'feature', color: '00ff00', description: '' },
            ],
          })
          expect(f.state.logs.join(' ')).toContain('keep')
          f.state.requests.length = 0
          expect((yield* f.stack.plan(f.program())).resources.Labels?.action).toBe('noop')
          yield* f.stack.deploy(f.program())
          expect(f.state.requests.every((request) => request.startsWith('GET '))).toBe(true)
          f.labels.set('bug', { name: 'Bug', color: '000000', description: 'External edit' })
          expect((yield* f.stack.plan(f.program())).resources.Labels?.action).toBe('update')
          yield* f.stack.deploy(f.program())
          expect(f.labels.get('bug')?.description).toBe('New description')
          f.labels.delete('feature')
          expect((yield* f.stack.plan(f.program())).resources.Labels?.action).toBe('update')
        }),
      )
    }),
)

it.effect('paginates diff/read/reconcile and deletes unmanaged labels only with opt-in', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    for (let index = 0; index < 100; index++)
      f.labels.set(`extra-${index}`, { name: `extra-${index}`, color: '000000' })
    f.labels.set('bug', { ...f.props.labels[0]!, name: 'BUG', color: 'aa0000' })
    f.labels.set('feature', f.props.labels[1]!)
    yield* f.run(
      Effect.gen(function* () {
        yield* f.stack.deploy(f.program())
        expect(f.labels.size).toBe(102)
        expect(f.state.requests).toContain('GET /repos/example/repo/labels?per_page=100&page=2')
        const output: LabelsAttributes = { managed: f.props.labels }
        f.state.requests.length = 0
        expect(yield* f.refresh(output)).toEqual(output)
        expect(f.state.requests).toContain('GET /repos/example/repo/labels?per_page=100&page=2')
        f.state.requests.length = 0
        expect((yield* f.stack.plan(f.program())).resources.Labels?.action).toBe('noop')
        expect(f.state.requests).toContain('GET /repos/example/repo/labels?per_page=100&page=2')
        yield* f.stack.deploy(f.program({ deleteUnmanaged: true }))
        expect([...f.labels.keys()].sort()).toEqual(['bug', 'feature'])
        expect(f.state.requests.filter((request) => request.startsWith('DELETE '))).toHaveLength(
          100,
        )
      }),
    )
  }),
)

it.effect('destroy deletes only managed labels still matching last applied values', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const labels = ['same', 'color-edit', 'description-edit', 'missing'].map((name) => ({
      name,
      color: 'aabbcc',
      description: 'Applied',
    }))
    f.labels.set('unmanaged', { name: 'unmanaged', color: 'aabbcc' })
    yield* f.run(
      Effect.gen(function* () {
        yield* f.stack.deploy(f.program({ labels }))
        f.labels.set('color-edit', { ...labels[1]!, color: 'ffffff' })
        f.labels.set('description-edit', { ...labels[2]!, description: 'Outside change' })
        f.labels.delete('missing')
        f.state.requests.length = 0
        yield* f.stack.destroy()
        expect(f.state.requests.filter((request) => request.startsWith('DELETE '))).toEqual([
          'DELETE /repos/example/repo/labels/same',
        ])
        expect([...f.labels.keys()].sort()).toEqual(['color-edit', 'description-edit', 'unmanaged'])
      }),
    )
  }),
)

it.effect('loads the labels.json envelope and rejects malformed colors and duplicate names', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const path = `${f.directory}/labels.json`
    yield* f.fs.writeFileString(path, encode({ labels: f.props.labels, metadata: 'ignored' }))
    expect(yield* loadLabelsFile(path).pipe(Effect.provide(NodeServices.layer))).toEqual(
      f.props.labels,
    )
    yield* f.fs.writeFileString(path, encode({ labels: [{ name: 'bad', color: '#000000' }] }))
    const error = yield* loadLabelsFile(path).pipe(Effect.provide(NodeServices.layer), Effect.flip)
    expect(error._tag).toBe('GitHubLabelsError')
    yield* f.run(
      Effect.gen(function* () {
        const result = yield* f.stack
          .deploy(
            f.program({
              labels: [
                { name: 'Bug', color: '000000' },
                { name: 'bug', color: 'ffffff' },
              ],
            }),
          )
          .pipe(Effect.exit)
        expect(result._tag).toBe('Failure')
        expect(f.state.requests).toEqual([])
      }),
    )
  }),
)

it.effect('fails closed for repository changes and API authorization errors', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.run(
      Effect.gen(function* () {
        yield* f.stack.deploy(f.program())
        const identity = yield* f.stack.plan(f.program({ repo: 'different' })).pipe(Effect.exit)
        expect(identity._tag).toBe('Failure')
        f.state.status = 403
        const denied = yield* f.stack.plan(f.program()).pipe(Effect.exit)
        expect(denied._tag).toBe('Failure')
      }),
    )
  }),
)
