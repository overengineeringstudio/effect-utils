import { Duration, Effect, Schedule, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

import {
  pipelineDevenvStepName,
  pipelineExportStepName,
  pipelineIdentityStepName,
  pipelineJobIdentityForName,
  type PipelineJobIdentity,
} from './pipeline-job-names.ts'
import { canonicalJobKey } from './pipeline-trace-identity.ts'
import type { WorkflowReportRecord } from './workflow-report.ts'

const NullableString = Schema.Union([Schema.String, Schema.Null])
const JobStep = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: NullableString,
})
const Job = Schema.Struct({
  name: Schema.String,
  run_attempt: Schema.Finite,
  status: Schema.String,
  conclusion: NullableString,
  started_at: NullableString,
  completed_at: NullableString,
  steps: Schema.Array(JobStep),
})
const JobsPage = Schema.Struct({ total_count: Schema.Finite, jobs: Schema.Array(Job) })
/** Bound main-history API work even when a PR-only job has no main samples. */
export const maxBaselineRuns = 20

const Run = Schema.Struct({
  id: Schema.Finite,
  run_attempt: Schema.Finite,
  head_branch: Schema.String,
  event: Schema.String,
  status: Schema.String,
  conclusion: NullableString,
  workflow_id: Schema.Finite,
})
const RunsPage = Schema.Struct({ total_count: Schema.Finite, workflow_runs: Schema.Array(Run) })
const WorkflowIdentity = Schema.Struct({ workflow_id: Schema.Finite })
export type PipelineJob = typeof Job.Type
export type PipelineRun = typeof Run.Type

/** Decodes paginated GitHub Jobs API facts used for attempt and main baselines. */
export const decodePipelineJobsPage = Schema.decodeUnknownSync(JobsPage)
/** Decodes GitHub workflow-run candidates before selecting successful main pushes. */
export const decodePipelineRunsPage = Schema.decodeUnknownSync(RunsPage)

/** One provider job's rendered status, duration, baseline delta, and optional trace link. */
export type PipelineRow = {
  readonly job: string
  readonly status: string
  readonly wallTime: string
  readonly delta: string
  readonly instrumented: boolean
  readonly traceId?: string
  readonly traceUrl?: string
}

/** Typed data retained with the report for its table, gantt, and baseline audit. */
export type PipelineReportData = {
  readonly rows: readonly PipelineRow[]
  readonly gantt?: string
  readonly omittedBars: number
  readonly baselineRunIds: readonly number[]
  readonly skippedBaselineRunIds: readonly number[]
  readonly baselineCounts: Readonly<Record<string, number>>
  readonly counts: Readonly<Record<string, number>>
}

const PipelineRowSchema = Schema.Struct({
  job: Schema.String,
  status: Schema.String,
  wallTime: Schema.String,
  delta: Schema.String,
  instrumented: Schema.Boolean,
  traceId: Schema.optional(Schema.String),
  traceUrl: Schema.optional(Schema.String),
})
const PipelineReportDataSchema = Schema.Struct({
  rows: Schema.Array(PipelineRowSchema),
  gantt: Schema.optional(Schema.String),
  omittedBars: Schema.Finite,
  baselineRunIds: Schema.Array(Schema.Finite),
  skippedBaselineRunIds: Schema.Array(Schema.Finite),
  baselineCounts: Schema.Record(Schema.String, Schema.Finite),
  counts: Schema.Record(Schema.String, Schema.Finite),
})
/** Validates a decoded record's timeline and baseline counts before rendering. */
export const decodePipelineReportData = Schema.decodeUnknownSync(PipelineReportDataSchema)

const wallTimeMs = (job: PipelineJob): number | undefined => {
  if (job.conclusion === 'skipped' || job.status !== 'completed') return undefined
  if (job.started_at === null || job.completed_at === null) return undefined
  const duration = Date.parse(job.completed_at) - Date.parse(job.started_at)
  return Number.isFinite(duration) === true && duration >= 0 ? duration : undefined
}

const jobStatus = (job: PipelineJob): string =>
  job.status === 'completed' ? (job.conclusion ?? 'unfinished') : 'unfinished'

const seconds = (ms: number): string => {
  const rounded = Math.round(ms / 1000)
  return `${Math.floor(rounded / 60)}m ${String(rounded % 60).padStart(2, '0')}s`
}

const signedSeconds = (ms: number): string =>
  `${ms >= 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(1)}s`

