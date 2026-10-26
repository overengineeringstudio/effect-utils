import { describe, expect, it } from 'vitest'

import { githubWorkflow, type GitHubWorkflowArgs } from './mod.ts'
import {
  collectWorkflowPolicyViolations,
  decodeWorkflowPolicyLedger,
  sameRepoPullRequestGuard,
  validateWorkflowPolicy,
  WorkflowPolicyError,
  type WorkflowPolicy,
  type WorkflowPolicyException,
  type WorkflowPolicyRule,
} from './policy.ts'

const policy: WorkflowPolicy = {
  repository: 'example/project',
  workflow: 'ci.yml',
  admittedRunnerLabels: ['self-hosted', 'linux', 'pool-small', 'pool-heavy'],
  exclusiveRunnerLabels: ['pool-heavy'],
  bannedActions: ['actions/cache', 'vendor/forbidden'],
  setupActionCaches: [
    { action: 'actions/setup-node', input: 'cache', defaultEnabled: false },
    { action: 'actions/setup-python', input: 'cache', defaultEnabled: false },
    { action: 'actions/setup-go', input: 'cache', defaultEnabled: true },
  ],
}
const workflow = (runner: string | string[] = 'pool-small'): GitHubWorkflowArgs => ({
  on: 'push',
  jobs: { test: { 'runs-on': runner, steps: [{ run: 'echo ok' }] } },
})
const stepWorkflow = (
  uses: string,
  inputs?: Record<string, string | boolean>,
): GitHubWorkflowArgs => ({
  ...workflow(),
  jobs: {
    test: {
      'runs-on': 'pool-small',
      steps: [{ uses, ...(inputs === undefined ? {} : { with: inputs }) }],
    },
  },
})
const collect = (input: GitHubWorkflowArgs, config: WorkflowPolicy = policy) =>
  collectWorkflowPolicyViolations({ workflow: input, policy: config })
const exception: WorkflowPolicyException = {
  repository: policy.repository,
  workflow: policy.workflow,
  job: 'test',
  rule: 'runner-not-admitted',
  owner: 'team-owner',
  approver: 'team-reviewer',
  justification: 'Temporary migration',
  expiry: '9999-12-31',
  trackingIssue: 'https://github.com/example/project/issues/1',
}
const issueKinds = (input: GitHubWorkflowArgs, config: WorkflowPolicy) => {
  try {
    validateWorkflowPolicy({ workflow: input, policy: config })
    return []
  } catch (error) {
    if (error instanceof WorkflowPolicyError) return error.issues.map((issue) => issue.kind)
    throw error
  }
}

