import { expect, test } from 'bun:test'

import ciWorkflow from '../../.github/workflows/ci.yml.genie.ts'
import empiricalWorkflow from '../../.github/workflows/empirical-proofs.yml.genie.ts'
import { EMPIRICAL_PROOF_CI_JOB_NAMES, requiredCIJobs } from '../ci.ts'

const workflow = ciWorkflow.stringify({ cwd: process.cwd(), location: '' })
const proofWorkflow = empiricalWorkflow.stringify({ cwd: process.cwd(), location: '' })
const proofJobIds = Array.from(
  proofWorkflow.split('\njobs:\n')[1]!.matchAll(/^  ([a-zA-Z0-9_-]+):$/gm),
  ([, id]) => id!,
)
const workflowForJob = (jobId: string) => (proofJobIds.includes(jobId) ? proofWorkflow : workflow)
const condition = (jobId: string) => {
  const block = workflowForJob(jobId).match(
    new RegExp(`\\n  ${jobId}:\\n([\\s\\S]*?)(?=\\n  [^\\s]|$)`),
  )?.[1]
  const expression = block?.match(/(?:^|\n)    if: (.+)/)?.[1]
  return (expression ?? '${{ success() }}').replace(/^\$\{\{\s*|\s*\}\}$/g, '')
}

const admitted = (
  jobId: string,
  eventName: string,
  ref: string,
  action = '',
  labels: string[] = [],
  label = '',
  baselineRef = '',
) => {
  const triggers = workflowForJob(jobId).split('\njobs:\n')[0]!
  if (eventName === 'pull_request') {
    const activities = triggers
      .match(/types: \[([^\]]+)\]/)?.[1]
      ?.split(', ')
      .map((value) => value.trim())
    if (activities?.includes(action) !== true) return false
  }
  if (eventName === 'schedule' && triggers.includes('\n  schedule:') === false) return false
  return Boolean(
    new Function(
      'github',
      'inputs',
      'contains',
      'success',
      'cancelled',
      `return (${condition(jobId).replace('github.event.pull_request.labels.*.name', 'github.event.pull_request.labels.map(label => label.name)')})`,
    )(
      {
        event_name: eventName,
        ref,
        event: {
          action,
          label: { name: label },
          pull_request: { labels: labels.map((name) => ({ name })) },
        },
      },
      { measurement_baseline_ref: baselineRef },
      (values: string[], value: string) => values.includes(value),
      () => true,
      () => false,
    ),
  )
}

for (const jobId of EMPIRICAL_PROOF_CI_JOB_NAMES) {
  test(`${jobId} admits main proofs and only opted-in PRs`, () => {
    for (const event of ['push', 'schedule', 'workflow_dispatch']) {
      expect(admitted(jobId, event, 'refs/heads/main')).toBe(true)
      expect(admitted(jobId, event, 'refs/heads/feature')).toBe(false)
    }
    expect(admitted(jobId, 'pull_request', 'refs/pull/1/merge', 'synchronize')).toBe(false)
    expect(
      admitted(jobId, 'pull_request', 'refs/pull/1/merge', 'synchronize', ['ci:heavy-proofs']),
    ).toBe(true)
    expect(
      admitted(
        jobId,
        'pull_request',
        'refs/pull/1/merge',
        'labeled',
        ['ci:heavy-proofs'],
        'ci:heavy-proofs',
      ),
    ).toBe(true)
    expect(
      admitted(
        jobId,
        'pull_request',
        'refs/pull/1/merge',
        'labeled',
        ['ci:heavy-proofs'],
        'area:ci',
      ),
    ).toBe(false)
    expect(requiredCIJobs.includes(jobId)).toBe(false)
  })
}

