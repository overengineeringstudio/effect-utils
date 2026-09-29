import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { deriveJobTraceId } from '@overeng/ci-tools'

import { WorkflowJob } from '../src/isomorphic/GitHubSchemas.ts'
import { jobTraceUrl, renderJobTraces } from '../src/node/commands/traces.ts'

const makeJob = ({
  id,
  name,
  attempt = 2,
  status = 'completed',
  conclusion = 'success',
  startedAt = '2026-09-29T10:00:00.000Z',
  completedAt = '2026-09-29T10:10:00.000Z',
}: {
  id: number
  name: string
  attempt?: number
  status?: string
  conclusion?: string | null
  startedAt?: string | null
  completedAt?: string | null
}) =>
  Schema.decodeUnknownSync(WorkflowJob)({
    id,
    run_id: 421,
    run_attempt: attempt,
    name,
    status,
    conclusion,
    started_at: startedAt,
    completed_at: completedAt,
    runner_name: null,
    labels: [],
    steps: [],
  })

const args = {
  repo: 'overengineeringstudio/effect-utils',
  prNumber: 77,
  run: { id: 421, run_attempt: 2 },
  grafanaBaseUrl: 'https://grafana.example.test',
  reportedAt: new Date('2026-09-29T10:20:00.000Z'),
}

const traceId = '0123456789abcdef0123456789abcdef'

describe('Grafana trace URLs', () => {
  it('produces the specified Explore URL and timestamp window in deterministic JSON order', () => {
    const url = jobTraceUrl({
      grafanaBaseUrl: args.grafanaBaseUrl,
      traceId,
      startedAt: new Date('2026-09-29T10:00:00.000Z'),
      completedAt: new Date('2026-09-29T10:10:00.000Z'),
    })
    const panes = {
      a: {
        datasource: { type: 'tempo', uid: 'tempo' },
        queries: [
          {
            refId: 'A',
            datasource: { type: 'tempo', uid: 'tempo' },
            queryType: 'traceql',
            query: traceId,
          },
        ],
        range: { from: '1790675100000', to: '1790680200000' },
      },
    }
    expect(url).toBe(
      `https://grafana.example.test/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`,
    )
    expect(
      jobTraceUrl({
        grafanaBaseUrl: args.grafanaBaseUrl,
        traceId: 'not-a-trace-id',
        startedAt: args.reportedAt,
        completedAt: args.reportedAt,
      }),
    ).toBeUndefined()
  })

  it('maps Jobs API names to the producer identity, filtering other attempts, duplicate names, unknown and unstarted jobs', () => {
    const output = renderJobTraces({
      ...args,
      jobs: [
        makeJob({ id: 1, name: 'test (namespace-profile-linux-x86-64)' }),
        makeJob({ id: 2, name: 'typecheck', attempt: 1 }),
        makeJob({ id: 3, name: 'typecheck', conclusion: 'skipped' }),
        makeJob({ id: 4, name: 'unknown-dynamic-name' }),
        makeJob({ id: 5, name: 'lint' }),
        makeJob({ id: 6, name: 'lint', conclusion: 'failure' }),
        makeJob({ id: 7, name: 'pipeline-attempt-close' }),
        makeJob({ id: 9, name: 'weaver', conclusion: 'cancelled' }),
        makeJob({
          id: 10,
          name: 'bundle-smoke',
          status: 'queued',
          conclusion: null,
          startedAt: null,
          completedAt: null,
        }),
      ],
    })
    const canonical = deriveJobTraceId(
      'ci/github/overengineeringstudio%2Feffect-utils/421/2',
      'test',
      { runner: 'namespace-profile-linux-x86-64' },
    )
    expect(output).toContain(
      `test (namespace-profile-linux-x86-64): completed (success)\n    ${canonical} https://grafana.example.test/explore?`,
    )
    expect(output).toContain('typecheck: completed (skipped) — trace unavailable (not started)')
    expect(output).toContain(
      'unknown-dynamic-name: completed (success) — trace unavailable (unmatched job name)',
    )
    expect(output).toContain('lint: completed (failure) — trace unavailable (unmatched job name)')
    expect(output).toMatch(
      /weaver: completed \(cancelled\)\n    [0-9a-f]{32} https:\/\/grafana\.example\.test\/explore\?/,
    )
    expect(output).toContain('bundle-smoke: queued — trace unavailable (not started)')
    expect(output).not.toContain('pipeline-attempt-close')
    expect(output).not.toContain('typecheck: completed (success)')
    expect(output).not.toContain('exported successfully')
  })

  it('gives a started unfinished job a report-time window', () => {
    const output = renderJobTraces({
      ...args,
      jobs: [
        makeJob({
          id: 8,
          name: 'cargo',
          status: 'in_progress',
          conclusion: null,
          completedAt: null,
        }),
      ],
    })
    expect(output).toContain('cargo: in_progress')
    const line = output.split('\n').find((part) => part.includes('/explore?'))
    const url = new URL(line!.trim().split(' ')[1]!)
    const panes = JSON.parse(url.searchParams.get('panes')!)
    expect(panes.a.range.to).toBe(String(args.reportedAt.getTime() + 60 * 60_000))
  })
})
