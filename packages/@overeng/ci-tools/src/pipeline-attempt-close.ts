import { pipelineJobIdentityForName } from './pipeline-job-names.ts'
import {
  deriveJobRootSpanId,
  deriveJobTraceId,
  derivePipelineRootSpanId,
  derivePipelineTraceId,
} from './pipeline-trace-identity.ts'

export type Job = {
  name: string
  run_attempt: number
  started_at: string | null
  completed_at: string | null
}
export type WorkflowRun = { created_at: string; updated_at: string; run_started_at?: string }
type OtlpStringAttribute = { key: string; value: { stringValue: string } }
type OtlpLink = { traceId: string; spanId: string; attributes?: OtlpStringAttribute[] }

const str = (key: string, value: string): OtlpStringAttribute => ({
  key,
  value: { stringValue: value },
})
const nano = (epochMs: number): string => String(BigInt(epochMs) * 1_000_000n)

/** Jobs API started facts are locators, not acknowledgements from Tempo. */
export const closePayload = (
  runId: string,
  attempt: number,
  jobs: readonly Job[],
  run: WorkflowRun,
  closedAt = run.updated_at,
) => {
  const counts: Record<string, number> = {}
  let earliestStart = Number.POSITIVE_INFINITY
  for (const job of jobs) {
    if (job.run_attempt !== attempt) continue
    if (job.started_at) earliestStart = Math.min(earliestStart, Date.parse(job.started_at))
    if (job.name !== 'pipeline-attempt-close') counts[job.name] = (counts[job.name] ?? 0) + 1
  }
  const links: OtlpLink[] = jobs.flatMap((row) => {
    if (
      row.run_attempt !== attempt ||
      !row.started_at ||
      row.name === 'pipeline-attempt-close' ||
      counts[row.name] !== 1
    )
      return []
    const identity = pipelineJobIdentityForName(row.name)
    if (!identity) return []
    return [
      {
        traceId: deriveJobTraceId(runId, identity.job, identity.dimensions),
        spanId: deriveJobRootSpanId(runId, identity.job, identity.dimensions),
        attributes: [str('buck2.job_trace.link_state', 'unverified')],
      },
    ]
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
    payload: {
      resourceSpans: [
        {
          resource: { attributes: [str('service.name', 'effect-utils-ci')] },
          scopeSpans: [
            {
              scope: { name: 'pipeline-attempt-close' },
              spans: [
                {
                  traceId,
                  spanId: derivePipelineRootSpanId(runId),
                  name: 'cicd.pipeline.run',
                  kind: 1,
                  startTimeUnixNano: nano(
                    Number.isFinite(earliestStart)
                      ? earliestStart
                      : Date.parse(run.run_started_at ?? run.created_at),
                  ),
                  endTimeUnixNano: nano(Math.max(Date.parse(run.updated_at), Date.parse(closedAt))),
                  attributes: [str('cicd.pipeline.run.id', runId)],
                  links,
                },
              ],
            },
          ],
        },
      ],
    },
  }
}
