import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, FileSystem, Layer, Logger, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { flushUsageLedger, UsageLedger, usageLedgerLayer } from './UsageLedger.ts'

const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
)
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String))
const fakeClient = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response('private-response-body', {
        status: 200,
        headers: {
          'x-ratelimit-resource': 'core',
          'x-ratelimit-remaining': '42',
          'set-cookie': 'private-cookie',
        },
      }),
    ),
  ),
)

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  const saved = { ...process.env }
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const key of [
        'GH_CI_UTILS_USAGE_LEDGER',
        'XDG_STATE_HOME',
        'FRACTAL_AGENT',
        'ST_AGENT',
      ]) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }),
  )
  process.env.GH_CI_UTILS_USAGE_LEDGER = `${directory}/ledger.jsonl`
  delete process.env.FRACTAL_AGENT
  delete process.env.ST_AGENT
  const client = yield* HttpClient.HttpClient.pipe(
    Effect.provide(
      usageLedgerLayer('app').pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, fakeClient))),
    ),
  )
  const readRows = Effect.gen(function* () {
    yield* flushUsageLedger
    const raw = yield* fs.readFileString(`${directory}/ledger.jsonl`)
    return { raw, rows: decode(`[${raw.trim().split('\n').join(',')}]`) }
  })
  return { fs, directory, client, readRows }
})

