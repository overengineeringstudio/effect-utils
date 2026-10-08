import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { it as effectIt } from '@effect/vitest'
import { Clock, Deferred, Effect, Fiber, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { TestClock } from 'effect/testing'
import { expect, it } from 'vitest'

import { collectPipelineReport } from './pipeline-report.ts'
import {
  deriveWorkflowReportManagedState,
  parseMarkedWorkflowReportJsonl,
  renderWorkflowReportCommentBody,
} from './workflow-report.ts'

const cliPath = fileURLToPath(new URL('../bin/ci-tools.ts', import.meta.url))
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/pipeline-report/${name}`, import.meta.url)),
      'utf8',
    ),
  )
const baselineIds = [
  33967414987, 33725431515, 33659778853, 33638676661, 33621119349, 33431779835, 33394098167,
]

it('publishes an unavailable report when current run jobs fail after bounded retries', async () => {
  let requestCount = 0
  const server = createServer((_request, response) => {
    requestCount += 1
    response.writeHead(503, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ message: 'Service temporarily unavailable' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('Expected an ephemeral HTTP port for the local GitHub API')
  const scratch = mkdtempSync(join(tmpdir(), 'pipeline-report-'))
  try {
    const { stdout } = await promisify(execFile)(
      process.env.BUN_BIN ?? 'bun',
      [
        cliPath,
        'pipeline-report',
        'collect',
        '--repository',
        'overengineeringstudio/effect-utils',
        '--run-id',
        '421',
        '--attempt',
        '1',
        '--workflow-id',
        '219217938',
        '--api-base-url',
        `http://127.0.0.1:${address.port}`,
        '--output-path',
        join(scratch, 'record.jsonl'),
      ],
      { env: { ...process.env, GH_TOKEN: 'local-test-token' }, encoding: 'utf8' },
    )
    expect(requestCount).toBe(4)
    const record = parseMarkedWorkflowReportJsonl(stdout).records[0]!
    expect(record.kind).toBe('pipeline-traces-error')
    expect(record.summary).toContain(
      '/repos/overengineeringstudio/effect-utils/actions/runs/421/jobs',
    )
    const body = renderWorkflowReportCommentBody({
      title: 'Pipeline traces',
      noRecordsMessage: 'Jobs API report unavailable.',
      state: deriveWorkflowReportManagedState({
        stateId: 'pipeline-traces',
        entryId: '421/1',
        entryLabel: 'PR run 421',
        createdAtUtc: record.createdAtUtc,
        records: [record],
      }),
    })
    expect(body).toContain('Jobs API report unavailable:')
    expect(body).toContain('HTTP 503')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(scratch, { recursive: true, force: true })
  }
})

