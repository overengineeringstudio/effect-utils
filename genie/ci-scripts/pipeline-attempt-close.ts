import { deriveJobRootSpanId, deriveJobTraceId, derivePipelineRootSpanId, derivePipelineTraceId } from '../../packages/@overeng/ci-tools/src/pipeline-trace-identity.ts'
import { pipelineJobIdentityForName } from '../../packages/@overeng/ci-tools/src/pipeline-job-names.ts'

type Job = { name: string; run_attempt: number; started_at: string | null; completed_at: string | null }
type WorkflowRun = { created_at: string; updated_at: string; run_started_at?: string }
type OtlpStringAttribute = { key: string; value: { stringValue: string } }
type OtlpLink = { traceId: string; spanId: string; attributes?: OtlpStringAttribute[] }

const str = (key: string, value: string): OtlpStringAttribute => ({ key, value: { stringValue: value } })
const nano = (epochMs: number): string => String(BigInt(epochMs) * 1_000_000n)

/** Jobs API started facts are locators, not acknowledgements from Tempo. */
export const closePayload = (runId: string, attempt: number, jobs: readonly Job[], run: WorkflowRun, closedAt = run.updated_at) => {
  const counts: Record<string, number> = {}
  let earliestStart = Number.POSITIVE_INFINITY
  for (const job of jobs) {
    if (job.run_attempt !== attempt) continue
    if (job.started_at) earliestStart = Math.min(earliestStart, Date.parse(job.started_at))
    if (job.name !== 'pipeline-attempt-close')
      counts[job.name] = (counts[job.name] ?? 0) + 1
  }
  const links: OtlpLink[] = jobs.flatMap((row) => {
    if (row.run_attempt !== attempt || !row.started_at || row.name === 'pipeline-attempt-close' || counts[row.name] !== 1) return []
    const identity = pipelineJobIdentityForName(row.name)
    if (!identity) return []
    return [{
      traceId: deriveJobTraceId(runId, identity.job, identity.dimensions),
      spanId: deriveJobRootSpanId(runId, identity.job, identity.dimensions),
      attributes: [str('buck2.job_trace.link_state', 'unverified')],
    }]
  })
  const jobLinks = links.length
  if (attempt > 1) {
    const previousRunId = runId.replace(/\/[1-9]\d*$/, `/${attempt - 1}`)
    links.push({
      traceId: derivePipelineTraceId(previousRunId),
      spanId: derivePipelineRootSpanId(previousRunId),
    })
  }
  const traceId = derivePipelineTraceId(runId)
  return {
    traceId,
    jobLinks,
    payload: { resourceSpans: [{ resource: { attributes: [str('service.name', 'effect-utils-ci')] }, scopeSpans: [{
      scope: { name: 'pipeline-attempt-close' },
      spans: [{ traceId, spanId: derivePipelineRootSpanId(runId), name: 'cicd.pipeline.run', kind: 1,
        startTimeUnixNano: nano(Number.isFinite(earliestStart) ? earliestStart : Date.parse(run.run_started_at ?? run.created_at)),
        endTimeUnixNano: nano(Math.max(Date.parse(run.updated_at), Date.parse(closedAt))),
        attributes: [str('cicd.pipeline.run.id', runId)], links,
      }],
    }] }] },
  }
}

const api = async <A>(route: string, token: string): Promise<A> => {
  const response = await fetch(`https://api.github.com/repos/${route}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  })
  if (!response.ok) throw new Error(`Jobs API ${response.status}: ${route}`)
  return await response.json() as A
}

export const finalizeAttempt = async (input: {
  repository: string; runId: string; attempt: number; token: string; spool: string
}) => {
  const { repository, runId, attempt, token, spool } = input
  const run = await api<WorkflowRun>(`${repository}/actions/runs/${runId}`, token)
  const jobs: Job[] = []
  for (let page = 1; ; page++) {
    const response = await api<{ jobs: Job[] }>(
      `${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`, token,
    )
    jobs.push(...response.jobs)
    if (response.jobs.length < 100) break
  }
  const id = `ci/github/${encodeURIComponent(repository)}/${runId}/${attempt}`
  const { traceId, jobLinks, payload } = closePayload(id, attempt, jobs, run, new Date().toISOString())
  await Bun.write(`${spool}/spans/pipeline-close.jsonl`, `${JSON.stringify(payload)}\n`)
  console.log(`pipeline close run=${id} trace=${traceId} unverified_job_links=${jobLinks}`)
}

if (import.meta.main) {
  try {
    await finalizeAttempt({
      repository: process.env.GITHUB_REPOSITORY!,
      runId: process.env.GITHUB_RUN_ID!,
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      token: process.env.GITHUB_TOKEN!,
      spool: process.env.PIPELINE_SPOOL_DIR!,
    })
  } catch (error) {
    console.warn('Pipeline attempt close deferred:', error)
    process.exitCode = 1
  }
}