describe('GitHub usage ledger', () => {
  it.live('redacts refs, SHAs, contents, names and unknown path segments', () =>
    Effect.gen(function* () {
      const { client, readRows } = yield* fixture
      for (const path of [
        '/repos/acme/project/git/refs/heads/secret-topic/secret-branch',
        '/repos/acme/project/git/ref/heads/secret-topic',
        '/repos/acme/project/branches/actions/runs',
        '/repos/acme/project/commits/abcdef0123456789abcdef0123456789abcdef0123',
        '/repos/acme/project/contents/secret-folder/secret-roadmap.md',
        '/repos/acme/project/releases/tags/secret-release',
        '/repos/acme/project/environments/actions',
        '/repos/acme/project/actions/workflows/secret-workflow.yml/runs',
        '/secret-endpoint/secret-value/123?secret-query=secret-value',
      ])
        yield* client.get(`https://api.github.com${path}`)
      const { rows, raw } = yield* readRows
      expect(rows.map((row) => row.route)).toEqual([
        '/repos/{owner}/{repo}/git/refs/{param}/{param}/{param}',
        '/repos/{owner}/{repo}/git/ref/{param}/{param}',
        '/repos/{owner}/{repo}/branches/{param}/{param}',
        '/repos/{owner}/{repo}/commits/{param}',
        '/repos/{owner}/{repo}/contents/{param}/{param}',
        '/repos/{owner}/{repo}/releases/tags/{param}',
        '/repos/{owner}/{repo}/environments/{param}',
        '/repos/{owner}/{repo}/actions/workflows/{param}/runs',
        '/{param}/{param}/{id}',
      ])
      expect(raw).not.toContain('secret-')
      expect(raw).not.toContain('abcdef0123456789')
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live(
    'appends complete rows from two processes and drains the last queued rows before exit',
    () =>
      Effect.gen(function* () {
        const { fs, directory, readRows } = yield* fixture
        const spawner = yield* ChildProcessSpawner
        const script = `${directory}/writer.mjs`
        yield* fs.writeFileString(
          script,
          `
import { Effect } from ${encodeString(import.meta.resolve('effect'))}
import { NodeServices } from ${encodeString(import.meta.resolve('@effect/platform-node'))}
import { UsageLedger, flushUsageLedger } from ${encodeString(new URL('./UsageLedger.ts', import.meta.url).href)}
await Effect.runPromise(Effect.gen(function* () {
  const ledger = yield* UsageLedger.pipe(Effect.provide(UsageLedger.layer('app')))
  for (let index = 0; index < 100; index++) {
    yield* ledger.observe({ method: process.argv[2], path: '/app/installations/123/access_tokens', status: 201 })
  }
}).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(flushUsageLedger)))
process.exit(0)
`,
        )
        const codes = yield* Effect.forEach(
          ['GET', 'POST'],
          (method) => spawner.exitCode(ChildProcess.make(process.execPath, [script, method])),
          { concurrency: 2 },
        )
        expect(codes).toEqual([0, 0])
        const { rows, raw } = yield* readRows
        expect(raw.split('\n')).toHaveLength(201)
        expect(rows).toHaveLength(200)
        expect(rows.filter((row) => row.method === 'GET')).toHaveLength(100)
        expect(rows.filter((row) => row.method === 'POST')).toHaveLength(100)
        expect(
          rows.every(
            (row) =>
              row.schemaVersion === 1 && row.route === '/app/installations/{id}/access_tokens',
          ),
        ).toBe(true)
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  )

  it.live('records isolated App token exchange observations in the same ledger', () =>
    Effect.gen(function* () {
      const { readRows } = yield* fixture
      const ledger = yield* UsageLedger.pipe(Effect.provide(UsageLedger.layer('app')))
      yield* ledger.observe({
        method: 'POST',
        path: '/app/installations/123/access_tokens',
        status: 201,
        rateLimitResource: 'core',
        rateLimitRemaining: '4999',
      })
      const { rows } = yield* readRows
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        authKind: 'app',
        method: 'POST',
        status: 201,
        route: '/app/installations/{id}/access_tokens',
        rateLimitResource: 'core',
        rateLimitRemaining: 4999,
      })
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('records one safe row per GitHub request and excludes other hosts', () =>
    Effect.gen(function* () {
      const { client, readRows } = yield* fixture
      for (const path of [
        '/repos/secret-owner/secret-repo/issues/123?token=private-query',
        '/graphql',
        '/search/issues?q=private-query',
        '/repos/secret-owner/secret-repo/actions/runs/456',
      ]) {
        yield* client.execute(
          HttpClientRequest.post(`https://api.github.com${path}`).pipe(
            HttpClientRequest.bearerToken('private-token'),
            HttpClientRequest.bodyText('private-request-body'),
          ),
        )
      }
      yield* client.get('https://example.com/anything')
      const { raw, rows } = yield* readRows
      expect(rows).toHaveLength(4)
      expect(rows.map((row) => row.class)).toEqual(['core', 'graphql', 'search', 'actions'])
      expect(rows[0]).toMatchObject({
        schemaVersion: 1,
        source: 'gh-ci-utils',
        route: '/repos/{owner}/{repo}/issues/{id}',
        method: 'POST',
        status: 200,
        rateLimitResource: 'core',
        rateLimitRemaining: 42,
        authKind: 'app',
        agent: null,
      })
      expect(rows[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
      for (const secret of ['private-', 'secret-owner', 'secret-repo', '?', 'set-cookie'])
        expect(raw).not.toContain(secret)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('resolves agent identity without silently picking conflicting aliases', () =>
    Effect.gen(function* () {
      const { client, readRows } = yield* fixture
      process.env.ST_AGENT = 'agent/legacy'
      yield* client.get('https://api.github.com/user')
      process.env.FRACTAL_AGENT = 'agent/current'
      delete process.env.ST_AGENT
      yield* client.get('https://api.github.com/user')
      process.env.ST_AGENT = 'agent/current'
      yield* client.get('https://api.github.com/user')
      process.env.ST_AGENT = 'agent/other'
      yield* client.get('https://api.github.com/user')
      const { rows } = yield* readRows
      expect(rows.map((row) => row.agent)).toEqual([
        'agent/legacy',
        'agent/current',
        'agent/current',
        null,
      ])
      expect(rows.slice(0, 3).every((row) => row.agentConflict === undefined)).toBe(true)
      expect(rows[3]?.agentConflict).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('does not fail requests when the ledger is unwritable and warns only once', () =>
    Effect.gen(function* () {
      const warnings: unknown[] = []
      yield* Effect.gen(function* () {
        const { client, directory } = yield* fixture
        process.env.GH_CI_UTILS_USAGE_LEDGER = directory
        expect((yield* client.get('https://api.github.com/user')).status).toBe(200)
        expect((yield* client.get('https://api.github.com/user')).status).toBe(200)
        yield* flushUsageLedger
      }).pipe(
        Effect.provide(
          Logger.layer(
            [
              Logger.make(({ message }) => {
                warnings.push(message)
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      )
      expect(warnings).toHaveLength(1)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('only removes default daily files strictly older than fourteen UTC days', () =>
    Effect.gen(function* () {
      const { fs, client, directory } = yield* fixture
      process.env.XDG_STATE_HOME = directory
      delete process.env.GH_CI_UTILS_USAGE_LEDGER
      const base = `${directory}/gh-ci-utils`
      yield* fs.makeDirectory(base)
      const today = new Date().toISOString().slice(0, 10)
      const midnight = Date.parse(`${today}T00:00:00.000Z`)
      const old = new Date(midnight - 15 * 86400000).toISOString().slice(0, 10)
      const boundary = new Date(midnight - 14 * 86400000).toISOString().slice(0, 10)
      for (const name of [
        `usage-${old}.jsonl`,
        `usage-${boundary}.jsonl`,
        'unrelated.jsonl',
        `usage-${old}.jsonl.backup`,
      ])
        yield* fs.writeFileString(`${base}/${name}`, '')
      yield* fs.makeDirectory(`${base}/usage-2000-01-01.jsonl`)
      yield* client.get('https://api.github.com/user')
      yield* flushUsageLedger
      expect(yield* fs.exists(`${base}/usage-${old}.jsonl`)).toBe(false)
      for (const name of [
        `usage-${boundary}.jsonl`,
        'unrelated.jsonl',
        `usage-${old}.jsonl.backup`,
        'usage-2000-01-01.jsonl',
        `usage-${today}.jsonl`,
      ])
        expect(yield* fs.exists(`${base}/${name}`)).toBe(true)
      // Retention is opportunistic, at most once per process.
      yield* fs.writeFileString(`${base}/usage-${old}.jsonl`, '')
      yield* client.get('https://api.github.com/user')
      yield* flushUsageLedger
      expect(yield* fs.exists(`${base}/usage-${old}.jsonl`)).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
