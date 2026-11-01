#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import { coreProofDisabledJobIds } from '../ci-workflow/buck2-cache-proof-policy.ts'
import {
  apiBudgetAvailable,
  artifactCanMatter,
  classifyRun,
  discoverProofJobIdentity,
  selectRuns,
  type EvidenceRun,
} from './buck2-cache-join-discovery.ts'
import {
  DownloadLimitError,
  makeDownloadBudget,
  readBoundedBytes,
} from './buck2-cache-join-download.ts'
import { aggregate, previousUtcDay, renderPrometheus, renderOtlp } from './buck2-cache-join.ts'
import {
  planProofHistory,
  selectProofRelevantRuns,
  type ExpectedHistoryJob,
  type HistorySource,
} from './buck2-cache-proof-history.ts'
import { writeBuck2CacheProofReports } from './buck2-cache-proof-reports.ts'
import { decodeEvidence, renderWarm99Diagnostics } from './buck2-cache-warm99.ts'

const limits = {
  runs: 1000,
  artifacts: 2000,
  artifactBytes: 80 * 1024 * 1024,
  totalBytes: 2 * 1024 ** 3,
  concurrency: 2,
}
class JoinError extends Schema.TaggedError<JoinError>()('JoinError', { message: Schema.String }) {}
class BudgetError extends Schema.TaggedError<BudgetError>()('BudgetError', {
  message: Schema.String,
}) {}
class RetryError extends Schema.TaggedError<RetryError>()('RetryError', {
  message: Schema.String,
}) {}
const failure = (message: string) => new JoinError({ message })
const io = <A>(message: string, body: () => Promise<A>) =>
  Effect.tryPromise({
    try: body,
    catch: (cause) => (cause instanceof JoinError ? cause : failure(message)),
  })
const Artifact = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  size_in_bytes: Schema.Number,
  expired: Schema.Boolean,
  created_at: Schema.String,
  workflow_run: Schema.Struct({ id: Schema.Number }),
})
const Artifacts = Schema.Struct({ total_count: Schema.Number, artifacts: Schema.Array(Artifact) })
const Jobs = Schema.Struct({
  total_count: Schema.Number,
  jobs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      run_attempt: Schema.Number,
      conclusion: Schema.NullOr(Schema.String),
      steps: Schema.Array(Schema.Struct({ name: Schema.String })),
    }),
  ),
})
const Runs = Schema.Struct({
  workflow_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      event: Schema.String,
      head_branch: Schema.NullOr(Schema.String),
      created_at: Schema.String,
    }),
  ),
})
const evidenceWorkflows = [
  'ci.yml',
  'empirical-proofs.yml',
  'storybook-plays.yml',
  'storybook-preview-build.yml',
]
const Json = Schema.fromJsonString(Schema.Unknown)
const ReportJson = Schema.fromJsonString(Schema.Unknown)

const timestamp = (value: string, now: number) => {
  const duration = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(value)
  if (duration !== null)
    return (
      now -
      Number(duration[1]) * { m: 60000, h: 3600000, d: 86400000 }[duration[2] as 'm' | 'h' | 'd']
    )
  return /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN
}

