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

  it('removes same-name uploads at different refs without manufacturing new debt', () => {
    const steps: Step[] = [
      { name: 'Upload artifact', uses: 'actions/upload-artifact@v3' },
      { name: 'Upload artifact', uses: 'actions/upload-artifact@v4' },
    ]
    const ledger = collect(steps)
    expect(ledger).toHaveLength(2)
    const remaining = steps.slice(1)
    expect(collect(remaining)[0]?.value).toBe('actions/upload-artifact@v4')
    expect(reportIssues(remaining, ledger).map((issue) => issue.kind)).toEqual(['STALE'])
    expect(reportIssues(remaining, ledger.slice(0, 1))).toEqual([])
  })

  it('keeps an action ref bump diagnostic-only, not new migration debt', () => {
    const ledger = collect([{ name: 'Upload artifact', uses: 'actions/upload-artifact@v3' }])
    const bumped: Step[] = [{ name: 'Upload artifact', uses: 'actions/upload-artifact@v4' }]
    expect(collect(bumped)[0]?.value).toBe('actions/upload-artifact@v4')
    expect(reportIssues(bumped, ledger)).toEqual([])
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

  it('numbers equivalent unnamed actions independently of absolute step position or ref', () => {
    const steps: Step[] = [
      { uses: 'actions/upload-artifact@v3' },
      { uses: 'actions/upload-artifact@v4' },
    ]
    const ledger = collect(steps)
    expect(ledger.map((violation) => violation.path)).toEqual([
      'jobs.test.steps[action:"actions/upload-artifact"|content:{"with":[]}].uses',
      'jobs.test.steps[action:"actions/upload-artifact"|content:{"with":[]}#2].uses',
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
      'jobs.test.steps[name:"Upload artifact"|action:"actions/upload-artifact"|content:{"with":[]}].uses',
      'jobs.test.steps[name:"Upload artifact"|action:"actions/upload-artifact"|content:{"with":[]}#2].uses',
      'jobs.test.steps[name:"Upload artifact#2"|action:"actions/upload-artifact"|content:{"with":[]}].uses',
    ])
    expect(reportIssues(steps, ledger)).toEqual([])
    expect(reportIssues(steps, ledger.slice(0, 1)).map((issue) => issue.kind)).toEqual([
      'NEW',
      'NEW',
    ])
  })

  it('does not let same-name run steps shift action identities', () => {
    expect(
      collect([
        { name: 'Repeated', run: 'echo prepare' },
        { name: 'Repeated', uses: 'actions/upload-artifact@v4' },
      ]).map((violation) => violation.path),
    ).toEqual([
      'jobs.test.steps[name:"Repeated"|action:"actions/upload-artifact"|content:{"with":[]}].uses',
    ])
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
      'jobs.test.steps[name:"Upload artifact"|action:"actions/upload-artifact"|content:{"with":[]}].uses',
      'jobs.other.steps[name:"Upload artifact"|action:"actions/upload-artifact"|content:{"with":[]}].uses',
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
    ).toBe(`id:${JSON.stringify(id)}|action:"actions/upload-artifact"|content:{"with":[]}`)
    expect(workflowPolicyStepIdentity({ step: { name: id, run: 'echo ok' }, ordinals })).toBe(
      `name:${JSON.stringify(id)}|run|content:{"run":"echo ok"}`,
    )
    expect(
      workflowPolicyStepIdentity({
        step: { id, name: 'Changed name', uses: 'actions/upload-artifact@v5' },
        ordinals,
      }),
    ).toBe(`id:${JSON.stringify(id)}|action:"actions/upload-artifact"|content:{"with":[]}#2`)
  })

  it('distinguishes unnamed run content without shifting action identities', () => {
    const ordinals = new Map<string, number>()
    const steps: Step[] = [
      { run: 'echo first' },
      { uses: 'actions/checkout@v4' },
      { run: 'echo second' },
    ]
    expect(steps.map((step) => workflowPolicyStepIdentity({ step, ordinals }))).toEqual([
      'run|content:{"run":"echo first"}',
      'action:"actions/checkout"|content:{"with":[]}',
      'run|content:{"run":"echo second"}',
    ])
  })

  it('keeps a same-name action stable when a different action is removed', () => {
    const steps: Step[] = [
      { name: 'Transfer artifact', uses: 'actions/upload-artifact@v4' },
      { name: 'Transfer artifact', uses: 'actions/download-artifact@v4' },
    ]
    const actionPolicy: WorkflowPolicy = {
      ...policy,
      bannedActions: ['actions/upload-artifact', 'actions/download-artifact'],
    }
    const ledger = collectWorkflowPolicyViolations({
      workflow: workflow(steps),
      policy: actionPolicy,
    })
    expect(ledger).toHaveLength(2)
    const remaining = workflow(steps.slice(1))
    expect(collectWorkflowPolicyViolations({ workflow: remaining, policy: actionPolicy })).toEqual(
      ledger.slice(1),
    )
    try {
      validateWorkflowPolicy({
        workflow: remaining,
        policy: { ...actionPolicy, mode: 'report', ledger },
      })
      expect.fail('Expected the removed action to leave a stale ledger entry')
    } catch (error) {
      if (!(error instanceof WorkflowPolicyError)) throw error
      expect(error.issues.map((issue) => issue.kind)).toEqual(['STALE'])
      expect(error.issues[0]?.violation).toEqual(ledger[0])
    }
  })

  it.each([
    { label: 'name', identity: { name: 'Transfer artifact' } },
    { label: 'ID', identity: { id: 'transfer', name: 'Transfer artifact' } },
  ])('requires action provenance even with a stable $label', ({ identity }) => {
    const original: Step[] = [{ ...identity, uses: 'actions/upload-artifact@v4' }]
    const replacement: Step[] = [{ ...identity, uses: 'actions/download-artifact@v4' }]
    const actionPolicy: WorkflowPolicy = {
      ...policy,
      bannedActions: ['actions/upload-artifact', 'actions/download-artifact'],
    }
    const ledger = collectWorkflowPolicyViolations({
      workflow: workflow(original),
      policy: actionPolicy,
    })
    expect(ledger).toHaveLength(1)
    try {
      validateWorkflowPolicy({
        workflow: workflow(replacement),
        policy: { ...actionPolicy, mode: 'report', ledger },
      })
      expect.fail('Expected an action replacement to require a new ledger entry')
    } catch (error) {
      if (!(error instanceof WorkflowPolicyError)) throw error
      expect(error.issues.map((issue) => issue.kind)).toEqual(['NEW', 'STALE'])
    }
  })

  it.each([
    { label: 'name', identity: { name: 'Upload artifact' } },
    { label: 'ID', identity: { id: 'upload', name: 'Upload artifact' } },
  ])('distinguishes same-action input content under a shared $label', ({ identity }) => {
    const steps: Step[] = [
      { ...identity, uses: 'actions/upload-artifact@v4', with: { name: 'logs' } },
      { ...identity, uses: 'actions/upload-artifact@v4', with: { name: 'results' } },
    ]
    const ledger = collect(steps)
    expect(ledger).toHaveLength(2)
    expect(ledger[0]?.path).not.toBe(ledger[1]?.path)
    expect(collect(steps.slice(1))).toEqual(ledger.slice(1))
    expect(reportIssues(steps.slice(1), ledger).map((issue) => issue.kind)).toEqual(['STALE'])
    expect(reportIssues(steps.slice(1), ledger.slice(0, 1)).map((issue) => issue.kind)).toEqual([
      'NEW',
      'STALE',
    ])
  })

  it('canonicalizes input ordering while preserving input keys and value types', () => {
    const identity = (withInputs: Record<string, string | number | boolean>) =>
      workflowPolicyStepIdentity({
        step: { name: 'Upload', uses: 'actions/upload-artifact/path@v4', with: withInputs },
        ordinals: new Map(),
      })
    expect(identity({ name: 'logs', retention: 1 })).toBe(identity({ retention: 1, name: 'logs' }))
    expect(identity({ name: 'logs' })).not.toBe(identity({ path: 'logs' }))
    expect(identity({ retention: 1 })).not.toBe(identity({ retention: '1' }))
    expect(identity({ enabled: true })).not.toBe(identity({ enabled: 'true' }))
    expect(identity({})).toContain('action:"actions/upload-artifact/path"')
  })

  it('distinguishes run content under shared IDs and names and numbers only equivalents', () => {
    for (const label of [{ name: 'Execute' }, { id: 'execute', name: 'Execute' }]) {
      const ordinals = new Map<string, number>()
      const first = workflowPolicyStepIdentity({
        step: { ...label, run: 'echo first' },
        ordinals,
      })
      const second = workflowPolicyStepIdentity({
        step: { ...label, run: 'echo second' },
        ordinals,
      })
      expect(second).not.toBe(first)
      expect(second).not.toMatch(/#2$/)
      expect(workflowPolicyStepIdentity({ step: { ...label, run: 'echo first' }, ordinals })).toBe(
        `${first}#2`,
      )
    }
  })

  it('preserves action subpaths in identified provenance while ignoring ref changes', () => {
    const identity = (uses: string) =>
      workflowPolicyStepIdentity({
        step: { id: 'setup', name: 'Setup', uses },
        ordinals: new Map(),
      })
    expect(identity('example/actions/setup@v1')).toBe(identity('example/actions/setup@v2'))
    expect(identity('example/actions/setup@v1')).not.toBe(identity('example/actions/other@v1'))
  })

  it('canonicalizes environment order but distinguishes other execution content', () => {
    const identity = (step: Step) => workflowPolicyStepIdentity({ step, ordinals: new Map() })
    const step: Step = { name: 'Execute', run: 'echo ok', env: { A: '1', B: '2' } }
    expect(identity(step)).toBe(
      identity({ name: 'Execute', run: 'echo ok', env: { B: '2', A: '1' } }),
    )
    expect(identity(step)).not.toBe(identity({ ...step, env: { A: '2', B: '2' } }))
    expect(identity(step)).not.toBe(identity({ ...step, if: 'always()' }))
    expect(identity({ run: 'echo ok', shell: 'bash' })).not.toBe(
      identity({ run: 'echo ok', shell: 'sh' }),
    )
  })
})
