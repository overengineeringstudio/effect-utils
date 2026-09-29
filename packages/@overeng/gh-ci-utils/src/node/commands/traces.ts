import { Effect, Option, Schema } from 'effect'
import * as Cli from 'effect/cli'

import { deriveJobTraceId, pipelineJobIdentityForName } from '@overeng/ci-tools'

import type { WorkflowJob, WorkflowRun } from '../../isomorphic/GitHubSchemas.ts'
import { isStaleRunSelection, isWrongWorkflowSelection } from '../../isomorphic/lib/summary.ts'
import { resolveConfig } from '../Config.ts'
import { GitHubClient } from '../GitHubClient.ts'
import { resolveTarget } from '../RunId.ts'

/** Failure of the `traces` command: invalid input or unavailable GitHub/Grafana configuration. */
export class TraceCommandError extends Schema.TaggedError<TraceCommandError>()(
  'TraceCommandError',
  { message: Schema.String },
) {}

const pr = Cli.Argument.Int('pr').pipe(Cli.Argument.withDescription('Pull request number'))
const repoFlag = Cli.Flag.String('repo').pipe(Cli.Flag.optional)

const encodeComponent = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )

/** Grafana Explore uses a fixed Tempo datasource and an explicit window around each job. */
export const jobTraceUrl = ({
  grafanaBaseUrl,
  traceId,
  startedAt,
  completedAt,
}: {
  grafanaBaseUrl: string
  traceId: string
  startedAt: Date
  completedAt: Date
}): string | undefined => {
  if (!/^[0-9a-f]{32}$/.test(traceId)) return undefined
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
      range: {
        from: String(startedAt.getTime() - 15 * 60_000),
        to: String(completedAt.getTime() + 60 * 60_000),
      },
    },
  }
  return `${grafanaBaseUrl}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`
}

/** Jobs API rows for exactly one attempt, with no guessed identities for unknown or duplicate names. */
export const renderJobTraces = ({
  repo,
  prNumber,
  run,
  jobs,
  grafanaBaseUrl,
  reportedAt,
}: {
  repo: string
  prNumber: number
  run: Pick<WorkflowRun, 'id' | 'run_attempt'>
  jobs: readonly WorkflowJob[]
  grafanaBaseUrl: string
  reportedAt: Date
}): string => {
  const attemptJobs = jobs.filter(
    (job) => job.run_attempt === run.run_attempt && job.name !== 'pipeline-attempt-close',
  )
  const nameCounts = new Map<string, number>()
  for (const job of attemptJobs) nameCounts.set(job.name, (nameCounts.get(job.name) ?? 0) + 1)
  const runIdentity = `ci/github/${encodeComponent(repo)}/${run.id}/${run.run_attempt}`
  const lines = [`${repo}#${prNumber}  Run ${run.id} (attempt ${run.run_attempt})`]
  // oxlint-disable-next-line unicorn/no-array-sort -- filter returned a fresh array; toSorted copies it again.
  for (const job of attemptJobs.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : left.id - right.id,
  )) {
    const status = `${job.status}${job.conclusion === null ? '' : ` (${job.conclusion})`}`
    const identity =
      nameCounts.get(job.name) === 1 ? pipelineJobIdentityForName(job.name) : undefined
    if (!identity || !job.started_at || job.conclusion === 'skipped') {
      lines.push(
        `  ${job.name}: ${status} — trace unavailable (${!identity ? 'unmatched job name' : 'not started'})`,
      )
      continue
    }
    const traceId = deriveJobTraceId({
      runId: runIdentity,
      job: identity.job,
      dimensions: identity.dimensions,
    })
    const url = jobTraceUrl({
      grafanaBaseUrl,
      traceId,
      startedAt: job.started_at,
      completedAt: job.completed_at ?? reportedAt,
    })
    if (!url) {
      lines.push(`  ${job.name}: ${status} — trace unavailable (invalid identity)`)
      continue
    }
    lines.push(`  ${job.name}: ${status}`)
    lines.push(`    ${traceId} ${url}`)
  }
  if (attemptJobs.length === 0) lines.push('  No jobs for this attempt')
  lines.push(
    'Trace links are locators; export, indexing, access, and retention are not guaranteed.',
  )
  return lines.join('\n')
}

/** `gh-ci-utils traces <pr>`: show deterministic links from GitHub run/job facts. */
export const tracesCommand = Cli.Command.make('traces', { pr, repo: repoFlag }).pipe(
  Cli.Command.withHandler(({ pr: number, repo: repoOpt }) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(number) || number <= 0) {
        return yield* new TraceCommandError({ message: 'PR number must be positive' })
      }
      const config = yield* resolveConfig({})
      const selectedRepo = Option.isSome(repoOpt) ? repoOpt.value : config.repos[0]
      if (!selectedRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(selectedRepo)) {
        return yield* new TraceCommandError({
          message: 'Could not determine owner/repo; pass --repo owner/name',
        })
      }
      const base = process.env.GRAFANA_BASE_URL ?? config.grafanaBaseUrl
      if (!base || !/^https?:\/\/[^/?#]+(?:\/[^?#]*)?$/.test(base) || base.endsWith('/')) {
        return yield* new TraceCommandError({
          message:
            'Set GRAFANA_BASE_URL or config.grafanaBaseUrl to an HTTP(S) Grafana URL without a trailing slash',
        })
      }
      const resolved = yield* resolveTarget(`#${number}`, Option.some(selectedRepo), 'ci.yml')
      if (isWrongWorkflowSelection(resolved.selection) || isStaleRunSelection(resolved.selection)) {
        return yield* new TraceCommandError({
          message: `No ci.yml run for the current head of ${selectedRepo}#${number}`,
        })
      }
      const github = yield* GitHubClient
      const run = yield* github.getWorkflowRun({ repo: selectedRepo, runId: resolved.runId })
      const response = yield* github.listWorkflowJobs({ repo: selectedRepo, runId: run.id })
      console.log(
        renderJobTraces({
          repo: selectedRepo,
          prNumber: number,
          run,
          jobs: response.jobs,
          grafanaBaseUrl: base,
          reportedAt: new Date(),
        }),
      )
    }),
  ),
  Cli.Command.withDescription(
    'Show GitHub PR job trace IDs and Grafana Explore links (no Tempo access)',
  ),
)
