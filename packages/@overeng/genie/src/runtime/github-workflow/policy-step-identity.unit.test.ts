import { describe, expect, it } from 'vitest'

import type { GitHubWorkflowArgs } from './mod.ts'
import { workflowPolicyStepIdentity } from './policy-step-identity.ts'
import {
  collectWorkflowPolicyViolations,
  validateWorkflowPolicy,
  WorkflowPolicyError,
  type WorkflowPolicy,
  type WorkflowPolicyViolation,
} from './policy.ts'

type Step = GitHubWorkflowArgs['jobs'][string]['steps'][number]

const policy: WorkflowPolicy = {
  repository: 'example/project',
  workflow: 'ci.yml',
  admittedRunnerLabels: ['pool-small'],
  bannedActions: ['actions/upload-artifact'],
}
const workflow = (steps: Step[]): GitHubWorkflowArgs => ({
  on: 'push',
  jobs: { test: { 'runs-on': 'pool-small', steps } },
})
const collect = (steps: Step[]) =>
  collectWorkflowPolicyViolations({ workflow: workflow(steps), policy })
const reportIssues = (steps: Step[], ledger: readonly WorkflowPolicyViolation[]) => {
  try {
    validateWorkflowPolicy({
      workflow: workflow(steps),
      policy: { ...policy, mode: 'report', ledger },
    })
    return []
  } catch (error) {
    if (error instanceof WorkflowPolicyError) return error.issues
    throw error
  }
}

const namedUploads: Step[] = [
  { name: 'Upload logs', uses: 'actions/upload-artifact@v4' },
  { name: 'Upload results', uses: 'actions/upload-artifact@v4' },
]
const identifiedUploads: Step[] = [
  { id: 'upload-logs', name: 'Upload artifact', uses: 'actions/upload-artifact@v4' },
  { id: 'upload-results', name: 'Upload artifact', uses: 'actions/upload-artifact@v4' },
]

// Exercise the collector and report-mode validator, not just helper output: a
// repaired violation must leave one stale entry rather than re-keying survivors.
describe('stable workflow policy step identities', () => {
  it.each([
    { kind: 'named', steps: namedUploads },
    { kind: 'identified', steps: identifiedUploads },
  ])('keeps a surviving $kind upload stable after removing the first upload', ({ steps }) => {
    const ledger = collect(steps)
    expect(ledger).toHaveLength(2)
    expect(ledger[0]?.path).not.toBe(ledger[1]?.path)

    const remaining = steps.slice(1)
    expect(collect(remaining)).toEqual(ledger.slice(1))
    const issues = reportIssues(remaining, ledger)
    expect(issues.map((issue) => issue.kind)).toEqual(['STALE'])
    expect(issues[0]?.violation).toEqual(ledger[0])
  })

  it.each([
    { kind: 'named', steps: namedUploads },
    { kind: 'identified', steps: identifiedUploads },
  ])('does not churn $kind upload ledger keys when clean steps are inserted', ({ steps }) => {
    const ledger = collect(steps)
    const expanded: Step[] = [
      { run: 'echo prepare' },
      ...steps.slice(0, 1),
      { uses: 'actions/checkout@v4' },
      { name: 'Check output', run: 'echo output' },
      ...steps.slice(1),
      { run: 'echo complete' },
    ]
    expect(collect(expanded)).toEqual(ledger)
    expect(reportIssues(expanded, ledger)).toEqual([])
  })

  it('numbers unnamed actions by repository occurrence rather than absolute step position or ref', () => {
    const steps: Step[] = [
      { uses: 'actions/upload-artifact@v3' },
      { uses: 'actions/upload-artifact@v4' },
    ]
    const ledger = collect(steps)
    expect(ledger.map((violation) => violation.path)).toEqual([
      'jobs.test.steps[action:"actions/upload-artifact"].uses',
      'jobs.test.steps[action:"actions/upload-artifact"#2].uses',
    ])
    const expanded: Step[] = [
      { run: 'echo prepare' },
      ...steps.slice(0, 1),
      { uses: 'actions/checkout@v4' },
      { name: 'Prepare output', run: 'echo output' },
      ...steps.slice(1),
    ]
    expect(collect(expanded)).toEqual(ledger)
    expect(reportIssues(expanded, ledger)).toEqual([])
  })

  it('does not merge violations from steps sharing a name', () => {
    const steps: Step[] = [
      { name: 'Upload artifact', uses: 'actions/upload-artifact@v4' },
      { name: 'Upload artifact', uses: 'actions/upload-artifact@v4' },
      { name: 'Upload artifact#2', uses: 'actions/upload-artifact@v4' },
    ]
    const ledger = collect(steps)
    expect(ledger.map((violation) => violation.path)).toEqual([
      'jobs.test.steps[name:"Upload artifact"].uses',
      'jobs.test.steps[name:"Upload artifact"#2].uses',
      'jobs.test.steps[name:"Upload artifact#2"].uses',
    ])
    expect(reportIssues(steps, ledger)).toEqual([])
    expect(reportIssues(steps, ledger.slice(0, 1)).map((issue) => issue.kind)).toEqual([
      'NEW',
      'NEW',
    ])
  })

  it('keeps same-name run steps in the per-job ordinal sequence', () => {
    expect(
      collect([
        { name: 'Repeated', run: 'echo prepare' },
        { name: 'Repeated', uses: 'actions/upload-artifact@v4' },
      ]).map((violation) => violation.path),
    ).toEqual(['jobs.test.steps[name:"Repeated"#2].uses'])
  })

  it('resets ordinals for each job', () => {
    const input = workflow([{ name: 'Upload artifact', uses: 'actions/upload-artifact@v4' }])
    input.jobs.other = {
      'runs-on': 'pool-small',
      steps: [{ name: 'Upload artifact', uses: 'actions/upload-artifact@v4' }],
    }
    expect(
      collectWorkflowPolicyViolations({ workflow: input, policy }).map(
        (violation) => violation.path,
      ),
    ).toEqual([
      'jobs.test.steps[name:"Upload artifact"].uses',
      'jobs.other.steps[name:"Upload artifact"].uses',
    ])
  })

  it('prefers IDs over names and JSON-escapes delimiter-bearing identities', () => {
    const ordinals = new Map<string, number>()
    const id = 'artifact"].uses[name:"other\\path\n'
    expect(
      workflowPolicyStepIdentity({
        step: { id, name: 'Ignored name', uses: 'actions/upload-artifact@v4' },
        ordinals,
      }),
    ).toBe(`id:${JSON.stringify(id)}`)
    expect(workflowPolicyStepIdentity({ step: { name: id, run: 'echo ok' }, ordinals })).toBe(
      `name:${JSON.stringify(id)}`,
    )
    expect(
      workflowPolicyStepIdentity({
        step: { id, name: 'Changed name', uses: 'actions/upload-artifact@v5' },
        ordinals,
      }),
    ).toBe(`id:${JSON.stringify(id)}#2`)
  })

  it('provides ordinal identities for unnamed run steps without shifting action identities', () => {
    const ordinals = new Map<string, number>()
    const steps: Step[] = [
      { run: 'echo first' },
      { uses: 'actions/checkout@v4' },
      { run: 'echo second' },
    ]
    expect(steps.map((step) => workflowPolicyStepIdentity({ step, ordinals }))).toEqual([
      'run',
      'action:"actions/checkout"',
      'run#2',
    ])
  })
})