test('proof opt-in never admits credentialed cache proof or product validation on label churn', () => {
  for (const jobId of ['trusted-buck2-remote-cache-proof', 'build-products', 'quality', 'test']) {
    expect(
      admitted(
        jobId,
        'pull_request',
        'refs/pull/1/merge',
        'labeled',
        ['ci:heavy-proofs'],
        'ci:heavy-proofs',
      ),
    ).toBe(false)
  }
  expect(
    admitted(
      'trusted-buck2-remote-cache-proof',
      'pull_request',
      'refs/pull/1/merge',
      'synchronize',
      ['ci:heavy-proofs'],
    ),
  ).toBe(false)
  for (const jobId of ['build-products', 'quality', 'test']) {
    expect(admitted(jobId, 'pull_request', 'refs/pull/1/merge', 'synchronize')).toBe(true)
  }
})

test('empirical proof opt-in does not admit the dispatch-only performance lane', () => {
  expect(admitted('devenv-perf', 'workflow_dispatch', 'refs/heads/main')).toBe(true)
  for (const event of ['push', 'schedule', 'pull_request']) {
    expect(
      admitted(
        'devenv-perf',
        event,
        'refs/heads/main',
        'labeled',
        ['ci:heavy-proofs'],
        'ci:heavy-proofs',
      ),
    ).toBe(false)
  }
})

test('label-triggered proofs never publish an ordinary merge-required context', () => {
  for (const jobId of proofJobIds) {
    const block = proofWorkflow.match(
      new RegExp(`\\n  ${jobId}:\\n([\\s\\S]*?)(?=\\n  [^\\s]|$)`),
    )?.[1]
    const name = block?.match(/(?:^|\n)    name: (.+)/)?.[1] ?? jobId
    expect(requiredCIJobs.includes(name)).toBe(false)
  }
  for (const name of requiredCIJobs.filter((name) => name !== 'test-storybook-plays')) {
    const jobId = name.startsWith('test (') ? 'test' : name
    expect(
      admitted(
        jobId,
        'pull_request',
        'refs/pull/1/merge',
        'labeled',
        ['ci:heavy-proofs'],
        'ci:heavy-proofs',
      ),
    ).toBe(false)
  }
})

test('required PR source evidence is partitioned from main measurement evidence', () => {
  expect(admitted('source-shape', 'pull_request', 'refs/pull/1/merge', 'synchronize')).toBe(true)
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    expect(admitted('source-shape', event, 'refs/heads/main')).toBe(false)
    expect(admitted('main-source-shape', event, 'refs/heads/main')).toBe(true)
  }
  expect(
    admitted(
      'main-source-shape',
      'pull_request',
      'refs/pull/1/merge',
      'labeled',
      ['ci:heavy-proofs'],
      'ci:heavy-proofs',
    ),
  ).toBe(false)
})

test('empirical workflow cannot receive writer credentials or enable uploads', () => {
  const decoded = Bun.YAML.parse(proofWorkflow) as {
    jobs: Record<string, { env: Record<string, string> }>
  }
  for (const jobId of proofJobIds) {
    const proofJob = decoded.jobs[jobId]!
    expect(proofJob.env.BUCK2_PUBLIC_CACHE_READ_ONLY).toBe('1')
    expect(JSON.stringify(proofJob).match(/secrets\.[A-Z_]+/g)).toBeNull()
  }
})

test('historical source measurements retain any-ref dispatch backfills', () => {
  for (const ref of ['refs/heads/main', 'refs/heads/feature']) {
    expect(
      admitted('main-source-shape', 'workflow_dispatch', ref, '', [], '', 'historical-sha'),
    ).toBe(true)
  }
  for (const event of ['push', 'schedule']) {
    expect(admitted('main-source-shape', event, 'refs/heads/feature')).toBe(false)
  }
  for (const jobId of EMPIRICAL_PROOF_CI_JOB_NAMES) {
    expect(
      admitted(jobId, 'workflow_dispatch', 'refs/heads/main', '', [], '', 'historical-sha'),
    ).toBe(false)
  }
})