it.each([
  { failedBaseline: undefined, expectedSamples: 7, expectedRequests: 2, rateLimited: false },
  { failedBaseline: baselineIds[3], expectedSamples: 6, expectedRequests: 4, rateLimited: false },
  { failedBaseline: undefined, expectedSamples: 7, expectedRequests: 2, rateLimited: true },
])(
  'renders current jobs after transient failures and isolated baseline failures ($failedBaseline, 429=$rateLimited)',
  async ({ failedBaseline, expectedSamples, expectedRequests, rateLimited }) => {
    const requests = new Map<string, number>()
    let firstRequestAt = 0
    let secondRequestAt = 0
    const runs = fixture('main-runs.json') as { workflow_runs: unknown[]; total_count: number }
    const server = createServer((request, response) => {
      const url = request.url!
      const count = (requests.get(url) ?? 0) + 1
      requests.set(url, count)
      const runId = Number(url.match(/\/actions\/runs\/(\d+)\/jobs/u)?.[1])
      if (runId === baselineIds[0]) {
        if (count === 1) firstRequestAt = Date.now()
        if (count === 2) secondRequestAt = Date.now()
      }
      if (rateLimited === true && runId === baselineIds[0] && count === 1) {
        response.writeHead(429, { 'Retry-After': '2' })
        response.end('rate limited')
        return
      }
      if ((runId === baselineIds[0] && count === 1) || runId === failedBaseline) {
        response.writeHead(502)
        response.end('bad gateway')
        return
      }
      const data =
        url.includes('/actions/runs?') === true
          ? { ...runs, total_count: 9, workflow_runs: runs.workflow_runs.slice(0, 9) }
          : runId === 36472422441
            ? fixture('pr-36472422441-jobs.json')
            : baselineIds.includes(runId) === true
              ? fixture(`main-${runId}-jobs.json`)
              : undefined
      response.writeHead(data === undefined ? 404 : 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(data ?? { message: 'Not found' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('Expected an ephemeral HTTP port for the local GitHub API')
    const scratch = mkdtempSync(join(tmpdir(), 'pipeline-report-'))
    try {
      const { stdout } = await promisify(execFile)(
        process.env.BUN_BIN ?? 'bun',
        [
          cliPath,
          'pipeline-report',
          'collect',
          '--repository',
          'overengineeringstudio/effect-utils',
          '--run-id',
          '36472422441',
          '--attempt',
          '1',
          '--workflow-id',
          '219217938',
          '--api-base-url',
          `http://127.0.0.1:${address.port}`,
          '--output-path',
          join(scratch, 'record.jsonl'),
        ],
        { env: { ...process.env, GH_TOKEN: 'local-test-token' }, encoding: 'utf8' },
      )
      const record = parseMarkedWorkflowReportJsonl(stdout).records[0]!
      expect(record.kind).toBe('pipeline-traces')
      const data = record.data!
      expect((data.baselineCounts as Record<string, number>).weaver).toBe(expectedSamples)
      expect(data.skippedBaselineRunIds).toEqual(
        failedBaseline === undefined ? [] : [failedBaseline],
      )
      expect(
        requests.get(
          `/repos/overengineeringstudio/effect-utils/actions/runs/${failedBaseline ?? baselineIds[0]}/jobs?filter=latest&per_page=100&page=1`,
        ),
      ).toBe(expectedRequests)
      if (rateLimited === true)
        expect(secondRequestAt - firstRequestAt).toBeGreaterThanOrEqual(1_900)
      const body = renderWorkflowReportCommentBody({
        title: 'Pipeline traces',
        noRecordsMessage: 'Jobs API report unavailable.',
        state: deriveWorkflowReportManagedState({
          stateId: 'pipeline-traces',
          entryId: '36472422441/1',
          entryLabel: 'PR run 36472422441',
          createdAtUtc: record.createdAtUtc,
          records: [record],
        }),
      })
      expect(body).toContain(`weaver n=${expectedSamples}`)
      expect(body).toContain(`n=${expectedSamples}`)
      expect(body).not.toContain('Jobs API report unavailable:')
      if (failedBaseline !== undefined)
        expect(body).toContain(`Skipped main run IDs (Jobs API unavailable): ${failedBaseline}.`)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(scratch, { recursive: true, force: true })
    }
  },
  30_000,
)

it.each([
  { failedStage: 'metadata', reason: 'workflow metadata unavailable' },
  { failedStage: 'runs', reason: 'main run listing unavailable' },
])(
  'discloses incomplete baselines when $failedStage lookup fails',
  async ({ failedStage, reason }) => {
    const server = createServer((request, response) => {
      const data =
        request.url?.includes('/jobs?') === true
          ? fixture('pr-36472422441-jobs.json')
          : { message: 'Not found' }
      response.writeHead(request.url?.includes('/jobs?') === true ? 200 : 404, {
        'Content-Type': 'application/json',
      })
      response.end(JSON.stringify(data))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('Expected an ephemeral HTTP port for the local GitHub API')
    try {
      const record = await Effect.runPromise(
        collectPipelineReport({
          repository: 'overengineeringstudio/effect-utils',
          runId: 36472422441,
          attempt: 1,
          ...(failedStage === 'runs' ? { workflowId: 219217938 } : {}),
          token: 'local-test-token',
          grafanaBaseUrl: '',
          generatedAtUtc: '2026-09-28T20:00:00.000Z',
          traceIdForJob: () => undefined,
          apiBaseUrl: `http://127.0.0.1:${address.port}`,
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      )
      expect(record.kind).toBe('pipeline-traces')
      expect(record.data!.rows).toEqual(
        expect.arrayContaining([expect.objectContaining({ job: 'weaver' })]),
      )
      expect(record.data!.baselineIncompleteReason).toBe(reason)
      const body = renderWorkflowReportCommentBody({
        title: 'Pipeline traces',
        noRecordsMessage: 'Jobs API report unavailable.',
        state: deriveWorkflowReportManagedState({
          stateId: 'pipeline-traces',
          entryId: '36472422441/1',
          entryLabel: 'PR run 36472422441',
          createdAtUtc: record.createdAtUtc,
          records: [record],
        }),
      })
      expect(body).toContain(`Baseline incomplete: ${reason}.`)
      expect(body).not.toContain('Jobs API report unavailable:')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
)

effectIt.effect.each([
  { stalled: false, timeoutMs: 250 },
  { stalled: true, timeoutMs: 1_700 },
])(
  'stops baseline collection at its deadline despite $stalled API calls',
  ({ stalled, timeoutMs }) =>
    Effect.gen(function* () {
      const runs = fixture('main-runs.json') as { workflow_runs: unknown[]; total_count: number }
      const firstRequest = yield* Deferred.make<void>()
      const secondRequest = yield* Deferred.make<void>()
      let stalledRequests = 0
      const client = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          if (url.pathname.endsWith(`/runs/${baselineIds[1]}/jobs`) === true) {
            stalledRequests++
            yield* Deferred.succeed(stalledRequests === 1 ? firstRequest : secondRequest, undefined)
            if (stalled === true) return yield* Effect.never
            return HttpClientResponse.fromWeb(
              request,
              new Response('rate limited', { status: 429, headers: { 'Retry-After': '5' } }),
            )
          }
          const runId = Number(url.pathname.match(/\/actions\/runs\/(\d+)\/jobs/u)?.[1])
          const data =
            url.pathname.endsWith('/actions/runs') === true
              ? { ...runs, total_count: 9, workflow_runs: runs.workflow_runs.slice(0, 9) }
              : runId === 36472422441
                ? fixture('pr-36472422441-jobs.json')
                : fixture(`main-${runId}-jobs.json`)
          const body = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
            data,
          ).pipe(Effect.orDie)
          return HttpClientResponse.fromWeb(
            request,
            new Response(body, {
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }),
      )
      const started = yield* Clock.currentTimeMillis
      const collection = yield* collectPipelineReport({
        repository: 'overengineeringstudio/effect-utils',
        runId: 36472422441,
        attempt: 1,
        workflowId: 219217938,
        token: 'local-test-token',
        grafanaBaseUrl: '',
        generatedAtUtc: '2026-09-28T20:00:00.000Z',
        traceIdForJob: () => undefined,
        requestTimeoutMs: 50,
        collectionTimeoutMs: timeoutMs,
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild)

      // Complete successful API work before advancing either deadline.
      yield* Deferred.await(firstRequest)
      if (stalled === true) {
        yield* TestClock.adjust(49)
        expect(stalledRequests).toBe(1)
        yield* TestClock.adjust(1)
        yield* TestClock.adjust(999)
        expect(stalledRequests).toBe(1)
        yield* TestClock.adjust(1)
        yield* Deferred.await(secondRequest)
      }
      const elapsed = (yield* Clock.currentTimeMillis) - started
      yield* TestClock.adjust(timeoutMs - elapsed - 1)
      expect(collection.pollUnsafe()).toBeUndefined()
      expect(stalledRequests).toBe(stalled === true ? 2 : 1)

      yield* TestClock.adjust(1)
      const record = yield* Fiber.join(collection)
      expect(record.kind).toBe('pipeline-traces')
      expect(record.data!.baselineCounts).toMatchObject({ weaver: 1 })
      expect(record.data!.skippedBaselineRunIds).toEqual([baselineIds[1]])
      expect(record.data!.baselineIncompleteReason).toBe('collection deadline exceeded')
      expect(stalledRequests).toBe(stalled === true ? 2 : 1)
      expect((yield* Clock.currentTimeMillis) - started).toBe(timeoutMs)
    }),
)
