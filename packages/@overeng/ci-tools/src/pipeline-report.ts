import { Effect, Schema } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'

import { pipelineJobIdentityForName, type PipelineJobIdentity } from './pipeline-job-names.ts'
import { canonicalJobKey } from './pipeline-trace-identity.ts'
import type { WorkflowReportRecord } from './workflow-report.ts'

const NullableString = Schema.Union([Schema.String, Schema.Null])
const Job = Schema.Struct({
  name: Schema.String,
  run_attempt: Schema.Number,
  status: Schema.String,
  conclusion: NullableString,
  started_at: NullableString,
  completed_at: NullableString,
})
const JobsPage = Schema.Struct({ total_count: Schema.Number, jobs: Schema.Array(Job) })
/** Bound main-history API work even when a PR-only job has no main samples. */
export const maxBaselineRuns = 20

const Run = Schema.Struct({
  id: Schema.Number,
  run_attempt: Schema.Number,
  head_branch: Schema.String,
  event: Schema.String,
  status: Schema.String,
  conclusion: NullableString,
  workflow_id: Schema.Number,
})
const RunsPage = Schema.Struct({ total_count: Schema.Number, workflow_runs: Schema.Array(Run) })
export type PipelineJob = typeof Job.Type
export type PipelineRun = typeof Run.Type

export const decodePipelineJobsPage = Schema.decodeUnknownSync(JobsPage)
export const decodePipelineRunsPage = Schema.decodeUnknownSync(RunsPage)

export type PipelineRow = {
  readonly job: string
  readonly status: string
  readonly wallTime: string
  readonly delta: string
  readonly traceId?: string
  readonly traceUrl?: string
}

export type PipelineReportData = {
  readonly rows: readonly PipelineRow[]
  readonly gantt?: string
  readonly omittedBars: number
  readonly baselineRunIds: readonly number[]
  readonly baselineCounts: Readonly<Record<string, number>>
  readonly counts: Readonly<Record<string, number>>
}

const PipelineRowSchema = Schema.Struct({
  job: Schema.String,
  status: Schema.String,
  wallTime: Schema.String,
  delta: Schema.String,
  traceId: Schema.optional(Schema.String),
  traceUrl: Schema.optional(Schema.String),
})
const PipelineReportDataSchema = Schema.Struct({
  rows: Schema.Array(PipelineRowSchema),
  gantt: Schema.optional(Schema.String),
  omittedBars: Schema.Number,
  baselineRunIds: Schema.Array(Schema.Number),
  baselineCounts: Schema.Record(Schema.String, Schema.Number),
  counts: Schema.Record(Schema.String, Schema.Number),
})
export const decodePipelineReportData = Schema.decodeUnknownSync(PipelineReportDataSchema)