const median = (samples: readonly number[]): number => {
  const sorted = samples.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** Grafana's exact by-ID query shape, including the documented key order. */
export const pipelineGrafanaTraceUrl = (opts: {
  readonly baseUrl: string
  readonly traceId: string
  readonly startedAt: string
  readonly completedAt: string
}): string | undefined => {
  if (/^[0-9a-f]{32}$/.test(opts.traceId) === false) return undefined
  if (opts.baseUrl.length === 0 || /^https?:\/\/[^/\s?#]+\/?$/u.test(opts.baseUrl) === false)
    return undefined
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
  name
    .replace(/[\r\n:;#%[\]<>`]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 100)

const canonicalKey = (identity: PipelineJobIdentity): string =>
  `${identity.job}${Object.entries(identity.dimensions)
    .map(([key, value]) => `[${key}=${value}]`)
    .join('')}`

// Historical attempts still expose the two retired finalizer names in Jobs API.
const nonBuildJobNames = new Set([
  'pipeline-traces',
  'pipeline-attempt-close',
  'evidence-attempt-close',
  'evidence-pr-link',
])
const isBuildJob = (name: string): boolean => nonBuildJobNames.has(name) === false

/** Builds the attempt-scoped report from provider jobs and bounded main-run baselines. */
export const buildPipelineReport = (opts: {
  readonly repository: string
  readonly runId: number
  readonly attempt: number
  readonly jobs: readonly PipelineJob[]
  readonly baselines: readonly { readonly id: number; readonly jobs: readonly PipelineJob[] }[]
  readonly skippedBaselineRunIds?: readonly number[]
  readonly generatedAtUtc: string
  readonly grafanaBaseUrl: string
  readonly traceIdForJob: (runId: string, identity: PipelineJobIdentity) => string | undefined
}): WorkflowReportRecord => {
  const current = opts.jobs.filter((job) => isBuildJob(job.name))
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
      if (identity === undefined || candidate.conclusion !== 'success' || duration === undefined)
        continue
      const key = canonicalJobKey(identity).toString('hex')
      if (durations.has(key) === true) duplicates.add(key)
      else durations.set(key, duration)
    }
    for (const key of duplicates) durations.delete(key)
    return { id: baseline.id, durations }
  })

  const baselineRunIds = opts.baselines.map((baseline) => baseline.id)
  const counts: Record<string, number> = {}
  let omittedBars = 0
  const bars: string[] = []
  const rows = current.map((job, index): PipelineRow => {
    const identity =
      duplicateNames.has(job.name) === true ? undefined : pipelineJobIdentityForName(job.name)
    const key = identity === undefined ? job.name : canonicalKey(identity)
    const status = jobStatus(job)
    counts[status] = (counts[status] ?? 0) + 1
    const wallMs = wallTimeMs(job)
    const samples: number[] = []
    if (identity !== undefined) {
      const identityKey = canonicalJobKey(identity).toString('hex')
      for (const baseline of baselineIndex) {
        const duration = baseline.durations.get(identityKey)
        if (duration === undefined) continue
        samples.push(duration)
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
          : p50 === 0
            ? `${signedSeconds(wallMs)} (percent unavailable; n=${samples.length})`
            : `${signedSeconds(wallMs - p50)} (${((100 * (wallMs - p50)) / p50).toFixed(1)}%; n=${samples.length})`
    const start =
      job.started_at === null || status === 'skipped' ? undefined : Date.parse(job.started_at)
    const end =
      job.completed_at === null ? Date.parse(opts.generatedAtUtc) : Date.parse(job.completed_at)
    if (
      start !== undefined &&
      Number.isFinite(start) === true &&
      Number.isFinite(end) === true &&
      end >= start
    ) {
      const label = mermaidLabel(`${key} (${status})`)
      bars.push(
        `${label} :${status === 'unfinished' ? 'active, ' : ''}job${index}, ${new Date(start).toISOString()}, ${new Date(end).toISOString()}`,
      )
    } else omittedBars++
    // The adapter returns before emitting a root without identity or devenv, even
    // when its always() export step itself reports success.
    const instrumented = [
      pipelineIdentityStepName,
      pipelineDevenvStepName,
      pipelineExportStepName,
    ].every((name) =>
      job.steps.some(
        (step) =>
          step.name === name && step.status === 'completed' && step.conclusion === 'success',
      ),
    )
    const traceId =
      identity === undefined ||
      start === undefined ||
      status === 'unfinished' ||
      instrumented === false
        ? undefined
        : opts.traceIdForJob(
            `ci/github/${encodeURIComponent(opts.repository)}/${opts.runId}/${job.run_attempt}`,
            identity,
          )
    const traceUrl =
      traceId === undefined || job.started_at === null
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
      instrumented,
      ...(traceId === undefined ? {} : { traceId }),
      ...(traceUrl === undefined ? {} : { traceUrl }),
    }
  })
  const starts = current
    .filter((job) => job.started_at !== null && job.conclusion !== 'skipped')
    .map((job) => Date.parse(job.started_at!))
  const earliest = Math.min(...starts)
  const gantt =
    bars.length === 0 || Number.isFinite(earliest) === false
      ? undefined
      : [
          'gantt',
          `    title Pipeline jobs (from ${new Date(earliest).toISOString()})`,
          '    dateFormat YYYY-MM-DDTHH:mm:ss.SSSZ',
          '    axisFormat %H:%M',
          '    section Jobs',
          ...bars.map((bar) => `    ${bar}`),
        ].join('\n')
  const data: PipelineReportData = {
    rows,
    ...(gantt === undefined ? {} : { gantt }),
    omittedBars,
    skippedBaselineRunIds: opts.skippedBaselineRunIds ?? [],
    baselineRunIds,
    baselineCounts,
    counts,
  }
  return {
    _tag: 'WorkflowReportRecord',
    schemaVersion: 1,
    id: `pipeline-traces:${opts.runId}:${opts.attempt}`,
    kind: 'pipeline-traces',
    subject: { id: 'pipeline-traces', label: `Run ${opts.runId} · attempt ${opts.attempt}` },
    status: (counts.failure ?? 0) > 0 ? 'failure' : 'neutral',
    title: 'Pipeline traces',
    summary: `${rows.length} jobs; ${counts.success ?? 0} successful, ${counts.failure ?? 0} failed, ${counts.cancelled ?? 0} cancelled, ${counts.skipped ?? 0} skipped`,
    createdAtUtc: opts.generatedAtUtc,
    data,
  }
}

class PipelineReportGitHubApiError extends Schema.TaggedError<PipelineReportGitHubApiError>(
  '@overeng/ci-tools/pipeline-report/GitHubApiError',
)('PipelineReportGitHubApiError', {
  message: Schema.String,
  path: Schema.String,
  status: Schema.Finite,
  retryAfterMs: Schema.optional(Schema.Finite),
}) {}

const retryAfterMs = (header: string | undefined): number | undefined => {
  if (header === undefined) return undefined
  const secondsValue = Number(header)
  const delay =
    Number.isFinite(secondsValue) === true ? secondsValue * 1000 : Date.parse(header) - Date.now()
  return Number.isFinite(delay) === true ? Math.max(0, delay) : undefined
}

const githubRetrySchedule = Schedule.exponential('1 second').pipe(
  Schedule.modifyDelay(({ duration, input }) =>
    Effect.succeed(
      Math.min(
        5_000,
        Math.max(
          Duration.toMillis(duration),
          input instanceof PipelineReportGitHubApiError ? (input.retryAfterMs ?? 0) : 0,
        ),
      ),
    ),
  ),
  Schedule.upTo({ times: 3 }),
)

const githubJson = Effect.fn('ci-tools.pipeline-report.github-json')(function* <
  T extends Schema.Schema<unknown>,
>(opts: {
  readonly path: string
  readonly token: string
  readonly schema: T
  readonly apiBaseUrl: string
}) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(
    HttpClientRequest.get(`${opts.apiBaseUrl}${opts.path}`).pipe(
      HttpClientRequest.setHeader('Authorization', `Bearer ${opts.token}`),
      HttpClientRequest.setHeader('Accept', 'application/vnd.github+json'),
      HttpClientRequest.setHeader('X-GitHub-Api-Version', '2022-11-28'),
    ),
  )
  if (response.status < 200 || response.status >= 300) {
    const retryAfter =
      response.status === 429 ? retryAfterMs(response.headers['retry-after']) : undefined
    return yield* new PipelineReportGitHubApiError({
      message: `GitHub API ${opts.path}: HTTP ${response.status}`,
      path: opts.path,
      status: response.status,
      ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
    })
  }
  return yield* Schema.decodeEffect(opts.schema)(yield* response.json)
})

/** Reads bounded GitHub API pages and computes one final report record for a run attempt. */
export const collectPipelineReport = Effect.fn('ci-tools.pipeline-report.collect')(
  function* (opts: {
    readonly repository: string
    readonly runId: number
    readonly attempt: number
    readonly workflowId?: number
    readonly token: string
    readonly grafanaBaseUrl: string
    readonly generatedAtUtc: string
    readonly traceIdForJob: (runId: string, identity: PipelineJobIdentity) => string | undefined
    readonly apiBaseUrl?: string
  }) {
    const apiBaseUrl = (opts.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/u, '')
    const repoPath = opts.repository.split('/').map(encodeURIComponent).join('/')
    const get = <T extends Schema.Schema<unknown>>({
      path,
      schema,
    }: {
      readonly path: string
      readonly schema: T
    }) =>
      githubJson({ path, schema, token: opts.token, apiBaseUrl }).pipe(
        Effect.retry({
          schedule: githubRetrySchedule,
          while: (error) =>
            error instanceof PipelineReportGitHubApiError
              ? (error.status === 429 || error.status >= 500) && (error.retryAfterMs ?? 0) <= 5_000
              : error._tag === 'HttpClientError' && error.reason._tag === 'TransportError',
        }),
      )
    const workflowId =
      opts.workflowId ??
      (yield* get({
        path: `/repos/${repoPath}/actions/runs/${opts.runId}`,
        schema: WorkflowIdentity,
      }).pipe(Effect.orElseSucceed(() => undefined)))?.workflow_id
    const jobs: PipelineJob[] = []
    for (let page = 1; ; page++) {
      const payload = yield* get({
        path: `/repos/${repoPath}/actions/runs/${opts.runId}/jobs?filter=latest&per_page=100&page=${page}`,
        schema: JobsPage,
      })
      jobs.push(...payload.jobs)
      if (jobs.length >= payload.total_count || payload.jobs.length === 0) break
    }
    const wantedKeys = new Set(
      jobs
        .filter((job) => isBuildJob(job.name))
        .flatMap((job) => {
          const identity = pipelineJobIdentityForName(job.name)
          return identity === undefined ? [] : [canonicalJobKey(identity).toString('hex')]
        }),
    )
    const counts: Record<string, number> = {}
    const baselines: { id: number; jobs: PipelineJob[] }[] = []
    const skippedBaselineRunIds: number[] = []
    if (workflowId === undefined) return buildPipelineReport({ ...opts, jobs, baselines })
    let inspectedBaselines = 0
    let examined = 0
    for (let page = 1; ; page++) {
      const payload = yield* get({
        path: `/repos/${repoPath}/actions/runs?branch=main&event=push&status=completed&per_page=100&page=${page}`,
        schema: RunsPage,
      }).pipe(Effect.orElseSucceed(() => undefined))
      if (payload === undefined) break
      const candidates = payload.workflow_runs.filter(
        (run) =>
          run.workflow_id === workflowId &&
          run.head_branch === 'main' &&
          run.event === 'push' &&
          run.status === 'completed' &&
          run.conclusion === 'success',
      )
      for (const run of candidates) {
        if (
          inspectedBaselines === maxBaselineRuns ||
          [...wantedKeys].every((key) => (counts[key] ?? 0) >= 7) === true
        )
          break
        inspectedBaselines++
        const candidateJobs = yield* Effect.gen(function* () {
          const result: PipelineJob[] = []
          for (let jobsPage = 1; ; jobsPage++) {
            const response = yield* get({
              path: `/repos/${repoPath}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${jobsPage}`,
              schema: JobsPage,
            })
            result.push(...response.jobs)
            if (jobsPage * 100 >= response.total_count || response.jobs.length === 0) break
          }
          return result
        }).pipe(Effect.orElseSucceed(() => undefined))
        if (candidateJobs === undefined) {
          skippedBaselineRunIds.push(run.id)
          continue
        }
        baselines.push({ id: run.id, jobs: candidateJobs })
        const candidateDurations = new Map<string, number>()
        const duplicateKeys = new Set<string>()
        for (const job of candidateJobs) {
          const identity = pipelineJobIdentityForName(job.name)
          const duration = wallTimeMs(job)
          if (identity === undefined || job.conclusion !== 'success' || duration === undefined)
            continue
          const key = canonicalJobKey(identity).toString('hex')
          if (candidateDurations.has(key) === true) duplicateKeys.add(key)
          else candidateDurations.set(key, duration)
        }
        for (const key of candidateDurations.keys()) {
          if (
            duplicateKeys.has(key) === true ||
            wantedKeys.has(key) === false ||
            (counts[key] ?? 0) >= 7
          )
            continue
          counts[key] = (counts[key] ?? 0) + 1
        }
      }
      examined += payload.workflow_runs.length
      if (
        inspectedBaselines === maxBaselineRuns ||
        [...wantedKeys].every((key) => (counts[key] ?? 0) >= 7) === true ||
        examined >= payload.total_count ||
        payload.workflow_runs.length === 0
      )
        break
    }
    return buildPipelineReport({ ...opts, jobs, baselines, skippedBaselineRunIds })
  },
)