const help = `buck2-cache-join --repo owner/name (--since <ISO-8601|24h> [--until <ISO-8601|duration>] | --previous-utc-day) [--format prometheus|json] [--otlp-spool <pending-directory>]

Join strict Buck2 action evidence from selected workflow runs created in the bounded window.
GITHUB_TOKEN is required (Actions read permission). No GitHub writes are performed.
Prometheus output (default) uses gauges of window totals, not cumulative counters.
--previous-utc-day selects the previous complete UTC day [00:00Z,24:00Z).
--otlp-spool writes an OTLP metrics chunk, timestamped at window end, for pipeline-export.
Trusted presence: only complete main-writer uploads or verified remote-hit observations before each reader invocation qualify.
--proof-directory retains full downloaded proof sources, authoritative run/job expectations,
and warm99/proof reports; missing discovery or evidence remains an explicit proof gap.
Limits: 31-day window, 1000 observed runs, 2000 artifacts, 80 MiB/ZIP, 2 GiB total.
API safety: about 700 calls daily target, 800 maximum, stop at 200 remaining, two downloads with 250 ms pacing.
Per UTC day: all main-writer runs; at most 50 evenly ID-spaced merge_group and 25 time-spaced main-reader/pr runs.
Sampled readers make metrics a lower bound; coverage gauges show selected/seen runs.
Transient HTTP 5xx and transport failures retry at most three attempts, all charged to the cap.
Budget exhaustion emits an explicit join evidence gap; resource caps fail clearly.
Invalid or unavailable evidence contributes evidence_gaps without discarding valid evidence.
Diagnostics (runtime, API calls, artifacts and bytes) go to stderr; metrics go to stdout.
`

const readZip = Effect.fn('buck2-cache-join.read-zip')(function* (
  bytes: Uint8Array,
  directory: string,
) {
  const archive = join(directory, 'evidence.zip')
  yield* io('Cannot write evidence ZIP', () => writeFile(archive, bytes))
  const spawner = yield* ChildProcessSpawner
  const unzip = Effect.fn('buck2-cache-join.unzip')(function* (args: string[], maxBytes: number) {
    const handle = yield* spawner.spawn(
      ChildProcess.make(process.env.UNZIP_BIN ?? 'unzip', args, { stdout: 'pipe', stderr: 'pipe' }),
    )
    const [stdout, , exitCode] = yield* Effect.all(
      [
        readBoundedBytes(handle.stdout, maxBytes).pipe(
          Effect.mapError((cause) =>
            cause instanceof DownloadLimitError ? failure(cause.message) : cause,
          ),
        ),
        readBoundedBytes(handle.stderr, 64 * 1024).pipe(
          Effect.mapError((cause) =>
            cause instanceof DownloadLimitError ? failure(cause.message) : cause,
          ),
        ),
        handle.exitCode,
      ],
      { concurrency: 3 },
    )
    if (exitCode !== 0) return yield* failure('Invalid evidence ZIP or unavailable platform unzip')
    return stdout
  })
  // Proof bundles also retain bounded per-invocation shards. Only the two exact
  // allowlisted legacy members below are read; no archive paths are extracted.
  const listing = yield* unzip(['-Z', '-1', archive], 1024 * 1024)
  const names = new TextDecoder('utf-8', { fatal: true }).decode(listing).trimEnd().split('\n')
  if (names.length > 4104) return yield* failure('ZIP entry limit exceeded')
  const members = new Map<string, Buffer>()
  for (const name of ['buck2-cache-evidence.json', 'buck2-cache-actions.jsonl.gz']) {
    if (names.filter((entry) => entry === name).length !== 1)
      return yield* failure('Missing or duplicate evidence ZIP members')
    // Read exact allowlisted members to stdout, never extract archive-controlled paths.
    members.set(name, yield* unzip(['-p', archive, name], limits.artifactBytes))
  }
  return {
    summary: new TextDecoder('utf-8', { fatal: true }).decode(
      members.get('buck2-cache-evidence.json')!,
    ),
    actions: members.get('buck2-cache-actions.jsonl.gz')!,
  }
})

