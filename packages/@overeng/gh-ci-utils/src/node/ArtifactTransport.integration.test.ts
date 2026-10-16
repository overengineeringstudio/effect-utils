import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'

import { NodeHttpClient, NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, FileSystem, Layer, Schema, Tracer } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { expect } from 'vitest'

import { ARTIFACT_LIMITS, type RetainedArtifact } from '../isomorphic/Artifacts.ts'
import { GitHubAuthConfigTag } from './Config.ts'
import { GitHubClient } from './GitHubClient.ts'

const Json = Schema.fromJsonString(Schema.Unknown)
const encode = Schema.encodeSync(Json)
// A real, empty ZIP archive (end-of-central-directory record).
const zip = Buffer.from('504b05060000000000000000000000000000000000000000', 'hex')

it.live('bounds retained artifact transport and isolates managed authentication from storage', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'artifact-transport-' })
    const privateKeyPath = `${directory}/ephemeral.pem`
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    yield* fs.writeFileString(
      privateKeyPath,
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      { mode: 0o600 },
    )
    const selection = { repo: 'fixture/repo', runId: 12, artifactId: 34 }
    const metadata: RetainedArtifact = {
      id: 34,
      name: 'diagnostics',
      size_in_bytes: zip.length,
      expired: false,
      created_at: '2026-10-16T00:00:00Z',
      updated_at: '2026-10-16T00:00:00Z',
      expires_at: '2026-10-17T00:00:00Z',
      workflow_run: { id: 12 },
    }
    let mode = 'ok'
    let redirect = 'https://fixture.blob.core.windows.net/archive?signature=fixture-secret'
    const requests: string[] = []
    const storageAuth: Array<string | undefined> = []
    const storageTrace: Array<string | string[] | undefined> = []
    const apiAuth: Array<string | undefined> = []
    const server = createServer(async (request, response) => {
      const path = request.url ?? ''
      if (path === '/app/installations/123/access_tokens') {
        for await (const _chunk of request) {
          /* consume real token exchange body */
        }
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(
          encode({
            token: 'fixture-installation',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        )
        return
      }
      requests.push(path)
      if (path.startsWith('/storage')) {
        storageAuth.push(request.headers.authorization)
        storageTrace.push(request.headers.traceparent)
        if (mode === 'chained') {
          response.writeHead(302, {
            location:
              'https://fixture.actions.githubusercontent.com/again?signature=fixture-secret',
          })
          response.end()
        } else {
          response.writeHead(200)
          response.end(zip)
        }
        return
      }
      apiAuth.push(request.headers.authorization)
      if (path.includes('/runs/')) {
        if (mode === 'metadata-advertised') {
          response.writeHead(200, { 'content-length': ARTIFACT_LIMITS.metadataBytes + 1 })
          response.flushHeaders()
        } else if (mode === 'metadata-stream') {
          response.writeHead(200, { 'transfer-encoding': 'chunked' })
          response.end(Buffer.alloc(ARTIFACT_LIMITS.metadataBytes + 1, 32))
        } else {
          response.writeHead(200)
          response.end(
            encode({
              total_count: 101,
              artifacts: [
                {
                  ...metadata,
                  workflow_run: mode === 'listing-mismatch' ? { id: 99 } : metadata.workflow_run,
                },
              ],
            }),
          )
        }
        return
      }
      if (path.endsWith('/zip')) {
        if (mode === 'redirect' || mode === 'chained') {
          response.writeHead(302, { location: redirect })
          response.end()
        } else if (mode === 'archive-advertised') {
          response.writeHead(200, { 'content-length': ARTIFACT_LIMITS.compressedBytes + 1 })
          response.flushHeaders()
        } else if (mode === 'archive-stream') {
          response.writeHead(200, { 'transfer-encoding': 'chunked' })
          response.end(Buffer.alloc(ARTIFACT_LIMITS.compressedBytes + 1))
        } else if (mode === 'download-404' || mode === 'download-410') {
          response.writeHead(mode === 'download-404' ? 404 : 410)
          response.end('fixture-secret')
        } else {
          response.writeHead(200)
          response.end(zip)
        }
        return
      }
      if (mode === '404' || mode === '410') {
        response.writeHead(Number(mode))
        response.end('fixture-secret')
      } else {
        response.writeHead(200)
        response.end(
          encode({
            ...metadata,
            expired: mode === 'expired',
            workflow_run: mode === 'mismatch' ? { id: 99 } : metadata.workflow_run,
            size_in_bytes:
              mode === 'metadata-size' ? ARTIFACT_LIMITS.compressedBytes + 1 : zip.length,
          }),
        )
      }
    })
    yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections()
              server.close(() => resolve())
            }),
        ),
    )
    const address = server.address()
    if (address === null || typeof address === 'string')
      return yield* Effect.die('Expected TCP fixture')
    const apiBase = new URL(`http://127.0.0.1:${address.port}`)
    // Routing-only DI: responses still come from the real HTTP server/Node transport.
    const routedHttp = Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        return client.pipe(
          HttpClient.mapRequest((request) =>
            request.url.startsWith('https://fixture.blob.core.windows.net/')
              ? HttpClientRequest.setUrl(request, new URL('/storage', apiBase).href)
              : request,
          ),
        )
      }),
    ).pipe(Layer.provide(NodeHttpClient.layerNodeHttp))
    yield* Effect.gen(function* () {
      const client = yield* GitHubClient
      for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1001]) {
        const error = yield* client
          .listRetainedArtifacts({ ...selection, page: invalid })
          .pipe(Effect.flip)
        expect(error.reason).toBe('invalid-selection')
      }
      for (const repo of [
        '../repo',
        'fixture/repo/extra',
        'fixture/repo?secret',
        'fixture/..',
        'fixture/repo\n',
      ]) {
        expect(
          (yield* client.getRetainedArtifact({ ...selection, repo }).pipe(Effect.flip)).reason,
        ).toBe('invalid-selection')
      }
      for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(
          (yield* client.getRetainedArtifact({ ...selection, runId: id }).pipe(Effect.flip)).reason,
        ).toBe('invalid-selection')
        expect(
          (yield* client.getRetainedArtifact({ ...selection, artifactId: id }).pipe(Effect.flip))
            .reason,
        ).toBe('invalid-selection')
      }
      expect(requests).toEqual([])
      const first = yield* client.listRetainedArtifacts({ ...selection, page: 1 })
      const second = yield* client.listRetainedArtifacts({ ...selection, page: 2 })
      expect([first.totalCount, first.hasMore, second.hasMore]).toEqual([101, true, false])
      expect(requests).toEqual([
        '/repos/fixture/repo/actions/runs/12/artifacts?per_page=100&page=1',
        '/repos/fixture/repo/actions/runs/12/artifacts?per_page=100&page=2',
      ])
      expect((yield* client.downloadRetainedArtifact(selection)).bytes).toEqual(new Uint8Array(zip))
      for (const [scenario, reason] of [
        ['404', 'artifact-not-found'],
        ['410', 'expired'],
        ['expired', 'expired'],
        ['mismatch', 'run-mismatch'],
        ['metadata-size', 'limit-exceeded'],
        ['download-404', 'artifact-not-found'],
        ['download-410', 'expired'],
        ['archive-advertised', 'limit-exceeded'],
        ['archive-stream', 'limit-exceeded'],
      ] as const) {
        mode = scenario
        const before = requests.length
        const error = yield* client.downloadRetainedArtifact(selection).pipe(Effect.flip)
        expect(error.reason).toBe(reason)
        expect(error).toMatchObject({
          repo: selection.repo,
          runId: 12,
          artifactId: 34,
          member: null,
        })
        expect(encode(error)).not.toContain('fixture-secret')
        if (['404', '410', 'expired', 'mismatch', 'metadata-size'].includes(scenario))
          expect(requests.slice(before)).toEqual(['/repos/fixture/repo/actions/artifacts/34'])
      }
      mode = 'listing-mismatch'
      expect(
        (yield* client.listRetainedArtifacts({ ...selection, page: 1 }).pipe(Effect.flip)).reason,
      ).toBe('run-mismatch')
      for (const scenario of ['metadata-advertised', 'metadata-stream']) {
        mode = scenario
        expect(
          (yield* client.listRetainedArtifacts({ ...selection, page: 1 }).pipe(Effect.flip)).reason,
        ).toBe('limit-exceeded')
      }
      mode = 'redirect'
      for (const target of [
        'http://fixture.blob.core.windows.net/archive',
        'https://blob.core.windows.net/archive',
        'https://fixture.blob.core.windows.net.attacker.invalid/archive',
        'https://user:password@fixture.blob.core.windows.net/archive',
        'https://fixture.blob.core.windows.net:444/archive',
        'https://fixture.blob.core.windows.net/archive#fragment',
        '/relative',
        'https://attacker.invalid/archive?signature=fixture-secret',
      ]) {
        redirect = target
        const error = yield* client.downloadRetainedArtifact(selection).pipe(Effect.flip)
        expect(error.reason).toBe('transport')
        expect(encode(error)).not.toContain(target)
      }
      expect(storageAuth).toEqual([])
      redirect = 'https://fixture.blob.core.windows.net/archive?signature=fixture-secret'
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      expect(
        (yield* client
          .downloadRetainedArtifact(selection)
          .pipe(Effect.withSpan('artifact-trace-fixture'), Effect.withTracer(tracer))).bytes,
      ).toEqual(new Uint8Array(zip))
      expect(spans.length).toBeGreaterThan(0)
      const captured = encode(
        spans.map((span) => ({
          name: span.name,
          attributes: Array.from(span.attributes),
          events: span.events,
        })),
      )
      for (const sensitive of [
        'fixture-secret',
        'fixture-installation',
        'signature=',
        'response.header.location',
      ])
        expect(captured).not.toContain(sensitive)
      mode = 'chained'
      expect((yield* client.downloadRetainedArtifact(selection).pipe(Effect.flip)).reason).toBe(
        'transport',
      )
      expect(storageAuth).toEqual([undefined, undefined])
      expect(storageTrace).toEqual([undefined, undefined])
      expect(apiAuth.every((header) => header === 'Bearer fixture-installation')).toBe(true)
    }).pipe(
      Effect.provide(
        GitHubClient.layer({
          consumer: 'artifact-transport-fixture',
          permissions: { actions: 'read' },
          apiBase,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              routedHttp,
              NodeServices.layer,
              Layer.succeed(GitHubAuthConfigTag, {
                _tag: 'github-app',
                clientID: 'Iv1.fixture',
                privateKeyPath,
                installationIDs: { fixture: 123 },
              }),
            ),
          ),
        ),
      ),
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