describe('workflow policy runner admission', () => {
  it.each([
    ['ubuntu-24.04', 'hosted-runner'],
    ['macos-15', 'hosted-runner'],
    ['windows-2025', 'hosted-runner'],
    ['custom-latest', 'hosted-runner'],
    ['namespace-profile-small', 'namespace-runner'],
    ['nscloud-linux', 'namespace-runner'],
    ['namespace-features:docker', 'namespace-runner'],
    ['unknown', 'runner-not-admitted'],
    ['${{ inputs.runner }}', 'dynamic-runner'],
    ["${{ inputs.runner || 'pool-small' }}", 'runner-fallback'],
    ["${{ inputs.runner || 'ubuntu-latest' }}", 'hosted-runner'],
    ["${{ inputs.runner || 'nscloud-linux' }}", 'namespace-runner'],
  ])('rejects %s with %s', (runner, rule) => {
    expect(collect(workflow(runner)).map((violation) => violation.rule)).toContain(rule)
  })

  it('admits every nonempty combination of ordinary admitted labels (finite property)', () => {
    const labels = ['self-hosted', 'linux', 'pool-small']
    for (let mask = 1; mask < 1 << labels.length; mask++) {
      const selection = labels.filter((_, index) => (mask & (1 << index)) !== 0)
      expect(collect(workflow(selection))).toEqual([])
    }
  })

  it('rejects every ordinary label mixed with an exclusive label (finite property)', () => {
    for (const label of policy.admittedRunnerLabels.filter((label) => label !== 'pool-heavy')) {
      for (const selection of [
        [label, 'pool-heavy'],
        ['pool-heavy', label],
      ]) {
        expect(collect(workflow(selection)).map((violation) => violation.rule)).toContain(
          'runner-label-mix',
        )
      }
    }
    expect(collect(workflow('pool-heavy'))).toEqual([])
  })

  it('resolves finite matrix axes, nested objects, includes and excludes', () => {
    const input = workflow('${{ matrix.target.runner }}')
    input.jobs.test!.strategy = {
      matrix: {
        target: [{ runner: 'pool-small' }, { runner: 'ubuntu-latest' }],
        exclude: [{ target: { runner: 'ubuntu-latest' } }],
        include: [{ target: { runner: 'pool-heavy' } }],
      },
    }
    expect(collect(input)).toEqual([])
    input.jobs.test!.strategy = { matrix: { include: [{ target: { runner: 'ubuntu-latest' } }] } }
    expect(collect(input).map((violation) => violation.rule)).toContain('hosted-runner')
  })

  it('resolves matrix lists without mixing labels from independent jobs', () => {
    const input = workflow('${{ matrix.runner }}')
    input.jobs.test!.strategy = { matrix: { runner: ['pool-heavy', 'pool-small'] } }
    expect(collect(input)).toEqual([])
    input.jobs.test!.strategy = { matrix: { runner: [['pool-heavy', 'linux']] } }
    expect(collect(input).map((violation) => violation.rule)).toContain('runner-label-mix')
    input.jobs.test!['runs-on'] = ['${{ matrix.runner }}', 'linux']
    input.jobs.test!.strategy = { matrix: { runner: ['pool-heavy'] } }
    expect(collect(input).map((violation) => violation.rule)).toContain('runner-label-mix')
  })

  it.each([
    '${{ fromJSON(inputs.matrix) }}',
    { unrelated: ['pool-small'] },
    { runner: [] },
  ] satisfies NonNullable<GitHubWorkflowArgs['jobs'][string]['strategy']>['matrix'][])(
    'fails closed for unresolved matrix %j',
    (matrix) => {
      const input = workflow('${{ matrix.runner }}')
      input.jobs.test!.strategy = { matrix }
      expect(collect(input).map((violation) => violation.rule)).toContain('dynamic-runner')
    },
  )

  it('admits only exact typed output contracts and checks every declared label', () => {
    const expression = '${{ needs.plan.outputs.runner }}'
    const config = { ...policy, admittedRunnerOutputs: [{ expression, labels: ['pool-small'] }] }
    expect(collect(workflow(expression), config)).toEqual([])
    expect(
      collect(workflow('${{ needs.other.outputs.runner }}'), config).map((entry) => entry.rule),
    ).toContain('dynamic-runner')
    expect(
      collect(workflow(expression), {
        ...config,
        admittedRunnerOutputs: [{ expression, labels: ['ubuntu-latest'] }],
      }).map((entry) => entry.rule),
    ).toContain('hosted-runner')
    expect(
      collect(workflow('${{ inputs.runner }}'), {
        ...config,
        admittedRunnerOutputs: [{ expression: '${{ inputs.runner }}', labels: ['pool-small'] }],
      }).map((entry) => entry.rule),
    ).toContain('dynamic-runner')
  })
  it('rejects typed exclusive outputs mixed with literal capability labels', () => {
    const expression = '${{ needs.plan.outputs.runner }}'
    const config = { ...policy, admittedRunnerOutputs: [{ expression, labels: ['pool-heavy'] }] }
    expect(collect(workflow([expression, 'linux']), config).map((entry) => entry.rule)).toContain(
      'runner-label-mix',
    )
    expect(collect(workflow(expression), config)).toEqual([])
  })
})