const wallTimeMs = (job: PipelineJob): number | undefined => {
  if (job.conclusion === 'skipped' || job.status !== 'completed') return undefined
  if (job.started_at === null || job.completed_at === null) return undefined
  const duration = Date.parse(job.completed_at) - Date.parse(job.started_at)
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

const jobStatus = (job: PipelineJob): string =>
  job.status === 'completed' ? (job.conclusion ?? 'unfinished') : 'unfinished'

const seconds = (ms: number): string => {
  const rounded = Math.round(ms / 1000)
  return `${Math.floor(rounded / 60)}m ${String(rounded % 60).padStart(2, '0')}s`
}

const signedSeconds = (ms: number): string => `${ms >= 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(1)}s`

const median = (samples: readonly number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** Grafana's exact by-ID query shape, including the documented key order. */
export const pipelineGrafanaTraceUrl = (opts: {
  readonly baseUrl: string
  readonly traceId: string
  readonly startedAt: string
  readonly completedAt: string
}): string | undefined => {
  if (/^[0-9a-f]{32}$/.test(opts.traceId) === false) return undefined
  if (opts.baseUrl.length === 0 || /^https?:\/\/[^/\s?#]+\/?$/u.test(opts.baseUrl) === false) return undefined
  const start = Date.parse(opts.startedAt)
  const end = Date.parse(opts.completedAt)
  if (Number.isFinite(start) === false || Number.isFinite(end) === false) return undefined
  const panes = {
    a: {
      datasource: { type: 'tempo', uid: 'tempo' },
      queries: [
        {
          refId: 'A',
          datasource: { type: 'tempo', uid: 'tempo' },
          queryType: 'traceql',
          query: opts.traceId,
        },
      ],
      range: { from: String(start - 15 * 60_000), to: String(end + 60 * 60_000) },
    },
  }
  return `${opts.baseUrl.replace(/\/+$/u, '')}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`
}

const mermaidLabel = (name: string): string =>
  name.replace(/[\r\n:;#%\[\]<>`]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 100)

const canonicalKey = (identity: PipelineJobIdentity): string =>
  `${identity.job}${Object.entries(identity.dimensions).map(([key, value]) => `[${key}=${value}]`).join('')}`

export const buildPipelineReport = (opts: {
  readonly repository: string
  readonly runId: number
  readonly attempt: number
  readonly jobs: readonly PipelineJob[]
  readonly baselines: readonly { readonly id: number; readonly jobs: readonly PipelineJob[] }[]
  readonly generatedAtUtc: string
  readonly grafanaBaseUrl: string
  readonly traceIdForJob: (runId: string, identity: PipelineJobIdentity) => string | undefined
}): WorkflowReportRecord => {
  const current = opts.jobs.filter((job) => job.run_attempt === opts.attempt && job.name !== 'pipeline-traces' && job.name !== 'evidence-attempt-close' && job.name !== 'evidence-pr-link')
  const runIdentity = `ci/github/${encodeURIComponent(opts.repository)}/${opts.runId}/${opts.attempt}`
  const duplicateNames = new Set<string>()
  const countsByName: Record<string, number> = {}
  for (const job of current) countsByName[job.name] = (countsByName[job.name] ?? 0) + 1
  for (const [name, count] of Object.entries(countsByName)) if (count > 1) duplicateNames.add(name)

  const baselineCounts: Record<string, number> = {}
  const baselineIndex = opts.baselines.map((baseline) => {
    const durations = new Map<string, number>()
    const duplicates = new Set<string>()
    for (const candidate of baseline.jobs) {
      const identity = pipelineJobIdentityForName(candidate.name)
      const duration = wallTimeMs(candidate)
      if (identity === undefined || candidate.conclusion !== 'success' || duration === undefined) continue
      const key = canonicalJobKey(identity.job, identity.dimensions).toString('hex')
      if (durations.has(key)) duplicates.add(key)
      else durations.set(key, duration)
    }
    for (const key of duplicates) durations.delete(key)
    return { id: baseline.id, durations }
  })

  const baselineRunIds = new Set<number>()
  const counts: Record<string, number> = {}
  let omittedBars = 0
  const bars: string[] = []
  const rows = current.map((job, index): PipelineRow => {
    const identity = duplicateNames.has(job.name) ? undefined : pipelineJobIdentityForName(job.name)
    const key = identity === undefined ? job.name : canonicalKey(identity)
    const status = jobStatus(job)
    counts[status] = (counts[status] ?? 0) + 1
    const wallMs = wallTimeMs(job)
    const samples: number[] = []
    if (identity !== undefined) {
      const identityKey = canonicalJobKey(identity.job, identity.dimensions).toString('hex')
      for (const baseline of baselineIndex) {
        const duration = baseline.durations.get(identityKey)
        if (duration === undefined) continue
        samples.push(duration)
        baselineRunIds.add(baseline.id)
        if (samples.length === 7) break
      }
    }
    baselineCounts[key] = samples.length
    const p50 = samples.length === 0 ? undefined : median(samples)
    const delta =
      wallMs === undefined
        ? 'duration unavailable'
        : p50 === undefined
          ? 'no main baseline'
          : `${signedSeconds(wallMs - p50)} (${(100 * (wallMs - p50) / p50).toFixed(1)}%; n=${samples.length})`
    const start = job.started_at === null || status === 'skipped' ? undefined : Date.parse(job.started_at)
    const end = job.completed_at === null ? Date.parse(opts.generatedAtUtc) : Date.parse(job.completed_at)
    if (start !== undefined && Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      const label = mermaidLabel(`${key} (${status})`)
      bars.push(`${label} :${status === 'unfinished' ? 'active, ' : ''}job${index}, ${new Date(start).toISOString()}, ${new Date(end).toISOString()}`)
    } else omittedBars++
    const traceId = identity === undefined || start === undefined
      ? undefined
      : opts.traceIdForJob(runIdentity, identity)
    const traceUrl = traceId === undefined || job.started_at === null
      ? undefined
      : pipelineGrafanaTraceUrl({
          baseUrl: opts.grafanaBaseUrl,
          traceId,
          startedAt: job.started_at,
          completedAt: job.completed_at ?? opts.generatedAtUtc,
        })
    return {
      job: key,
      status,
      wallTime: wallMs === undefined ? 'unavailable' : seconds(wallMs),
      delta,
      ...(traceId === undefined ? {} : { traceId }),
      ...(traceUrl === undefined ? {} : { traceUrl }),
    }
  })
  const starts = current.filter((job) => job.started_at !== null && job.conclusion !== 'skipped').map((job) => Date.parse(job.started_at!))
  const earliest = Math.min(...starts)
  const gantt = bars.length === 0 || !Number.isFinite(earliest)
    ? undefined
    : ['gantt', `    title Pipeline jobs (from ${new Date(earliest).toISOString()})`, '    dateFormat YYYY-MM-DDTHH:mm:ss.SSSZ', '    axisFormat %H:%M', '    section Jobs', ...bars.map((bar) => `    ${bar}`)].join('\n')
  const data: PipelineReportData = { rows, ...(gantt === undefined ? {} : { gantt }), omittedBars, baselineRunIds: [...baselineRunIds], baselineCounts, counts }
  return {
    _tag: 'WorkflowReportRecord',
    schemaVersion: 1,
    id: `pipeline-traces:${opts.runId}:${opts.attempt}`,
    kind: 'pipeline-traces',
    subject: { id: 'pipeline-traces', label: `Run ${opts.runId} · attempt ${opts.attempt}` },
    status: counts.failure ? 'failure' : 'neutral',
    title: 'Pipeline traces',
    summary: `${rows.length} jobs; ${counts.success ?? 0} successful, ${counts.failure ?? 0} failed, ${counts.cancelled ?? 0} cancelled, ${counts.skipped ?? 0} skipped`,
    createdAtUtc: opts.generatedAtUtc,
    data,
  }
}

const githubJson = Effect.fn('ci-tools.pipeline-report.github-json')(function* <T extends Schema.Schema<unknown>>(opts: {
  readonly path: string
  readonly token: string
  readonly schema: T
  readonly apiBaseUrl: string
}) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(HttpClientRequest.get(`${opts.apiBaseUrl}${opts.path}`).pipe(
    HttpClientRequest.setHeader('Authorization', `Bearer ${opts.token}`),
    HttpClientRequest.setHeader('Accept', 'application/vnd.github+json'),
    HttpClientRequest.setHeader('X-GitHub-Api-Version', '2022-11-28'),
  ))
  if (response.status < 200 || response.status >= 300) return yield* Effect.fail(new Error(`GitHub API ${opts.path}: HTTP ${response.status}`))
  return yield* Schema.decodeUnknownEffect(opts.schema)(yield* response.json)
})

export const collectPipelineReport = Effect.fn('ci-tools.pipeline-report.collect')(function* (opts: {
  readonly repository: string
  readonly runId: number
  readonly attempt: number
  readonly workflowId: number
  readonly token: string
  readonly grafanaBaseUrl: string
  readonly generatedAtUtc: string
  readonly traceIdForJob: (runId: string, identity: PipelineJobIdentity) => string | undefined
  readonly apiBaseUrl?: string
}) {
  const apiBaseUrl = (opts.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/u, '')
  const repoPath = opts.repository.split('/').map(encodeURIComponent).join('/')
  const get = <T extends Schema.Schema<unknown>>(path: string, schema: T) => githubJson({ path, schema, token: opts.token, apiBaseUrl })
  const jobs: PipelineJob[] = []
  for (let page = 1; ; page++) {
    const payload = yield* get(`/repos/${repoPath}/actions/runs/${opts.runId}/jobs?filter=all&per_page=100&page=${page}`, JobsPage)
    jobs.push(...payload.jobs)
    if (jobs.length >= payload.total_count || payload.jobs.length === 0) break
  }
  const wantedKeys = new Set(jobs.filter((job) => job.run_attempt === opts.attempt).flatMap((job) => {
    const identity = pipelineJobIdentityForName(job.name)
    return identity === undefined ? [] : [canonicalJobKey(identity.job, identity.dimensions).toString('hex')]
  }))
  const counts: Record<string, number> = {}
  const baselines: { id: number; jobs: PipelineJob[] }[] = []
  let examined = 0
  for (let page = 1; ; page++) {
    const payload = yield* get(`/repos/${repoPath}/actions/runs?branch=main&event=push&status=completed&per_page=100&page=${page}`, RunsPage)
    const candidates = payload.workflow_runs.filter((run) => run.workflow_id === opts.workflowId && run.head_branch === 'main' && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success')
    for (const run of candidates) {
      if (baselines.length === maxBaselineRuns || [...wantedKeys].every((key) => (counts[key] ?? 0) >= 7)) break
      const candidateJobs: PipelineJob[] = []
      for (let jobsPage = 1; ; jobsPage++) {
        const response = yield* get(`/repos/${repoPath}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${jobsPage}`, JobsPage)
        candidateJobs.push(...response.jobs.filter((job) => job.run_attempt === run.run_attempt))
        if (jobsPage * 100 >= response.total_count || response.jobs.length === 0) break
      }
      baselines.push({ id: run.id, jobs: candidateJobs })
      const seen = new Set<string>()
      for (const job of candidateJobs) {
        const identity = pipelineJobIdentityForName(job.name)
        if (identity === undefined || job.conclusion !== 'success' || wallTimeMs(job) === undefined) continue
        const key = canonicalJobKey(identity.job, identity.dimensions).toString('hex')
        if (wantedKeys.has(key) && !seen.has(key) && (counts[key] ?? 0) < 7) {
          counts[key] = (counts[key] ?? 0) + 1
          seen.add(key)
        }
      }
    }
    examined += payload.workflow_runs.length
    if (baselines.length === maxBaselineRuns || [...wantedKeys].every((key) => (counts[key] ?? 0) >= 7) || examined >= payload.total_count || payload.workflow_runs.length === 0) break
  }
  return buildPipelineReport({ ...opts, jobs, baselines })
})
