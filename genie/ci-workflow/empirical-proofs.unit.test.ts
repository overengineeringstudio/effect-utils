import { expect, test } from 'bun:test'

import ciWorkflow from '../../.github/workflows/ci.yml.genie.ts'
import empiricalWorkflow from '../../.github/workflows/empirical-proofs.yml.genie.ts'
import storybookPlaysWorkflow from '../../.github/workflows/storybook-plays.yml.genie.ts'
import { decodeBinaryCacheDescriptor } from '../../packages/@overeng/genie/src/runtime/github-workflow/binary-cache-descriptor.ts'
import {
  cachixCliBuildStep,
  cachixStep,
  checkoutStep,
  installNixStep,
  linuxSandboxPrerequisitesStep,
  namespaceLinuxX64PairedPerfRunner,
  prepareCiScriptsStep,
  preparePinnedDevenvStep,
  validateNixStoreStep,
} from '../ci-workflow.ts'
import { EMPIRICAL_PROOF_CI_JOB_NAMES, requiredCIJobs, RUNNER_PROFILES } from '../ci.ts'
import { jobCacheDescriptors } from './cache-policy.ts'

const workflow = ciWorkflow.stringify({ cwd: process.cwd(), location: '' })
const proofWorkflow = empiricalWorkflow.stringify({ cwd: process.cwd(), location: '' })
const playsWorkflow = storybookPlaysWorkflow.stringify({ cwd: process.cwd(), location: '' })
const proofJobIds = Array.from(
  proofWorkflow.split('\njobs:\n')[1]!.matchAll(/^  ([a-zA-Z0-9_-]+):$/gm),
  ([, id]) => id!,
)
const workflowForJob = (jobId: string) =>
  jobId === 'test-storybook-plays'
    ? playsWorkflow
    : proofJobIds.includes(jobId)
      ? proofWorkflow
      : workflow
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
  runNotionIntegrationOnBranch = false,
  headRepository = 'owner/repo',
) => {
  const triggers = workflowForJob(jobId).split('\njobs:\n')[0]!
  const trigger = triggers.match(
    new RegExp(`\\n  ${eventName}:([^]*?)(?=\\n  [^\\s]|\\n[^\\s]|$)`),
  )?.[1]
  if (trigger === undefined) return false
  const activities = trigger
    .match(/types: \[([^\]]+)\]/)?.[1]
    ?.split(', ')
    .map((value) => value.trim())
  if (activities !== undefined && activities.includes(action) === false) return false
  return Boolean(
    new Function(
      'github',
      'inputs',
      'contains',
      'success',
      'cancelled',
      // Model an already-tested main tree; this matrix tests queue admission,
      // not the separate fallback path for an untested main push.
      `return (${condition(jobId)
        .replace(
          'github.event.pull_request.labels.*.name',
          'github.event.pull_request.labels.map(label => label.name)',
        )
        .replace('needs.tested-tree.outputs.tested', "'true'")})`,
    )(
      {
        event_name: eventName,
        ref,
        repository: 'owner/repo',
        event: {
          action,
          label: { name: label },
          pull_request: {
            labels: labels.map((name) => ({ name })),
            head: { repo: { full_name: headRepository, fork: headRepository !== 'owner/repo' } },
          },
        },
      },
      {
        measurement_baseline_ref: baselineRef,
        run_notion_integration_on_branch: runNotionIntegrationOnBranch,
      },
      (values: string[], value: string) => values.includes(value),
      () => true,
      () => false,
    ),
  )
}

test('Notion secrets require main or an explicit branch dispatch, never a PR', () => {
  const job = 'test-integration-notion'
  const select = (event: string, ref: string, optIn: boolean, action = '', baseline = '') =>
    admitted(job, event, ref, action, [], '', baseline, optIn)
  for (const ref of ['refs/heads/main', 'refs/heads/feature', 'refs/pull/1/merge']) {
    for (const optIn of [false, true]) {
      expect(select('pull_request', ref, optIn, 'synchronize')).toBe(false)
      expect(select('pull_request_target', ref, optIn, 'synchronize')).toBe(false)
      expect(
        admitted(job, 'pull_request', ref, 'synchronize', [], '', '', optIn, 'fork/repo'),
      ).toBe(false)
      expect(select('merge_group', ref, optIn, 'checks_requested')).toBe(false)
      expect(select('schedule', ref, optIn)).toBe(false)
    }
  }
  expect(select('push', 'refs/heads/main', false)).toBe(true)
  expect(select('push', 'refs/heads/feature', true)).toBe(false)
  expect(select('workflow_dispatch', 'refs/heads/main', false)).toBe(true)
  expect(select('workflow_dispatch', 'refs/heads/feature', false)).toBe(false)
  expect(select('workflow_dispatch', 'refs/heads/feature', true)).toBe(true)
  expect(select('workflow_dispatch', 'refs/heads/feature', true, '', 'baseline')).toBe(false)
  expect(workflow).toContain('run_notion_integration_on_branch:')
})

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
  for (const jobId of [
    'trusted-buck2-remote-cache-proof',
    'build-products',
    'quality',
    'test',
    'test-macos',
  ]) {
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
  expect(admitted('quality', 'pull_request', 'refs/pull/1/merge', 'synchronize')).toBe(true)
  for (const jobId of ['build-products', 'test', 'test-macos']) {
    expect(admitted(jobId, 'pull_request', 'refs/pull/1/merge', 'synchronize')).toBe(false)
    expect(
      admitted(jobId, 'merge_group', 'refs/heads/gh-readonly-queue/main/pr-1', 'checks_requested'),
    ).toBe(true)
  }
})