describe('workflow policy triggers and actions', () => {
  it('rejects pull_request_target in every trigger form', () => {
    const triggers: GitHubWorkflowArgs['on'][] = [
      'pull_request_target',
      ['push', 'pull_request_target'],
      { pull_request_target: null },
    ]
    for (const on of triggers)
      expect(collect({ ...workflow(), on }).map((entry) => entry.rule)).toContain(
        'pull-request-target',
      )
  })
  it.each(['v4', 'main', '0123456789abcdef0123456789abcdef01234567'])(
    'bans action repositories and all subpaths at ref %s',
    (ref) => {
      for (const action of [
        'actions/cache',
        'actions/cache/restore',
        'actions/cache/save',
        'vendor/forbidden/subpath',
      ]) {
        expect(collect(stepWorkflow(`${action}@${ref}`)).map((entry) => entry.rule)).toContain(
          'banned-action',
        )
      }
      expect(collect(stepWorkflow(`actions/cache-other@${ref}`))).toEqual([])
    },
  )
  it.each([false, 'false', '', ' FALSE '])(
    'allows explicitly disabled caches %j including default-enabled actions',
    (cache) => {
      for (const action of ['actions/setup-node', 'actions/setup-python', 'actions/setup-go'])
        expect(collect(stepWorkflow(`${action}@v5`, { cache }))).toEqual([])
    },
  )
  it.each([true, 'pip', 'npm', '${{ inputs.cache }}'])(
    'rejects enabled setup caches %j',
    (cache) => {
      expect(
        collect(stepWorkflow('actions/setup-node@v5', { cache })).map((entry) => entry.rule),
      ).toContain('setup-action-cache')
    },
  )
  it('uses configurable omitted-input defaults', () => {
    expect(collect(stepWorkflow('actions/setup-node@v5'))).toEqual([])
    expect(collect(stepWorkflow('actions/setup-python@v6'))).toEqual([])
    expect(collect(stepWorkflow('actions/setup-go@v6')).map((entry) => entry.rule)).toContain(
      'setup-action-cache',
    )
  })
  it.each(['cache-from', 'cache-to'])('rejects buildx gha in %s', (input) => {
    for (const value of [
      'type=gha',
      'type=gha,mode=max',
      'type=local,src=/tmp\ntype=gha,scope=test',
    ]) {
      expect(
        collect(stepWorkflow('docker/build-push-action@v6', { [input]: value })).map(
          (entry) => entry.rule,
        ),
      ).toContain('docker-gha-cache')
    }
    expect(
      collect(
        stepWorkflow('docker/build-push-action@v6', { [input]: 'type=registry,ref=example/cache' }),
      ),
    ).toEqual([])
  })
})

