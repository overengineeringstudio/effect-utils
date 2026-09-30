import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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

it('publishes an unavailable report when current workflow metadata cannot be read', async () => {
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
        '--api-base-url',
        `http://127.0.0.1:${address.port}`,
        '--output-path',
        join(scratch, 'record.jsonl'),
      ],
      { env: { ...process.env, GH_TOKEN: 'local-test-token' }, encoding: 'utf8' },
    )
    expect(requestCount).toBe(1)
    const record = parseMarkedWorkflowReportJsonl(stdout).records[0]!
    expect(record.kind).toBe('pipeline-traces-error')
    expect(record.summary).toContain('/repos/overengineeringstudio/effect-utils/actions/runs/421')
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
