import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  pipelineDevenvStepName,
  pipelineExportStepName,
  pipelineIdentityStepName,
  pipelineJobIdentityForName,
} from './pipeline-job-names.ts'
import {
  buildPipelineReport,
  decodePipelineJobsPage,
  decodePipelineRunsPage,
  pipelineGrafanaTraceUrl,
  type PipelineRow,
} from './pipeline-report.ts'
import { deriveJobTraceId } from './pipeline-trace-identity.ts'
import {
  deriveWorkflowReportManagedState,
  extractWorkflowReportManagedState,
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

  it('lists selected main runs even when none supplies an admissible duration', () => {
    const typecheck = options.jobs.find((job) => job.name === 'typecheck')!
    const report = buildPipelineReport({
      ...options,
      baselines: [
        { id: baselineIds[0]!, jobs: [] },
        { id: baselineIds[1]!, jobs: [{ ...typecheck, conclusion: 'failure' }] },
      ],
    })
    const data = report.data!
    expect(data.baselineRunIds).toEqual(baselineIds.slice(0, 2))
    expect((data.baselineCounts as Record<string, number>).typecheck).toBe(0)
    expect(
      (data.rows as readonly { job: string; delta: string }[]).find(
        (row) => row.job === 'typecheck',
      )?.delta,
    ).toBe('no main baseline')
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

  it('does not advertise a trace when the adapter cannot finish, even if export reports success', () => {
    const job = options.jobs.find((candidate) => candidate.name === 'typecheck')!
    const completed = [
      pipelineIdentityStepName,
      pipelineDevenvStepName,
      pipelineExportStepName,
    ].map((name) => ({ name, status: 'completed', conclusion: 'success' as const }))
    const reportFor = (steps: typeof job.steps) =>
      buildPipelineReport({ ...options, jobs: [{ ...job, steps }] })
    const rowFor = (steps: typeof job.steps): PipelineRow =>
      (reportFor(steps).data!.rows as readonly PipelineRow[])[0]!
    const original = reportFor(job.steps)
    expect(rowFor(job.steps)).toMatchObject({ instrumented: false })
    expect(render(original)).toContain('| typecheck | success |')
    expect(render(original)).toContain('| not instrumented |')
    for (const missing of completed) {
      const row = rowFor(completed.filter((step) => step.name !== missing.name))
      expect(row).toMatchObject({ instrumented: false })
      expect(row.traceId).toBeUndefined()
    }
    expect(
      rowFor(
        completed.map((step) =>
          step.name === pipelineDevenvStepName ? { ...step, conclusion: 'failure' } : step,
        ),
      ).traceUrl,
    ).toBeUndefined()
    const instrumented = reportFor(completed)
    expect(rowFor(completed).traceUrl).toContain('grafana.example.test/explore?')
    expect(render(instrumented)).toContain('[Explore](')
    const unfinished = buildPipelineReport({
      ...options,
      jobs: [
        { ...job, steps: completed, status: 'in_progress', conclusion: null, completed_at: null },
      ],
    })
    expect((unfinished.data!.rows as readonly PipelineRow[])[0]).toMatchObject({
      status: 'unfinished',
      instrumented: true,
    })
    expect((unfinished.data!.rows as readonly PipelineRow[])[0]?.traceId).toBeUndefined()
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
          steps: [pipelineIdentityStepName, pipelineDevenvStepName, pipelineExportStepName].map(
            (name) => ({ name, status: 'completed', conclusion: 'success' }),
          ),
        },
      ],
      traceIdForJob: (runId, jobIdentity) => deriveJobTraceId({ runId, ...jobIdentity }),
    })
    expect((report.data!.rows as readonly { traceId?: string }[])[0]?.traceId).toBe(
      'dc8939be377d7ae198ab958b5457787c',
    )
  })

  it('keeps latest jobs from a partial rerun at their own trace attempts and baseline durations', () => {
    const name = 'test (namespace-profile-linux-x86-64)'
    const steps = [pipelineIdentityStepName, pipelineDevenvStepName, pipelineExportStepName].map(
      (stepName) => ({ name: stepName, status: 'completed', conclusion: 'success' }),
    )
    const previous = { ...options.jobs.find((job) => job.name === name)!, run_attempt: 1, steps }
    const rerun = {
      ...options.jobs.find((job) => job.name === 'typecheck')!,
      run_attempt: 2,
      steps,
    }
    const report = buildPipelineReport({
      ...options,
      attempt: 2,
      jobs: [previous, rerun],
      baselines: [
        {
          id: baselineIds[0]!,
          jobs: [
            baselines[0]!.jobs.find((job) => job.name === name)!,
            baselines[0]!.jobs.find((job) => job.name === 'typecheck')!,
          ],
        },
      ],
      traceIdForJob: (runId, identity) => deriveJobTraceId({ runId, ...identity }),
    })
    const rows = report.data!.rows as readonly PipelineRow[]
    expect(rows).toHaveLength(2)
    expect(
      rows.find((row) => row.job === 'test[runner=namespace-profile-linux-x86-64]')?.traceId,
    ).toBe(
      deriveJobTraceId({
        runId: `ci/github/overengineeringstudio%2Feffect-utils/${options.runId}/1`,
        ...pipelineJobIdentityForName(name)!,
      }),
    )
    expect(rows.find((row) => row.job === 'typecheck')?.traceId).toBe(
      deriveJobTraceId({
        runId: `ci/github/overengineeringstudio%2Feffect-utils/${options.runId}/2`,
        ...pipelineJobIdentityForName('typecheck')!,
      }),
    )
    expect(report.data!.baselineCounts).toMatchObject({
      typecheck: 1,
      'test[runner=namespace-profile-linux-x86-64]': 1,
    })
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
    const job = options.jobs.find((candidate) => candidate.name === 'typecheck')!
    const steps = [pipelineIdentityStepName, pipelineDevenvStepName, pipelineExportStepName].map(
      (name) => ({ name, status: 'completed', conclusion: 'success' }),
    )
    const body = render(
      buildPipelineReport({ ...options, jobs: [{ ...job, steps }], grafanaBaseUrl: '' }),
    )
    expect(body).toContain('`a0123456789abcdef0123456789abcde` (link unavailable)')
    expect(body).not.toContain('[Explore](')
  })

  it('replaces old pipeline records instead of growing the embedded comment state', () => {
    const record = buildPipelineReport(options)
    const priorState = deriveWorkflowReportManagedState({
      stateId: 'pipeline-traces',
      entryId: 'old-run/1',
      entryLabel: 'Old run',
      createdAtUtc: options.generatedAtUtc,
      records: [record],
    })
    const currentState = deriveWorkflowReportManagedState({
      stateId: 'pipeline-traces',
      priorState,
      entryId: 'new-run/1',
      entryLabel: 'New run',
      createdAtUtc: options.generatedAtUtc,
      records: [{ ...record, id: 'pipeline-traces:new-run:1' }],
    })
    const body = renderWorkflowReportCommentBody({
      title: 'Pipeline traces',
      noRecordsMessage: 'Jobs API report unavailable.',
      state: currentState,
    })
    expect(body).not.toContain('old-run/1')
    expect(extractWorkflowReportManagedState(body)?.entries.map((entry) => entry.entryId)).toEqual([
      'new-run/1',
    ])
    expect(extractWorkflowReportManagedState(body)?.entries[0]?.records[0]?.data).toBeUndefined()
  })

  it('bounds the 29-job comment before GitHub rejection while noting omitted table rows', () => {
    const report = buildPipelineReport(options)
    const data = report.data!
    const rows = data.rows as readonly { job: string; traceUrl?: string }[]
    expect(rows).toHaveLength(29)
    const oversized = {
      ...report,
      data: {
        ...data,
        rows: rows.map((row) =>
          Object.assign({}, row, {
            instrumented: true,
            traceUrl: `https://grafana.example.test/explore?${'x'.repeat(4_000)}`,
          }),
        ),
      },
    }
    const body = render(oversized)
    expect(body.length).toBeLessThanOrEqual(60_000)
    expect(body).toMatch(/\d+ additional job row\(s\) omitted to fit the GitHub comment limit\./u)
    expect(body).toContain('<summary>Pipeline timeline</summary>')
    expect(extractWorkflowReportManagedState(body)?.entries[0]?.records[0]?.data).toBeUndefined()

    const hugeTimeline = render({
      ...report,
      data: { ...data, gantt: `gantt\n${'x'.repeat(70_000)}` },
    })
    expect(hugeTimeline.length).toBeLessThanOrEqual(60_000)
    expect(hugeTimeline).toContain('Pipeline timeline omitted to fit the GitHub comment limit.')
  })

  it('emits sortable Mermaid task durations with status tags and UTC second precision', () => {
    const job = options.jobs.find((candidate) => candidate.name === 'typecheck')!
    const report = buildPipelineReport({
      ...options,
      jobs: [
        ...options.jobs,
        {
          ...job,
          name: 'failed: synthetic',
          started_at: '2026-09-28T19:28:01.500Z',
          completed_at: '2026-09-28T19:28:01.500Z',
          conclusion: 'failure',
        },
      ],
    })
    const gantt = report.data!.gantt as string
    const lines = gantt.split('\n')
    const taskLines = lines.slice(6)
    expect(lines[1]).toMatch(
      /^    title Pipeline jobs \(start \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC; axis in local time\)$/u,
    )
    expect(lines).toContain('    dateFormat YYYY-MM-DD HH:mm:ssZZ')
    expect(lines).toContain('    todayMarker off')
    expect(taskLines).toHaveLength(20)
    for (const line of taskLines) {
      expect(line).toMatch(
        /^    [^:]+ :(?:(?:crit|done|active), )?job\d+, \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+0000, [1-9]\d*s$/u,
      )
      expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/u)
    }
    expect(taskLines[0]).toBe(
      '    failed synthetic (failure) :crit, job29, 2026-09-28 19:28:01+0000, 1s',
    )
    expect(taskLines.some((line) => line.includes('devenv-perf (cancelled) :done, '))).toBe(true)
    const starts = taskLines.map(
      (line) => line.match(/, (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+0000),/u)![1]!,
    )
    expect(starts).toEqual(starts.toSorted())
  })

  it('preserves UTC instants across a local daylight-saving transition', () => {
    const job = options.jobs.find((candidate) => candidate.name === 'typecheck')!
    const gantt = buildPipelineReport({
      ...options,
      jobs: [
        {
          ...job,
          name: 'before DST fallback',
          started_at: '2026-10-25T00:59:00Z',
          completed_at: '2026-10-25T01:00:00Z',
        },
        {
          ...job,
          name: 'after DST fallback',
          started_at: '2026-10-25T01:00:00Z',
          completed_at: '2026-10-25T01:01:00Z',
        },
      ],
    }).data!.gantt as string
    expect(gantt).toContain('    dateFormat YYYY-MM-DD HH:mm:ssZZ')
    expect(gantt).toContain('before DST fallback (success) :job0, 2026-10-25 00:59:00+0000, 60s')
    expect(gantt).toContain('after DST fallback (success) :job1, 2026-10-25 01:00:00+0000, 60s')
  })

  it('renders the managed comment with a collapsed timeline', () => {
    const body = render(buildPipelineReport(options))
    expect(body).toContain('<details>\n<summary>Pipeline timeline</summary>')
    expect(body).toContain('Task-level durations are not included.')
    expect(body).toMatchSnapshot()
  })
})
