import { describe, expect, it } from 'bun:test'

import { hasRequiredQueueEvidence, type QueueJob, type QueueRun } from './tested-tree.ts'

const repository = 'overengineeringstudio/effect-utils'
const head = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const run: QueueRun = {
  id: 42,
  run_attempt: 2,
  event: 'merge_group',
  head_branch: 'gh-readonly-queue/main/pr-31-abcdef',
  head_sha: head,
  path: '.github/workflows/ci.yml',
  status: 'completed',
  repository: { full_name: repository },
  head_repository: { full_name: repository },
}
const jobs: QueueJob[] = ['pr/quality', 'test (namespace-profile-linux-x86-64)'].map((name) => ({
  name,
  run_id: run.id,
  run_attempt: run.run_attempt,
  head_sha: head,
  status: 'completed',
  conclusion: 'success',
}))
const evidence = {
  repository,
  workflow: run.path,
  head,
  pushedTree: tree,
  queueTree: tree,
  run,
  jobs,
  required: jobs.map((job) => job.name),
}

describe('trusted tested-tree evidence', () => {
  it('accepts exact trees with all required jobs successful even when unrelated publishing failed', () => {
    expect(
      hasRequiredQueueEvidence({
        ...evidence,
        jobs: [...jobs, { ...jobs[0]!, name: 'publish-products', conclusion: 'failure' }],
      }),
    ).toBe(true)
  })
  it('rejects mismatched or missing trees', () => {
    expect(hasRequiredQueueEvidence({ ...evidence, queueTree: 'c'.repeat(40) })).toBe(false)
    expect(hasRequiredQueueEvidence({ ...evidence, pushedTree: '', queueTree: '' })).toBe(false)
  })
  it('rejects failed, cancelled, skipped, pending and missing required evidence', () => {
    for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
      expect(
        hasRequiredQueueEvidence({ ...evidence, jobs: [{ ...jobs[0]!, conclusion }, jobs[1]!] }),
      ).toBe(false)
    }
    expect(hasRequiredQueueEvidence({ ...evidence, jobs: jobs.slice(1) })).toBe(false)
    expect(hasRequiredQueueEvidence({ ...evidence, required: [] })).toBe(false)
  })
  it('rejects PR, non-main queue, ordinary branch, foreign repository and wrong workflow identities', () => {
    for (const change of [
      { event: 'pull_request' },
      { head_branch: 'gh-readonly-queue/develop/pr-31-abcdef' },
      { head_branch: 'main' },
      { repository: { full_name: 'attacker/fork' } },
      { head_repository: { full_name: 'attacker/fork' } },
      { path: '.github/workflows/other.yml' },
      { status: 'in_progress' },
      { head_sha: 'd'.repeat(40) },
    ])
      expect(hasRequiredQueueEvidence({ ...evidence, run: { ...run, ...change } })).toBe(false)
  })
  it('rejects old attempts and jobs from other runs or heads despite identical check names', () => {
    for (const change of [
      { run_attempt: 1 },
      { run_id: 41 },
      { head_sha: 'd'.repeat(40) },
      { status: 'in_progress' },
    ]) {
      expect(
        hasRequiredQueueEvidence({ ...evidence, jobs: [{ ...jobs[0]!, ...change }, jobs[1]!] }),
      ).toBe(false)
    }
  })
  it('rejects ambiguous duplicate required jobs', () => {
    expect(hasRequiredQueueEvidence({ ...evidence, jobs: [...jobs, jobs[0]!] })).toBe(false)
  })
  it('accepts standalone evidence only for its explicit workflow and exact queue head', () => {
    const standalone = { ...run, id: 43, path: '.github/workflows/storybook-plays.yml' }
    const standaloneJobs = [{ ...jobs[0]!, run_id: 43, name: 'test-storybook-plays' }]
    expect(
      hasRequiredQueueEvidence({
        ...evidence,
        workflow: standalone.path,
        run: standalone,
        jobs: standaloneJobs,
        required: ['test-storybook-plays'],
      }),
    ).toBe(true)
    expect(
      hasRequiredQueueEvidence({
        ...evidence,
        workflow: standalone.path,
        run: standalone,
        jobs: standaloneJobs,
        head: 'd'.repeat(40),
        required: ['test-storybook-plays'],
      }),
    ).toBe(false)
  })
})
