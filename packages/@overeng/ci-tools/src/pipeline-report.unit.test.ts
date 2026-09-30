import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pipelineJobIdentityForName } from './pipeline-job-names.ts'
import {
  buildPipelineReport,
  decodePipelineJobsPage,
  decodePipelineRunsPage,
  pipelineGrafanaTraceUrl,
} from './pipeline-report.ts'
import { deriveJobTraceId } from './pipeline-trace-identity.ts'
import {
  deriveWorkflowReportManagedState,
  renderWorkflowReportCommentBody,
  type WorkflowReportRecord,
} from './workflow-report.ts'

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/pipeline-report/${name}`, import.meta.url)),
      'utf8',
    ),
  )
const current = decodePipelineJobsPage(fixture('pr-36472422441-jobs.json'))
const runs = decodePipelineRunsPage(fixture('main-runs.json'))
const baselineIds = [
  33967414987, 33725431515, 33659778853, 33638676661, 33621119349, 33431779835, 33394098167,
]
const baselines = baselineIds.map((id) => ({
  id,
  jobs: decodePipelineJobsPage(fixture(`main-${id}-jobs.json`)).jobs,
}))
const options = {
  repository: 'overengineeringstudio/effect-utils',
  runId: 36472422441,
  attempt: 1,
  jobs: current.jobs,
  baselines,
  generatedAtUtc: '2026-09-28T20:00:00.000Z',
  grafanaBaseUrl: 'https://grafana.example.test',
  traceIdForJob: () => 'a0123456789abcdef0123456789abcde',
} as const

const render = (record: WorkflowReportRecord) =>
  renderWorkflowReportCommentBody({
    title: 'Pipeline traces',
    noRecordsMessage: 'Jobs API report unavailable.',
    state: deriveWorkflowReportManagedState({
      stateId: 'pipeline-traces',
      timeZone: 'UTC',
      entryId: `${options.runId}/${options.attempt}`,
      entryLabel: 'PR 1477',
      createdAtUtc: options.generatedAtUtc,
      records: [record],
    }),
  })

describe('Pipeline traces from recorded public GitHub Jobs API payloads', () => {
  it('selects seven successful same-key main samples despite failed and cancelled candidates', () => {
    expect(
      runs.workflow_runs
        .slice(0, 9)
        .filter((run) => run.conclusion === 'success')
        .map((run) => run.id),
    ).toEqual(baselineIds)
    const report = buildPipelineReport(options)
    const data = report.data!
    expect((data.baselineCounts as Record<string, number>).typecheck).toBe(7)
    expect(data.baselineRunIds as number[]).toEqual(baselineIds)
    expect(
      (data.rows as readonly { job: string; delta: string }[]).find(
        (row) => row.job === 'typecheck',
      )?.delta,
    ).toMatch(/^[+-]\d+\.\ds \(-?\d+\.\d%; n=7\)$/u)
  })

  it('leaves unknown provider names without trace or baseline; skipped and unfinished jobs never acquire a duration', () => {
    const report = buildPipelineReport({
      ...options,
      jobs: [
        ...options.jobs,
        {
          ...options.jobs.find((job) => job.name === 'typecheck')!,
          name: 'unknown (synthetic)',
          started_at: null,
          completed_at: null,
          conclusion: 'skipped',
        },
        {
          ...options.jobs.find((job) => job.name === 'typecheck')!,
          name: 'unfinished (synthetic)',
          completed_at: null,
          status: 'in_progress',
          conclusion: null,
        },
      ],
    })
    const rows = report.data!.rows as readonly { job: string; delta: string; traceUrl?: string }[]
    expect(rows.find((row) => row.job === 'unknown (synthetic)')).toMatchObject({
      delta: 'duration unavailable',
    })
    expect(rows.find((row) => row.job === 'unknown (synthetic)')?.traceUrl).toBeUndefined()
    expect(rows.find((row) => row.job === 'unfinished (synthetic)')?.delta).toBe(
      'duration unavailable',
    )
    expect(pipelineJobIdentityForName('test (namespace-profile-linux-x86-64)')).toEqual({
      job: 'test',
      dimensions: { runner: 'namespace-profile-linux-x86-64' },
    })
  })

  it('keeps zero-duration baselines legible and excludes the attempt-close finalizer', () => {
    const typecheck = options.jobs.find((job) => job.name === 'typecheck')!
    const zeroDuration = { ...typecheck, completed_at: typecheck.started_at }
    const report = buildPipelineReport({
      ...options,
      jobs: [typecheck, { ...typecheck, name: 'pipeline-attempt-close' }],
      baselines: baselineIds.map((id) => ({ id, jobs: [zeroDuration] })),
    })
    const rows = report.data!.rows as readonly { job: string; delta: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.job).toBe('typecheck')
    expect(rows[0]?.delta).toMatch(/^[+-]\d+\.\ds \(percent unavailable; n=7\)$/u)
  })

  it('links the VRS 01 runner vector through the same producer derivation', () => {
    const identity = pipelineJobIdentityForName('test (namespace-profile-linux-x86-64)')!
    expect(
      deriveJobTraceId({
        runId: 'ci/github/overengineeringstudio%2Feffect-utils/421/2',
        ...identity,
      }),
    ).toBe('dc8939be377d7ae198ab958b5457787c')
    const report = buildPipelineReport({
      ...options,
      runId: 421,
      attempt: 2,
      jobs: [
        {
          ...options.jobs.find((job) => job.name === 'test (namespace-profile-linux-x86-64)')!,
          run_attempt: 2,
        },
      ],
      traceIdForJob: (runId, jobIdentity) => deriveJobTraceId({ runId, ...jobIdentity }),
    })
    expect((report.data!.rows as readonly { traceId?: string }[])[0]?.traceId).toBe(
      'dc8939be377d7ae198ab958b5457787c',
    )
  })

  it('uses the exact by-ID Grafana URL and rejects malformed trace IDs', () => {
    expect(
      pipelineGrafanaTraceUrl({
        baseUrl: 'https://grafana.example.test/',
        traceId: 'a0123456789abcdef0123456789abcde',
        startedAt: '2026-09-28T19:28:00Z',
        completedAt: '2026-09-28T19:30:00Z',
      }),
    ).toBe(
      'https://grafana.example.test/explore?schemaVersion=1&orgId=1&panes=%7B%22a%22%3A%7B%22datasource%22%3A%7B%22type%22%3A%22tempo%22%2C%22uid%22%3A%22tempo%22%7D%2C%22queries%22%3A%5B%7B%22refId%22%3A%22A%22%2C%22datasource%22%3A%7B%22type%22%3A%22tempo%22%2C%22uid%22%3A%22tempo%22%7D%2C%22queryType%22%3A%22traceql%22%2C%22query%22%3A%22a0123456789abcdef0123456789abcde%22%7D%5D%2C%22range%22%3A%7B%22from%22%3A%221790622780000%22%2C%22to%22%3A%221790627400000%22%7D%7D%7D',
    )
    expect(
      pipelineGrafanaTraceUrl({
        baseUrl: 'https://grafana.example.test',
        traceId: '../invalid',
        startedAt: '2026-09-28T19:28:00Z',
        completedAt: '2026-09-28T19:30:00Z',
      }),
    ).toBeUndefined()
  })

  it('renders trace identity without a link when the Grafana base is absent', () => {
    const body = render(buildPipelineReport({ ...options, grafanaBaseUrl: '' }))
    expect(body).toContain('`a0123456789abcdef0123456789abcde` (link unavailable)')
    expect(body).not.toContain('[Explore](')
  })

  it('renders the managed comment with a collapsed timeline', () => {
    const body = render(buildPipelineReport(options))
    expect(body).toContain('<details>\n<summary>Pipeline timeline</summary>')
    expect(body).toContain('Task-level durations are not included.')
    expect(body).toMatchSnapshot()
  })
})
