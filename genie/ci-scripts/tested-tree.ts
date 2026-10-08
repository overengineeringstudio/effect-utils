import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { requiredCIJobs, STANDALONE_REQUIRED_CI_JOB_NAMES } from '../ci.ts'

const ciWorkflow = '.github/workflows/ci.yml'
const storybookWorkflow = '.github/workflows/storybook-plays.yml'
const maxRuns = 30
const maxJobPages = 3
const maxAgeMs = 7 * 24 * 60 * 60 * 1000

export type QueueRun = {
  id: number
  run_attempt: number
  event: string
  head_branch: string
  head_sha: string
  path: string
  status: string
  repository: { full_name: string }
  head_repository: { full_name: string }
}
export type QueueJob = {
  name: string
  run_id: number
  run_attempt: number
  head_sha: string
  status: string
  conclusion: string | null
}
export type TestedTreeDecision = {
  tested: boolean
  summary: string
  tree?: string
  head?: string
  runId?: number
}

type QueueIdentity = { repository: string; workflow: string; head: string; run: QueueRun }

const isTrustedQueueRun = ({ repository, workflow, head, run }: QueueIdentity): boolean =>
  run.event === 'merge_group' &&
  /^gh-readonly-queue\/main\/pr-\d+-[0-9a-f]+$/.test(run.head_branch) &&
  run.repository.full_name === repository &&
  run.head_repository.full_name === repository &&
  run.path === workflow &&
  run.head_sha === head &&
  Number.isSafeInteger(run.id) &&
  run.id > 0 &&
  Number.isSafeInteger(run.run_attempt) &&
  run.run_attempt > 0

/** Required job checks prove the current attempt; unrelated jobs may fail or still be finishing. */
export const hasRequiredQueueEvidence = (
  input: QueueIdentity & {
    pushedTree: string
    queueTree: string
    jobs: readonly QueueJob[]
    required: readonly string[]
  },
): boolean => {
  const { head, run, jobs, required, pushedTree, queueTree } = input
  if (
    required.length === 0 ||
    /^[0-9a-f]{40}$/.test(pushedTree) === false ||
    pushedTree !== queueTree ||
    isTrustedQueueRun(input) === false
  )
    return false
  return required.every((name) => {
    const matches = jobs.filter((job) => job.name === name)
    return (
      matches.length === 1 &&
      matches.every(
        (job) =>
          job.run_id === run.id &&
          job.run_attempt === run.run_attempt &&
          job.head_sha === head &&
          job.status === 'completed' &&
          job.conclusion === 'success',
      )
    )
  })
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true)
    throw new Error('Invalid API object')
  return value as Record<string, unknown>
}
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Invalid API string')
  return value
}
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || Number.isSafeInteger(value) === false)
    throw new Error('Invalid API integer')
  return value
}
const array = (value: unknown): unknown[] => {
  if (Array.isArray(value) === false) throw new Error('Invalid API array')
  return value
}
const decodeRun = (value: unknown): QueueRun => {
  const run = record(value)
  return {
    id: integer(run.id),
    run_attempt: integer(run.run_attempt),
    event: text(run.event),
    head_branch: text(run.head_branch),
    head_sha: text(run.head_sha),
    path: text(run.path),
    status: text(run.status),
    repository: { full_name: text(record(run.repository).full_name) },
    head_repository: { full_name: text(record(run.head_repository).full_name) },
  }
}
const decodeJob = (value: unknown): QueueJob => {
  const job = record(value)
  return {
    name: text(job.name),
    run_id: integer(job.run_id),
    run_attempt: integer(job.run_attempt),
    head_sha: text(job.head_sha),
    status: text(job.status),
    conclusion: job.conclusion === null ? null : text(job.conclusion),
  }
}