const program = Effect.gen(function* () {
  const options = yield* Effect.try({
    try: () =>
      parseArgs({
        options: {
          repo: { type: 'string' },
          since: { type: 'string' },
          until: { type: 'string' },
          format: { type: 'string' },
          'previous-utc-day': { type: 'boolean' },
          'otlp-spool': { type: 'string' },
          'proof-directory': { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        },
      }).values,
    catch: () => failure('Invalid arguments; use --help'),
  })
  if (options.help === true) {
    process.stdout.write(help)
    return
  }
  const repo = options.repo
  if (repo === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    return yield* failure('--repo must be owner/name')
  const now = Date.now()
  if (
    options['previous-utc-day'] === true &&
    (options.since !== undefined || options.until !== undefined)
  )
    return yield* failure('--previous-utc-day cannot be combined with --since or --until')
  const day = previousUtcDay(now)
  const until =
    options['previous-utc-day'] === true
      ? day.until
      : options.until === undefined
        ? now
        : timestamp(options.until, now)
  const since =
    options['previous-utc-day'] === true ? day.since : timestamp(options.since ?? '', until)
  if (
    !Number.isFinite(since) ||
    !Number.isFinite(until) ||
    since >= until ||
    until > now ||
    until - since > 31 * 86400000
  )
    return yield* failure(
      'Specify a past, increasing window of at most 31 days with --since and --until',
    )
  const format = options.format ?? 'prometheus'
  if (format !== 'prometheus' && format !== 'json')
    return yield* failure('--format must be prometheus or json')
  const token = process.env.GITHUB_TOKEN
  if (token === undefined || token.trim() === '')
    return yield* failure('GITHUB_TOKEN is required (GitHub Actions read permission)')
  const started = Date.now()
  let apiCalls = 0
  const downloadBudget = makeDownloadBudget(limits.totalBytes)
  let remaining: number | undefined
  let budgetStopped = false
  let unlabelledEvidenceGaps = 0
  const client = yield* HttpClient.HttpClient
  const requestOnce = Effect.fn('buck2-cache-join.github-request-attempt')(function* (
    path: string,
    maxBytes: number,
  ) {
    if (
      !apiBudgetAvailable({
        calls: apiCalls,
        remaining: remaining === undefined ? undefined : remaining - limits.concurrency,
      })
    ) {
      budgetStopped = true
      return yield* new BudgetError({
        message: 'API budget exhausted: cap 800 or remaining floor 200',
      })
    }
    // Reserve before yielding so concurrent requests cannot overrun the hard cap.
    apiCalls++
    yield* Effect.sleep('250 millis')
    const response = yield* client
      .execute(
        HttpClientRequest.get(`https://api.github.com/repos/${repo}${path}`).pipe(
          HttpClientRequest.setHeaders({
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'buck2-cache-join',
          }),
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.mapError(() => new RetryError({ message: 'GitHub transport failed' })),
      )
    const rateRemaining = response.headers['x-ratelimit-remaining']
    if (rateRemaining !== undefined && /^\d+$/.test(rateRemaining))
      remaining = Math.min(remaining ?? Infinity, Number(rateRemaining))
    if (
      response.status === 429 ||
      (response.status === 403 && remaining !== undefined && remaining <= 200)
    ) {
      budgetStopped = true
      return yield* new BudgetError({ message: 'GitHub API rate limit refused collection' })
    }
    if (response.status >= 500)
      return yield* new RetryError({
        message: `GitHub API ${path} returned HTTP ${response.status}`,
      })
    let payload = response
    if (response.status === 302) {
      const location = URL.parse(response.headers.location ?? '')
      if (
        location === null ||
        location.protocol !== 'https:' ||
        location.username !== '' ||
        location.password !== '' ||
        !(
          location.hostname.endsWith('.blob.core.windows.net') ||
          location.hostname.endsWith('.actions.githubusercontent.com') ||
          location.hostname.endsWith('.githubusercontent.com')
        )
      )
        return yield* failure('GitHub artifact storage redirect rejected')
      // Signed storage URLs are not API calls; never forward GitHub credentials or trace headers.
      payload = yield* client.execute(HttpClientRequest.get(location.href)).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.mapError(() => new RetryError({ message: 'Artifact transport failed' })),
      )
    }
    if (payload.status >= 500)
      return yield* new RetryError({ message: `Artifact storage returned HTTP ${payload.status}` })
    if (payload.status < 200 || payload.status >= 300)
      return yield* failure(`GitHub artifact/API ${path} returned HTTP ${payload.status}`)
    return yield* readBoundedBytes(
      payload.stream,
      maxBytes,
      path.startsWith('/actions/artifacts/') ? downloadBudget : undefined,
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof DownloadLimitError
          ? failure(cause.message)
          : cause instanceof JoinError
            ? cause
            : new RetryError({ message: 'Response transport failed' }),
      ),
    )
  })
  const request = Effect.fn('buck2-cache-join.github-request')(function* (
    path: string,
    maxBytes: number,
  ) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = yield* requestOnce(path, maxBytes).pipe(Effect.result)
      if (result._tag === 'Success') return result.success
      if (!(result.failure instanceof RetryError)) return yield* result.failure
      if (attempt === 3) return yield* failure(`${result.failure.message}; exhausted 3 attempts`)
      yield* Effect.sleep(`${attempt} seconds`)
    }
    return yield* failure('Request attempts exhausted')
  })
  const jsonRequest = Effect.fn('buck2-cache-join.github-json')(function* (path: string) {
    const bytes = yield* request(path, 8 * 1024 * 1024)
    return yield* Schema.decodeUnknownEffect(Json)(bytes.toString('utf8'))
  })
  const discovered: EvidenceRun[] = []
  for (const workflow of evidenceWorkflows) {
    for (let page = 1; ; page++) {
      const created = encodeURIComponent(
        `${new Date(since).toISOString()}..${new Date(until - 1).toISOString()}`,
      )
      const result = yield* jsonRequest(
        `/actions/workflows/${workflow}/runs?created=${created}&per_page=100&page=${page}`,
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Runs)), Effect.result)
      if (result._tag === 'Failure') {
        if (!(result.failure instanceof BudgetError)) return yield* result.failure
        unlabelledEvidenceGaps++
        break
      }
      for (const run of result.success.workflow_runs) {
        const time = Date.parse(run.created_at)
        if (time >= since && time < until) discovered.push({ ...run, workflow })
        if (discovered.length > limits.runs) return yield* failure('Run cap hit; narrow the window')
      }
      if (result.success.workflow_runs.length < 100) break
    }
    if (budgetStopped) break
  }
  const selection = selectRuns(discovered)
  const proofDirectory =
    options['proof-directory'] === undefined ? undefined : resolve(options['proof-directory'])
  const proofCollectionGaps: string[] = []
  const proofRelevantRuns = selectProofRelevantRuns(discovered)
  const expectedJobs: ExpectedHistoryJob[] = []
  if (proofDirectory !== undefined) {
    yield* io('Cannot create proof directory', () => mkdir(proofDirectory, { recursive: true }))
    for (const run of proofRelevantRuns) {
      for (let page = 1; page <= 10; page++) {
        const result = yield* jsonRequest(
          `/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`,
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Jobs)), Effect.result)
        if (result._tag === 'Failure') {
          proofCollectionGaps.push('job-discovery-unavailable')
          break
        }
        for (const job of result.success.jobs) {
          if (job.conclusion === null) proofCollectionGaps.push('workflow-job-not-complete')
          const identity = discoverProofJobIdentity(job.name)
          if (
            job.conclusion === 'skipped' ||
            job.steps.some((step) => step.name === 'Start Buck2 cache evidence window') !== true ||
            (identity !== undefined && coreProofDisabledJobIds[identity.job] === true)
          )
            continue
          if (identity === undefined || expectedJobs.length >= 128) {
            proofCollectionGaps.push('job-discovery-bound-or-identity-gap')
            continue
          }
          const { job: id, cell } = identity
          if (
            expectedJobs.some((expected) => expected.runId === run.id && expected.cell === cell) ===
            true
          )
            proofCollectionGaps.push('job-discovery-ambiguous-cell')
          expectedJobs.push({ runId: run.id, job: id, runAttempt: job.run_attempt, cell })
        }
        if (result.success.jobs.length < 100) break
        if (page === 10) proofCollectionGaps.push('job-discovery-page-cap')
      }
    }
  }
  const historySources: HistorySource[] = []
  let retainedProofBytes = 0
  const runs = new Set(selection.selected.map((run) => run.id))
  const selected: (typeof Artifact.Type)[] = []
  let artifactCount = 0
  let metricArtifactCount = 0
  let skippedExpired = 0
  let skippedByPolicy = 0
  const collectionRuns = new Map(selection.selected.map((run) => [run.id, run]))
  if (proofDirectory !== undefined)
    for (const run of proofRelevantRuns) collectionRuns.set(run.id, run)
  for (const run of collectionRuns.values()) {
    for (let page = 1; ; page++) {
      const result = yield* jsonRequest(
        `/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`,
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Artifacts)), Effect.result)
      if (result._tag === 'Failure') {
        if (!(result.failure instanceof BudgetError)) return yield* result.failure
        if (runs.has(run.id) === true) unlabelledEvidenceGaps++
        break
      }
      for (const artifact of result.success.artifacts) {
        if (!artifact.name.startsWith('buck2-cache-evidence-')) continue
        artifactCount++
        if (runs.has(run.id) === true) metricArtifactCount++
        if (artifactCount > limits.artifacts)
          return yield* failure('Artifact cap hit; narrow the window')
        if (artifact.expired) {
          if (runs.has(run.id) === true) {
            skippedExpired++
            unlabelledEvidenceGaps++
          }
          continue
        }
        if (!artifactCanMatter(artifact.name)) {
          if (runs.has(run.id) === true) skippedByPolicy++
          continue
        }
        if (artifact.size_in_bytes > limits.artifactBytes)
          return yield* failure('Artifact byte cap hit')
        selected.push(artifact)
      }
      if (result.success.artifacts.length < 100) break
    }
    if (budgetStopped) break
  }
  const declaredBytes = selected.reduce((sum, artifact) => sum + artifact.size_in_bytes, 0)
  if (declaredBytes > limits.totalBytes)
    return yield* failure(`Total artifact byte cap hit (${limits.totalBytes})`)
  const root = yield* Effect.acquireRelease(
    io('Cannot create temporary evidence directory', () =>
      mkdtemp(join(tmpdir(), 'buck2-cache-join-')),
    ),
    (path) =>
      io('Cannot remove temporary evidence directory', () =>
        rm(path, { recursive: true, force: true }),
      ).pipe(Effect.orDie),
  )
  const observations = yield* Effect.forEach(
    selected,
    (artifact) =>
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const bytes = yield* request(
            `/actions/artifacts/${artifact.id}/zip`,
            limits.artifactBytes,
          )
          const directory = yield* io('Cannot create artifact directory', () =>
            mkdtemp(join(root, 'artifact-')),
          )
          return yield* Effect.gen(function* () {
            const files = yield* readZip(bytes, directory)
            const summary = yield* Schema.decodeUnknownEffect(Json)(files.summary)
            const evidence = yield* Effect.try({
              try: () => decodeEvidence({ compressed: files.actions, summary }),
              catch: () => failure('Invalid strict evidence'),
            })
            const lane = evidence.header.metadata.lane
            if (lane === null) return undefined
            if (
              proofDirectory !== undefined &&
              evidence.header.metadata.repo === repo &&
              evidence.header.metadata.runId === String(artifact.workflow_run.id)
            ) {
              if (
                expectedJobs.some(
                  (job) =>
                    job.runId === artifact.workflow_run.id &&
                    job.job === evidence.header.metadata.job &&
                    String(job.runAttempt) === evidence.header.metadata.runAttempt &&
                    job.cell === evidence.header.metadata.cell,
                ) === true
              ) {
                const size = Buffer.byteLength(files.summary) + files.actions.length
                if (historySources.length >= 128 || retainedProofBytes + size > 128 * 1024 * 1024)
                  proofCollectionGaps.push('proof-retention-bound-exceeded')
                else if (
                  evidence.header.metadata.job !== null &&
                  evidence.header.metadata.cell !== null &&
                  evidence.header.metadata.cell !== undefined
                ) {
                  retainedProofBytes += size
                  const destination = join(proofDirectory, 'sources', String(artifact.id))
                  yield* io('Cannot retain authoritative proof source', async () => {
                    await mkdir(destination, { recursive: true })
                    await writeFile(join(destination, 'buck2-cache-evidence.json'), files.summary)
                    await writeFile(
                      join(destination, 'buck2-cache-actions.jsonl.gz'),
                      files.actions,
                    )
                  })
                  const nativeStarts = evidence.header.invocations.flatMap((invocation) =>
                    invocation.startedAt === null ? [] : [invocation.startedAt],
                  )
                  historySources.push({
                    id: artifact.id,
                    runId: artifact.workflow_run.id,
                    runAttempt: Number(evidence.header.metadata.runAttempt),
                    lane,
                    job: evidence.header.metadata.job,
                    cell: evidence.header.metadata.cell,
                    trustedWriter:
                      evidence.header.metadata.posture === 'writer' && lane === 'main-writer',
                    startedAt:
                      nativeStarts.length > 0
                        ? Math.min(...nativeStarts)
                        : evidence.header.metadata.startedAt,
                    latestStartedAt:
                      nativeStarts.length > 0
                        ? Math.max(...nativeStarts)
                        : evidence.header.metadata.startedAt,
                    finishedAt: evidence.header.metadata.finishedAt,
                  })
                }
              }
            }
            return {
              artifact: evidence,
              lane,
              ...(evidence.header.metadata.job === null
                ? {}
                : { job: evidence.header.metadata.job }),
              runId: String(artifact.workflow_run.id),
            }
          }).pipe(
            Effect.ensuring(
              io('Cannot remove artifact directory', () =>
                rm(directory, { recursive: true, force: true }),
              ).pipe(Effect.orDie),
            ),
          )
        }).pipe(Effect.result)
        if (result._tag === 'Success') return result.success
        if (result.failure instanceof BudgetError) {
          if (runs.has(artifact.workflow_run.id) === true) unlabelledEvidenceGaps++
          return undefined
        }
        // Resource caps must never become a partial, apparently successful day.
        if (
          result.failure instanceof JoinError &&
          /cap hit|cap exceeded|limit exceeded/.test(result.failure.message)
        )
          return yield* result.failure
        if (runs.has(artifact.workflow_run.id) === true) unlabelledEvidenceGaps++
        return undefined
      }),
    { concurrency: limits.concurrency },
  )
  const report = aggregate({
    repo,
    runs: runs.size,
    artifacts: metricArtifactCount,
    observations: observations
      .filter((value) => value !== undefined)
      .filter((value) => runs.has(Number(value.runId))),
    windowEndTimestampSeconds: until / 1000,
    unlabelledEvidenceGaps,
    samples: selection.lanes.map((sample) => ({
      ...sample,
      artifacts: selected.filter((artifact) =>
        selection.selected.some(
          (run) => run.id === artifact.workflow_run.id && classifyRun(run) === sample.lane,
        ),
      ).length,
    })),
  })
  const relevantArtifacts = observations.filter(
    (value) => value !== undefined && runs.has(Number(value.runId)),
  ).length
  const outputReport = {
    ...report,
    collection: {
      api_calls: apiCalls,
      remaining,
      budget_stopped: budgetStopped,
      selected_artifacts: selected.length,
      relevant_artifacts: relevantArtifacts,
      skipped_expired: skippedExpired,
      skipped_by_policy: skippedByPolicy,
      api_call_cap: 800,
      api_reserve_floor: 200,
    },
  }
  if (budgetStopped)
    process.stderr.write(
      'buck2-cache-join: API budget stopped collection; unexamined artifacts are evidence gaps (cap=800 floor=200)\n',
    )
  if (proofDirectory !== undefined) {
    const planned = planProofHistory({
      runs: discovered,
      sources: historySources,
      expectedJobs,
    })
    const manifestPath = join(proofDirectory, 'buck2-cache-warm99-observations.json')
    yield* io('Cannot publish authoritative historical proof', async () => {
      await writeFile(
        manifestPath,
        `${JSON.stringify({ ...planned.manifest, nixSubstitutionEvidence: 'unavailable' }, null, 2)}\n`,
      )
      const first = historySources[0]
      const summaryPath = join(proofDirectory, 'buck2-cache-evidence.json')
      const actionsPath = join(proofDirectory, 'buck2-cache-actions.jsonl.gz')
      if (first !== undefined) {
        await Bun.write(
          summaryPath,
          Bun.file(join(proofDirectory, 'sources', String(first.id), 'buck2-cache-evidence.json')),
        )
        await Bun.write(
          actionsPath,
          Bun.file(
            join(proofDirectory, 'sources', String(first.id), 'buck2-cache-actions.jsonl.gz'),
          ),
        )
      }
      await writeBuck2CacheProofReports({
        summaryPath,
        actionsPath,
        manifestPath,
        expectedJobs,
        nixSubstitutionObserved: false,
        collectionEvidenceGaps: [
          ...proofCollectionGaps,
          ...planned.evidenceGaps,
          ...(budgetStopped === true ? ['artifact-collection-incomplete'] : []),
        ],
      })
      const acceptance: unknown = await Bun.file(
        join(proofDirectory, 'buck2-cache-warm99.json'),
      ).json()
      if (
        typeof acceptance !== 'object' ||
        acceptance === null ||
        !('accepted' in acceptance) ||
        acceptance.accepted !== true
      ) {
        process.stderr.write(`${renderWarm99Diagnostics(acceptance)}\n`)
        process.exitCode = 1
      }
    })
  }
  if (options['otlp-spool'] !== undefined) {
    const directory = options['otlp-spool']
    const body = yield* Schema.encodeEffect(ReportJson)(renderOtlp(report))
    const bytes = Buffer.from(body)
    const id = createHash('sha256').update(bytes).digest('hex')
    const header = yield* Schema.encodeEffect(ReportJson)({
      id,
      signal: 'metrics',
      destination: 'OTEL_EXPORTER_OTLP_ENDPOINT',
      byte_count: bytes.length,
    })
    yield* io('Cannot write pending OTLP metrics chunk', async () => {
      await mkdir(directory, { recursive: true })
      const temporary = join(directory, `${id}.metrics.chunk.${process.pid}.tmp`)
      await writeFile(temporary, `${header}\n${body}`, { mode: 0o600 })
      await rename(temporary, join(directory, `${id}.metrics.chunk`))
    })
  }
  const output =
    format === 'prometheus'
      ? renderPrometheus(report)
      : yield* Schema.encodeEffect(ReportJson)(outputReport)
  process.stdout.write(`${output}${output.endsWith('\n') ? '' : '\n'}`)
  process.stderr.write(
    `buck2-cache-join: runtime_ms=${Date.now() - started} api_calls=${apiCalls} runs=${runs.size} artifacts=${artifactCount} selected_artifacts=${selected.length} relevant_artifacts=${relevantArtifacts} skipped_expired=${skippedExpired} skipped_by_policy=${skippedByPolicy} budget_stopped=${budgetStopped} remaining=${remaining ?? 'unknown'} downloaded_bytes=${downloadBudget.bytes}\n`,
  )
}).pipe(
  Effect.scoped,
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(NodeServices.layer),
  Effect.timeout('15 minutes'),
  // HttpClient errors carry request headers; never print the token in diagnostics.
  Effect.mapError((cause) =>
    cause instanceof JoinError
      ? cause
      : failure('GitHub request, response decoding, or collection deadline failed'),
  ),
)

program.pipe(NodeRuntime.runMain())
