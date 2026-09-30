import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import {
  deriveWorkflowReportManagedState,
  parseMarkedWorkflowReportJsonl,
  renderWorkflowReportCommentBody,
} from './workflow-report.ts'

const cliPath = fileURLToPath(new URL('../bin/ci-tools.ts', import.meta.url))

it('publishes an unavailable report when current workflow metadata cannot be read', async () => {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      return new Response(JSON.stringify({ message: 'Service temporarily unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  const scratch = mkdtempSync(join(tmpdir(), 'pipeline-report-'))
  try {
    const child = Bun.spawn(
      [
        process.env.BUN_BIN ?? 'bun',
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
        `http://127.0.0.1:${server.port}`,
        '--output-path',
        join(scratch, 'record.jsonl'),
      ],
      {
        env: { ...process.env, GH_TOKEN: 'local-test-token' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stderr).toBe(0)
    expect(requests).toEqual(['/repos/overengineeringstudio/effect-utils/actions/runs/421'])
    const record = parseMarkedWorkflowReportJsonl(stdout).records[0]!
    expect(record.kind).toBe('pipeline-traces-error')
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
    server.stop(true)
    rmSync(scratch, { recursive: true, force: true })
  }
})
