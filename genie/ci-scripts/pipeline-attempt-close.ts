import {
  closePayload,
  type Job,
  type WorkflowRun,
} from '../../packages/@overeng/ci-tools/src/pipeline-attempt-close.ts'

const api = async <A>({ route, token }: { route: string; token: string }): Promise<A> => {
  const response = await fetch(`https://api.github.com/repos/${route}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (response.ok === false) throw new Error(`Jobs API ${response.status}: ${route}`)
  return (await response.json()) as A
}

export const finalizeAttempt = async (input: {
  repository: string
  runId: string
  attempt: number
  token: string
  spool: string
}) => {
  const { repository, runId, attempt, token, spool } = input
  const run = await api<WorkflowRun>({ route: `${repository}/actions/runs/${runId}`, token })
  const jobs: Job[] = []
  for (let page = 1; ; page++) {
    // oxlint-disable-next-line no-await-in-loop -- The next page is needed only when this page is full.
    const response = await api<{ jobs: Job[] }>({
      route: `${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
      token,
    })
    jobs.push(...response.jobs)
    if (response.jobs.length < 100) break
  }
  const id = `ci/github/${encodeURIComponent(repository)}/${runId}/${attempt}`
  const { traceId, jobLinks, payload } = closePayload({
    runId: id,
    attempt,
    jobs,
    run,
    closedAt: new Date().toISOString(),
  })
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
