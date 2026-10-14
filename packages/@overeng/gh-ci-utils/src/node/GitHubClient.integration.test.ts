import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'

import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, FileSystem, Layer, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { expect } from 'vitest'

import { GitHubAuthConfigTag } from './Config.ts'
import { GitHubClient } from './GitHubClient.ts'

const Json = Schema.fromJsonString(Schema.Unknown)

it.live('keeps gh-ci-utils App auth on the shared minter with repository-scoped cache', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'github-app-effect-' })
    const privateKeyPath = `${directory}/throwaway.pem`
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    yield* fs.writeFileString(
      privateKeyPath,
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      { mode: 0o600 },
    )
    const bodies: unknown[] = []
    const headers: string[] = []
    const server = createServer(async (request, response) => {
      if (request.url === '/app/installations/123/access_tokens') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        bodies.push(Schema.decodeSync(Json)(Buffer.concat(chunks).toString()))
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(
          Schema.encodeSync(Json)({
            token: 'installation-gh-ci',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        )
      } else {
        headers.push(request.headers.authorization ?? '')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"total_count":0,"workflow_runs":[]}')
      }
    })
    yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))),
      () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
    const address = server.address()
    if (address === null || typeof address === 'string')
      return yield* Effect.die('Expected fixture TCP address')
    const apiBase = new URL(`http://127.0.0.1:${address.port}`)
    yield* Effect.gen(function* () {
      const client = yield* GitHubClient
      yield* client.listWorkflowRunsByStatus({ repo: 'schickling/dotfiles', status: 'completed' })
      yield* client.listWorkflowRunsByStatus({ repo: 'schickling/dotfiles', status: 'completed' })
      expect(yield* client.getRequestCount).toBe(2)
      expect(yield* client.getRestRequestCount).toBe(2)
    }).pipe(
      Effect.provide(
        GitHubClient.layer({
          consumer: 'gh-ci-utils',
          permissions: {
            actions: 'write',
            checks: 'read',
            contents: 'read',
            pull_requests: 'read',
          },
          apiBase,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              FetchHttpClient.layer,
              NodeServices.layer,
              Layer.succeed(GitHubAuthConfigTag, {
                _tag: 'github-app',
                clientID: 'Iv1.gh-ci',
                privateKeyPath,
                installationIDs: { schickling: 123 },
              }),
            ),
          ),
        ),
      ),
    )
    expect(bodies).toEqual([
      {
        repositories: ['dotfiles'],
        permissions: { actions: 'write', checks: 'read', contents: 'read', pull_requests: 'read' },
      },
    ])
    expect(headers).toEqual(['Bearer installation-gh-ci', 'Bearer installation-gh-ci'])
  }).pipe(Effect.provide(NodeServices.layer)),
)