test('heavy product lanes run only on the mandatory native merge-group head', () => {
  for (const jobId of [
    'test',
    'test-macos',
    'test-playwright-utils',
    'test-playwright-tui-react',
    'cargo',
    'weaver',
    'test-integration-restate',
    'build-products',
    'pr-a-inert-buck',
    'test-storybook-plays',
  ]) {
    expect(
      admitted(jobId, 'merge_group', 'refs/heads/gh-readonly-queue/main/pr-1', 'checks_requested'),
    ).toBe(true)
    expect(
      admitted(jobId, 'merge_group', 'refs/heads/gh-readonly-queue/main/pr-1', 'destroyed'),
    ).toBe(false)
    for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
      expect(admitted(jobId, event, 'refs/heads/main', 'synchronize')).toBe(false)
    }
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
    const jobId =
      name === 'test (namespace-profile-macos-arm64)'
        ? 'test-macos'
        : name.startsWith('test (')
          ? 'test'
          : name
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

test('Linux sandbox prerequisites run only on Namespace profiles', () => {
  const namespaceProfiles = new Set<string>([...RUNNER_PROFILES, namespaceLinuxX64PairedPerfRunner])
  for (const job of Object.values(empiricalWorkflow.data.jobs)) {
    if (job.steps.some((step) => step.name === 'Log Linux sandbox prerequisites') !== true) continue
    const runners = job['runs-on']
    const labels = typeof runners === 'string' ? [runners] : runners
    expect(labels.some((label) => namespaceProfiles.has(label.split(';')[0]!))).toBe(true)
  }
})

test('daily cache join is isolated from required CI and other empirical jobs', () => {
  const jobId = 'buck2-cache-join'
  const job = empiricalWorkflow.data.jobs[jobId]!
  expect(ciWorkflow.data.jobs[jobId]).toBeUndefined()
  expect(requiredCIJobs.includes(jobId)).toBe(false)
  expect(requiredCIJobs.includes(job.name ?? jobId)).toBe(false)
  expect(job['continue-on-error']).toBe(true)
  expect(job.needs).toBeUndefined()
  for (const [otherId, otherJob] of Object.entries(empiricalWorkflow.data.jobs)) {
    if (otherId === jobId) continue
    expect(otherJob.steps.some((step) => step.name === 'Require daily cache metrics export')).toBe(
      false,
    )
    const dependencies = otherJob.needs
    expect(
      typeof dependencies === 'string' ? dependencies === jobId : dependencies?.includes(jobId),
    ).not.toBe(true)
  }
})

test('daily cache join admits only scheduled and manual runs, including branch dispatches', () => {
  for (const ref of ['refs/heads/main', 'refs/heads/feature']) {
    expect(admitted('buck2-cache-join', 'schedule', ref)).toBe(true)
    expect(admitted('buck2-cache-join', 'workflow_dispatch', ref)).toBe(true)
    expect(admitted('buck2-cache-join', 'push', ref)).toBe(false)
  }
  for (const event of ['pull_request', 'pull_request_target', 'merge_group']) {
    expect(
      admitted(
        'buck2-cache-join',
        event,
        'refs/pull/1/merge',
        'labeled',
        ['ci:heavy-proofs'],
        'ci:heavy-proofs',
      ),
    ).toBe(false)
  }
  expect(proofWorkflow).toContain('cron: 17 3 * * *')
})

test('pinned devenv jobs configure a public binary cache before entering devenv', () => {
  const violations: string[] = []
  const cacheStepName = cachixStep({ name: 'overeng-effect-utils' }).name
  for (const [workflowName, generated] of [
    ['empirical-proofs', empiricalWorkflow],
    ['ci', ciWorkflow],
  ] as const) {
    for (const [jobId, job] of Object.entries(generated.data.jobs)) {
      const devenvIndex = job.steps.findIndex(
        (step) =>
          step.name === preparePinnedDevenvStep.name || step.name === validateNixStoreStep.name,
      )
      if (devenvIndex === -1) continue
      const cliIndex = job.steps.findIndex((step) => step.name === cachixCliBuildStep.name)
      const cacheIndex = job.steps.findIndex((step) => step.name === cacheStepName)
      const hasCachixSetup = cliIndex >= 0 && cliIndex < cacheIndex && cacheIndex < devenvIndex
      const hasInstallerCache = job.steps.slice(0, devenvIndex).some((step) => {
        if (step.uses !== installNixStep().uses || !(jobCacheDescriptors in step)) return false
        const descriptors = step[jobCacheDescriptors]
        return (
          Array.isArray(descriptors) &&
          descriptors.some((value) => {
            const cache = decodeBinaryCacheDescriptor(value)
            return cache.kind === 'nix-binary' && cache.visibility === 'public'
          })
        )
      })
      if (!hasCachixSetup && !hasInstallerCache) violations.push(`${workflowName}/${jobId}`)
    }
  }
  expect(violations).toEqual([])
})

test('daily cache join initializes pinned devenv before running tasks', () => {
  const steps = empiricalWorkflow.data.jobs['buck2-cache-join']!.steps
  const setup = [
    checkoutStep(),
    installNixStep(),
    linuxSandboxPrerequisitesStep({ privileged: 'always' }),
    prepareCiScriptsStep,
    preparePinnedDevenvStep,
    validateNixStoreStep,
  ]
  const stepIdentity = (step: (typeof steps)[number]) => step.name ?? step.uses
  const setupIdentities = setup.map(stepIdentity)
  const setupSteps = steps.filter((step) => setupIdentities.includes(stepIdentity(step)))
  expect(setupSteps.map(stepIdentity)).toEqual(setupIdentities)
  const pinnedIndex = steps.findIndex((step) => step.name === preparePinnedDevenvStep.name)
  expect(steps[pinnedIndex + 1]?.name).toBe(validateNixStoreStep.name)
  expect(steps[pinnedIndex + 2]?.name).toBe('Prepare source script dependencies')
})

test('daily cache join has read-only GitHub access and uses the previous-day metrics spool', () => {
  const job = empiricalWorkflow.data.jobs['buck2-cache-join']!
  expect(job.permissions).toEqual({ contents: 'read', actions: 'read', 'id-token': 'write' })
  expect(job.env?.BUCK2_PUBLIC_CACHE_READ_ONLY).toBe('1')
  const join = job.steps.find((step) => step.name === 'Join previous UTC day cache evidence')
  expect(join?.env?.GITHUB_TOKEN).toBe('${{ github.token }}')
  expect(join !== undefined && 'run' in join ? join.run : undefined).toContain(
    '--repo "$GITHUB_REPOSITORY" --previous-utc-day --otlp-spool "$spool/pending"',
  )
  expect(JSON.stringify(job).match(/secrets\.[A-Z_]+/g)).toBeNull()
})

test('daily warm99 proof retains authoritative history and full observations for ninety days', () => {
  const job = empiricalWorkflow.data.jobs['buck2-cache-join']!
  const join = job.steps.find((step) => step.name === 'Join previous UTC day cache evidence')
  expect(join !== undefined && 'run' in join ? join.run : undefined).toContain(
    '--proof-directory "$GITHUB_WORKSPACE/tmp/buck2-cache-history-proof"',
  )
  const upload = job.steps.find(
    (step) => step.name === 'Upload authoritative Buck2 warm99 proof observations',
  )
  expect(upload?.if).toBe('${{ always() }}')
  expect(upload !== undefined && 'with' in upload ? upload.with?.path : undefined).toBe(
    '${{ github.workspace }}/tmp/buck2-cache-history-proof',
  )
  expect(
    upload !== undefined && 'with' in upload ? upload.with?.['retention-days'] : undefined,
  ).toBe(90)
})

test('daily cache export postcheck follows telemetry export and fails on pending chunks', () => {
  const steps = empiricalWorkflow.data.jobs['buck2-cache-join']!.steps
  const exportIndex = steps.findIndex(
    (step) => typeof step.run === 'string' && step.run.includes('evidence-job.sh export'),
  )
  const checkIndex = steps.findIndex((step) => step.name === 'Require daily cache metrics export')
  expect(exportIndex).toBeGreaterThanOrEqual(0)
  expect(checkIndex).toBeGreaterThan(exportIndex)
  const check = steps[checkIndex]!
  expect(check['continue-on-error']).not.toBe(true)
  expect(check.if).toBeUndefined()
  expect('run' in check ? check.run : undefined).toContain(
    ': "${BUCK2_CACHE_JOIN_PENDING:?join did not declare its metrics spool}"',
  )
  expect('run' in check ? check.run : undefined).toContain(
    'chunks=("$BUCK2_CACHE_JOIN_PENDING"/*.metrics.chunk)',
  )
  expect('run' in check ? check.run : undefined).toContain('if (( ${#chunks[@]} != 0 )); then')
  expect('run' in check ? check.run : undefined).toContain('exit 1')
})