describe('exceptions and exact report ledger', () => {
  it('applies only a complete exact exception, without hiding raw observations', () => {
    const input = workflow('temporary-runner')
    expect(collect(input)).toHaveLength(1)
    expect(issueKinds(input, { ...policy, exceptions: [exception] })).toEqual([])
    expect(issueKinds(input, { ...policy, exceptions: [{ ...exception, job: '*' }] })).toContain(
      'INVALID_EXCEPTION',
    )
  })
  it.each([
    { repository: 'other/repository' },
    { workflow: 'other.yml' },
    { owner: '' },
    { approver: '' },
    { justification: '' },
    { trackingIssue: '' },
    { expiry: '2000-01-01' },
    { expiry: '9999-02-30' },
    { expiry: 'invalid' },
  ])('rejects invalid exception %j even on a clean workflow', (change) => {
    expect(
      issueKinds(workflow(), { ...policy, exceptions: [{ ...exception, ...change }] }),
    ).toContain('INVALID_EXCEPTION')
  })
  it.each([
    'hosted-runner',
    'namespace-runner',
    'banned-action',
    'setup-action-cache',
    'docker-gha-cache',
    'runner-fallback',
    'runner-label-mix',
  ] satisfies WorkflowPolicyRule[])('never excepts %s', (rule) => {
    expect(issueKinds(workflow(), { ...policy, exceptions: [{ ...exception, rule }] })).toContain(
      'INVALID_EXCEPTION',
    )
  })
  it('rejects an otherwise complete workflow-scoped pull_request_target exception', () => {
    expect(
      issueKinds(
        { ...workflow(), on: 'pull_request_target' },
        {
          ...policy,
          exceptions: [{ ...exception, job: '*', rule: 'pull-request-target' }],
        },
      ),
    ).toContain('INVALID_EXCEPTION')
  })
  it('rejects duplicate exceptions and caller-added never-exceptable rules', () => {
    expect(issueKinds(workflow(), { ...policy, exceptions: [exception, exception] })).toContain(
      'INVALID_EXCEPTION',
    )
    expect(
      issueKinds(workflow(), {
        ...policy,
        neverExceptableRules: ['runner-not-admitted'],
        exceptions: [exception],
      }),
    ).toContain('INVALID_EXCEPTION')
  })
  it('requires exact ledger equality: NEW, STALE, matching, changed value', () => {
    const input = workflow('legacy-runner')
    const ledger = collect(input)
    expect(issueKinds(input, { ...policy, mode: 'report', ledger: [] })).toEqual(['NEW'])
    expect(issueKinds(workflow(), { ...policy, mode: 'report', ledger })).toEqual(['STALE'])
    expect(issueKinds(input, { ...policy, mode: 'report', ledger })).toEqual([])
    expect(issueKinds(workflow('different-runner'), { ...policy, mode: 'report', ledger })).toEqual(
      ['NEW', 'STALE'],
    )
  })
  it('decodes ledger JSON and rejects invalid rule and field types', () => {
    const ledger = collect(workflow('unknown'))
    expect(decodeWorkflowPolicyLedger(JSON.parse(JSON.stringify(ledger)))).toEqual(ledger)
    for (const value of [
      {},
      [null],
      [{ ...ledger[0], rule: 'unknown' }],
      [{ ...ledger[0], value: 1 }],
    ])
      expect(() => decodeWorkflowPolicyLedger(value)).toThrow(WorkflowPolicyError)
  })
})

describe('githubWorkflow policy lifecycle', () => {
  it('fails at construction', () => {
    expect(() => githubWorkflow({ ...workflow('unknown'), policy })).toThrow(WorkflowPolicyError)
  })
  it('omits metadata and revalidates at stringify and validate', () => {
    const input = workflow()
    const output = githubWorkflow({ ...input, actionlint: false, policy })
    const ctx = { location: '.github/workflows/ci.yml', cwd: '/workspace' }
    const yaml = output.stringify(ctx)
    expect(yaml).not.toContain('policy:')
    expect(yaml).not.toContain('example/project')
    expect(yaml).not.toContain('actionlint:')
    input.jobs.test!['runs-on'] = 'unknown'
    expect(() => output.stringify(ctx)).toThrow(WorkflowPolicyError)
    expect(() => output.validate?.(ctx)).toThrow(WorkflowPolicyError)
  })
})

