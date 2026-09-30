import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, it } from 'vitest'

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
      expect((data.baselineCounts as Record<string, number>).typecheck).toBe(expectedSamples)
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
      expect(body).toContain(`typecheck n=${expectedSamples}`)
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