/** Bounded read-only lookup. Any API/decode error returns false so heavy CI remains authoritative. */
export const lookupTestedTree = async (input: {
  repository: string
  sha: string
  token?: string
  event: string
  ref: string
}): Promise<TestedTreeDecision> => {
  try {
    if (input.event !== 'push' || input.ref !== 'refs/heads/main')
      return { tested: false, summary: 'Not a main push' }
    if (
      /^[\w.-]+\/[\w.-]+$/.test(input.repository) === false ||
      /^[0-9a-f]{40}$/.test(input.sha) === false
    ) {
      return { tested: false, summary: 'Missing or invalid repository/SHA' }
    }
    const deadline = Date.now() + 45_000
    const api = async (route: string): Promise<unknown> => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('Lookup time limit reached')
      const response = await fetch(`https://api.github.com/repos/${input.repository}/${route}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(input.token === undefined ? {} : { Authorization: `Bearer ${input.token}` }),
        },
        signal: AbortSignal.timeout(Math.min(remaining, 10_000)),
      })
      if (response.ok === false) throw new Error(`GitHub API HTTP ${response.status}`)
      return response.json()
    }
    const branch = record(await api('branches/main'))
    if (branch.protected !== true) return { tested: false, summary: 'Main is not protected' }
    const treeOf = async (sha: string): Promise<string> => {
      const commit = record(await api(`git/commits/${sha}`))
      if (commit.sha !== sha) throw new Error('Commit API SHA mismatch')
      const tree = text(record(commit.tree).sha)
      if (/^[0-9a-f]{40}$/.test(tree) === false) throw new Error('Invalid commit tree')
      return tree
    }
    const tree = await treeOf(input.sha)
    const since = new Date(Date.now() - maxAgeMs).toISOString()
    const recent = record(
      await api(
        `actions/workflows/ci.yml/runs?event=merge_group&per_page=${maxRuns}&created=${encodeURIComponent(`>=${since}`)}`,
      ),
    )
    const runs = array(recent.workflow_runs).map(decodeRun)
    const seenHeads = new Set<string>()
    const jobsFor = async (run: QueueRun): Promise<QueueJob[]> => {
      const jobs: QueueJob[] = []
      // Pagination is bounded and sequential so it stops once all jobs are returned.
      /* oxlint-disable no-await-in-loop */
      for (let page = 1; page <= maxJobPages; page++) {
        const result = record(
          await api(
            `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
          ),
        )
        jobs.push(...array(result.jobs).map(decodeJob))
        if (jobs.length === integer(result.total_count)) return jobs
      }
      throw new Error('Jobs exceed lookup page limit')
    }
    const ciRequired = requiredCIJobs.filter(
      (name) => !STANDALONE_REQUIRED_CI_JOB_NAMES.some((standalone) => standalone === name),
    )
    // Search newest-first under one API deadline; stop on the first fully proven tree.
    for (const candidate of runs) {
      if (seenHeads.has(candidate.head_sha) === true) continue
      seenHeads.add(candidate.head_sha)
      // Reject untrusted identity before fetching either its tree or its jobs.
      if (
        isTrustedQueueRun({
          repository: input.repository,
          workflow: ciWorkflow,
          head: candidate.head_sha,
          run: candidate,
        }) === false
      )
        continue
      if (/^[0-9a-f]{40}$/.test(candidate.head_sha) === false) continue
      const queueTree = await treeOf(candidate.head_sha)
      if (queueTree !== tree) continue
      const run = decodeRun(await api(`actions/runs/${candidate.id}`))
      if (
        hasRequiredQueueEvidence({
          repository: input.repository,
          workflow: ciWorkflow,
          head: candidate.head_sha,
          pushedTree: tree,
          queueTree,
          run,
          jobs: await jobsFor(run),
          required: ciRequired,
        }) === false
      )
        continue
      const standaloneRuns = record(
        await api(
          `actions/workflows/storybook-plays.yml/runs?event=merge_group&head_sha=${candidate.head_sha}&per_page=1`,
        ),
      )
      const standaloneValue = array(standaloneRuns.workflow_runs)[0]
      if (standaloneValue === undefined) continue
      const standalone = decodeRun(standaloneValue)
      if (
        standalone.head_branch !== run.head_branch ||
        hasRequiredQueueEvidence({
          repository: input.repository,
          workflow: storybookWorkflow,
          head: run.head_sha,
          run: standalone,
          jobs: await jobsFor(standalone),
          pushedTree: tree,
          queueTree,
          required: STANDALONE_REQUIRED_CI_JOB_NAMES,
        }) === false
      )
        continue
      // A rerun started while fetching jobs invalidates the previous attempt's evidence.
      const finalRun = decodeRun(await api(`actions/runs/${run.id}`))
      const finalStandalone = decodeRun(await api(`actions/runs/${standalone.id}`))
      if (
        finalRun.run_attempt !== run.run_attempt ||
        finalStandalone.run_attempt !== standalone.run_attempt
      )
        continue
      return {
        tested: true,
        summary: `Identical tree passed all ${requiredCIJobs.length} required contexts on merge-group head ${run.head_sha}; CI run ${run.id} attempt ${run.run_attempt}, Storybook run ${standalone.id} attempt ${standalone.run_attempt}`,
        tree,
        head: run.head_sha,
        runId: run.id,
      }
    }
    return {
      tested: false,
      summary: `No trusted passing identical tree in the latest ${maxRuns} CI merge-group runs within seven days`,
      tree,
    }
  } catch (error) {
    return {
      tested: false,
      summary: `Evidence unavailable: ${error instanceof Error ? error.message : 'unknown API error'}`,
    }
  }
}

// Node 24 or Bun executable: GH_TOKEN (or GITHUB_TOKEN), GITHUB_REPOSITORY, GITHUB_SHA,
// GITHUB_EVENT_NAME=push, GITHUB_REF=refs/heads/main. GITHUB_OUTPUT is optional locally.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const decision = await lookupTestedTree({
    repository: process.env.GITHUB_REPOSITORY ?? '',
    sha: process.env.GITHUB_SHA ?? '',
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    event: process.env.GITHUB_EVENT_NAME ?? '',
    ref: process.env.GITHUB_REF ?? '',
  })
  console.log(JSON.stringify(decision))
  if (process.env.GITHUB_OUTPUT !== undefined)
    await appendFile(process.env.GITHUB_OUTPUT, `tested=${decision.tested}\n`)
  if (process.env.GITHUB_STEP_SUMMARY !== undefined)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Tested-tree decision\n\n\`tested=${decision.tested}\` — ${decision.summary}\n`,
    )
}