describe('fleet fork-code admission', () => {
  const guardedPolicy: WorkflowPolicy = {
    ...policy,
    sameRepoGuardRunnerLabels: ['pool-small', 'pool-heavy'],
  }
  const guard = sameRepoPullRequestGuard()
  const prWorkflow = (): GitHubWorkflowArgs => ({ ...workflow(), on: 'pull_request' })

  it.each(['pull_request', 'pull_request_review', 'pull_request_review_comment', 'workflow_run'] as const)(
    'requires canonical same-repository ownership for %s',
    (event) => {
      const input = { ...workflow(), on: event }
      expect(collect(input, guardedPolicy).map((entry) => entry.rule)).toContain('fleet-pr-without-same-repo-guard')
      expect(() => validateWorkflowPolicy({ workflow: input, policy: guardedPolicy })).toThrow(WorkflowPolicyError)
      input.jobs.test!.if = guard
      expect(() => validateWorkflowPolicy({ workflow: input, policy: guardedPolicy })).not.toThrow()
    },
  )
  it.each([
    guard,
    `\${{ ${guard} }}`,
    `(${guard}) && (github.ref == 'refs/heads/main')`,
    `(github.ref == 'refs/heads/main') && (${guard})`,
    `\${{ ((${guard})) && (contains('a && b || c', 'b')) }}`,
  ])('accepts only the full guard or a top-level conjunction: %s', (condition) => {
    const input = prWorkflow()
    input.jobs.test!.if = condition
    expect(collect(input, guardedPolicy)).toEqual([])
  })
  it.each([
    `(${guard}) || true`,
    `true || (${guard})`,
    `!(${guard})`,
    `(${guard}) && false || true`,
    `!((${guard}) && false)`,
    "github.event.pull_request.head.repo.full_name == github.repository",
    "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
  ])('rejects disjunction, negation and partial guard matches: %s', (condition) => {
    const input = prWorkflow()
    input.jobs.test!.if = condition
    expect(collect(input, guardedPolicy).map((entry) => entry.rule)).toContain('fleet-pr-without-same-repo-guard')
  })
  it('protects finite matrices and typed admitted outputs', () => {
    const matrix = prWorkflow()
    matrix.jobs.test!['runs-on'] = '${{ matrix.runner }}'
    matrix.jobs.test!.strategy = { matrix: { runner: ['linux', 'pool-small'] } }
    expect(collect(matrix, guardedPolicy).map((entry) => entry.rule)).toContain('fleet-pr-without-same-repo-guard')
    const output = prWorkflow()
    output.jobs.test!['runs-on'] = '${{ needs.select.outputs.runner }}'
    const outputPolicy = {
      ...guardedPolicy,
      admittedRunnerOutputs: [{ expression: '${{ needs.select.outputs.runner }}', labels: ['pool-small'] }],
    }
    expect(collect(output, outputPolicy).map((entry) => entry.rule)).toContain('fleet-pr-without-same-repo-guard')
    output.jobs.test!.if = guard
    expect(collect(output, outputPolicy)).toEqual([])
  })
  it('does not require a guard on non-fleet jobs or push-only workflows', () => {
    expect(collect({ ...workflow('linux'), on: 'pull_request' }, guardedPolicy)).toEqual([])
    expect(collect(workflow(), guardedPolicy)).toEqual([])
  })
  it('uses an event-specific guard that preserves push and merge_group in mixed workflows', () => {
    expect(guard).toBe("((github.event_name != 'pull_request' && github.event_name != 'pull_request_review' && github.event_name != 'pull_request_review_comment') || github.event.pull_request.head.repo.full_name == github.repository) && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.full_name == github.repository) && github.event_name != 'issue_comment'")
    const mixed = { ...workflow(), on: ['push', 'merge_group', 'pull_request', 'workflow_run'] as const }
    mixed.jobs.test!.if = guard
    expect(collect(mixed, guardedPolicy)).toEqual([])
  })
  it('rejects issue_comment fleet jobs even with a guard because their payload cannot attest head ownership', () => {
    const input = { ...workflow(), on: 'issue_comment' as const }
    input.jobs.test!.if = guard
    expect(collect(input, guardedPolicy).map((entry) => entry.rule)).toContain('fleet-pr-without-same-repo-guard')
  })
  it('cannot admit fork-code exposure through either a report ledger or an exception', () => {
    const input = prWorkflow()
    const ledger = collect(input, guardedPolicy)
    expect(issueKinds(input, { ...guardedPolicy, mode: 'report', ledger })).toContain('VIOLATION')
    expect(issueKinds(input, {
      ...guardedPolicy,
      exceptions: [{ ...exception, rule: 'fleet-pr-without-same-repo-guard' }],
    })).toContain('INVALID_EXCEPTION')
  })
  it('cannot admit pull_request_target through a report ledger', () => {
    const input = { ...workflow(), on: 'pull_request_target' as const }
    expect(issueKinds(input, { ...guardedPolicy, mode: 'report', ledger: collect(input, guardedPolicy) })).toContain('VIOLATION')
  })
})
