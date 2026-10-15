import { createServer } from 'node:http'

import { NodeServices } from '@effect/platform-node'
import { live } from '@effect/vitest'
import { Effect, FileSystem } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { expect } from 'vitest'

import { pnpmDeclarationPaths } from './pnpm-declaration-paths.ts'
import { checkDeployedPnpm } from './pnpm-deployed.ts'

const fixture = Effect.fn('pnpm-deployed.fixture')(function* (options: {
  readonly body: string
  readonly nixVersion?: string
  readonly status?: number
  readonly unreachable?: boolean
}) {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  yield* fs.makeDirectory(`${root}/packages/@overeng/genie/src/runtime/package-json`, {
    recursive: true,
  })
  yield* fs.makeDirectory(`${root}/nix`)
  yield* fs.writeFileString(
    `${root}/${pnpmDeclarationPaths[0]}`,
    "const DEFAULT_AGGREGATE_PACKAGE_MANAGER = 'pnpm@12.7.0'\n",
  )
  yield* fs.writeFileString(
    `${root}/nix/pnpm.nix`,
    `  version = "${options.nixVersion ?? '12.7.0'}";\n`,
  )
  yield* fs.writeFileString(`${root}/package.json`, '{"packageManager":"pnpm@12.7.0"}')
  const server = createServer((_request, response) => {
    response.writeHead(options.status ?? 200, { 'content-type': 'application/json' })
    response.end(options.body)
  })
  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            if (!server.listening) return resolve()
            server.close((error) => (error === undefined ? resolve() : reject(error)))
          }),
      ),
  )
  const address = server.address()
  if (address === null || typeof address === 'string')
    return yield* Effect.die('Expected TCP fixture address')
  const registryUrl = `http://127.0.0.1:${address.port}/pnpm-deployed.json`
  if (options.unreachable === true) {
    yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
  }
  const result = yield* checkDeployedPnpm({ root, registryUrl }).pipe(Effect.result)
  return { result, registryUrl }
})

const registry = (versions: readonly string[]) =>
  JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-10-15T00:00:00Z',
    pnpm: versions,
    integrity: { '12.7.0': { target: 'sha512-example' } },
  })
const withServices = <T, E, R>(effect: Effect.Effect<T, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer))

live('accepts a listed version and additive integrity data', () =>
  Effect.gen(function* () {
    const { result } = yield* fixture({ body: registry(['12.7.0']) })
    expect(result._tag).toBe('Success')
  }).pipe(withServices),
)

live('rejects an unlisted version and names the version and URL', () =>
  Effect.gen(function* () {
    const { result, registryUrl } = yield* fixture({ body: registry(['12.11.2']) })
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        message: `pnpm version(s) 12.7.0 are not listed in the deployed pnpm registry at ${registryUrl}`,
      },
    })
  }).pipe(withServices),
)

for (const [name, options] of [
  ['invalid JSON', { body: '{' }],
  ['invalid schema', { body: '{"schemaVersion":2,"pnpm":["12.7.0"]}' }],
  ['invalid version', { body: registry(['latest']) }],
  ['HTTP error', { body: registry(['12.7.0']), status: 503 }],
  ['unreachable endpoint', { body: '', unreachable: true }],
] as const) {
  live(`fails closed on ${name}`, () =>
    Effect.gen(function* () {
      const { result, registryUrl } = yield* fixture(options)
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          message: expect.stringContaining(
            `Cannot read the deployed pnpm registry at ${registryUrl}`,
          ),
        },
      })
    }).pipe(withServices),
  )
}

live('rejects disagreeing declarations', () =>
  Effect.gen(function* () {
    const { result } = yield* fixture({
      body: registry(['12.7.0', '12.11.2']),
      nixVersion: '12.11.2',
    })
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { message: expect.stringContaining('pnpm declarations disagree:') },
    })
  }).pipe(withServices),
)
