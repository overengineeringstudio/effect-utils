import { describe, expect, it } from 'vitest'

import repoSettings from '../../.github/repo-settings.json' with { type: 'json' }
import { isFleetCacheRunner } from '../../packages/@overeng/genie/src/runtime/github-workflow/cache-policy.ts'
import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/github-workflow/mod.ts'
import {
  collectWorkflowPolicyViolations,
  decodeWorkflowPolicyLedger,
  sameRepoPullRequestGuard,
  validateWorkflowPolicy,
  type WorkflowPolicyException,
  type WorkflowPolicyRule,
} from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'
import { autoReviewWorkflow } from '../auto-review.ts'
import { defaultRefPolicyCheckJob } from '../ci-workflow.ts'
import { requiredCIJobs } from '../ci.ts'
import { withBuck2CacheEvidence } from './buck2-cache-evidence.ts'
import { withBuck2CachePostures } from './buck2-cache-posture.ts'
import {
  netlifyPreviewBuildSteps,
  netlifyPreviewDeployJobs,
  netlifyPreviewDeployTrigger,
  notifyAlignmentJob,
  vercelDeployJobs,
} from './deploy.ts'
import { devenvPerfJob, nixClosureMeasurementsJob } from './measurements.ts'
import { restoreMegarepoStoreStep, saveMegarepoStoreStep } from './megarepo.ts'
import {
  mergeQueueAdmittedJob,
  mergeQueueAdmissionGateJob,
  mergeQueueSemanticGateJob,
  mergeQueueSemanticGateJobs,
} from './merge-queue.ts'
import { pipelineCloseJob, withPipelineTelemetry } from './pipeline-telemetry.ts'
import {
  collectFleetPolicyMigrationLedger,
  consumerMigrationLedger,
  consumerMigrationPolicy,
  fleetWorkflowPolicy,
  validateFleetPolicyExceptionRegistry,
} from './policy.ts'
import { prReviewsResolvedJob, prReviewsResolvedJobId } from './pr-reviews.ts'
import { prSnapshotPackJob, prSnapshotReleaseJobs } from './pr-snapshot.ts'
import { releaseWorkflow } from './release.ts'
import { linuxX64HeavyRunner, linuxX64Runner } from './runners.ts'
import {
  cargoClippyJob,
  cargoFmtJob,
  cargoNextestJob,
  plainFlakeGenieCheckJob,
  plainFlakeJob,
} from './rust.ts'
import {
  ciDiagnosticsSetupStep,
  ciOtelSpansArtifactStep,
  nixDiagnosticsArtifactStep,
  pnpmInstallWithDiagnosticsStep,
  pnpmStateSetupStep,
  restoreNixCacheStep,
  saveNixCacheStep,
  standardSelfHostedDevenvTaskJob,
  standardSelfHostedPnpmCiPostSteps,
  standardSelfHostedPnpmCiPrepSteps,
} from './setup.ts'
import { ciWorkflow, withNixRealisationTimeouts } from './shared.ts'

const policy = fleetWorkflowPolicy({
  repository: 'overengineeringstudio/effect-utils',
  workflow: 'shared-helper-fixture.yml',
  mode: 'enforce',
})
const step = { run: 'devenv tasks run check:quick' }
const job: GitHubWorkflowArgs['jobs'][string] = {
  'runs-on': [...linuxX64Runner],
  steps: [{ uses: 'actions/checkout@v6' }, step],
}
const jobs = { check: job }
const rustOptions = { runsOn: [...linuxX64Runner], namespacePrivilege: 'never' as const }
const snapshotRelease = prSnapshotReleaseJobs({
  topologyPath: 'release/topology.json',
  attestationPredicateType: 'https://example.com/pr-snapshot/v1',
  runsOn: [...linuxX64Runner],
})

// Raw jobs acquire their PR-origin guard when the consumer composes a workflow.
const guardedFixtureJobs = (rawJobs: Record<string, Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(rawJobs).map(([id, value]) => {
      const condition =
        typeof value.if === 'string'
          ? value.if
              .trim()
              .replace(/^\$\{\{\s*/, '')
              .replace(/\s*\}\}$/, '')
          : undefined
      return [
        id,
        {
          ...value,
          if:
            condition === undefined
              ? sameRepoPullRequestGuard()
              : `(${sameRepoPullRequestGuard()}) && (${condition})`,
        },
      ]
    }),
  )

// Keep each producer separate: a new storage action cannot hide behind another helper's L7 debt.
const helperWorkflows = {
  defaultRefPolicyCheckJob: { jobs: { check: defaultRefPolicyCheckJob() } },
  standardSelfHostedDevenvTaskJob: { jobs: { check: standardSelfHostedDevenvTaskJob({ step }) } },
  prReviewsResolvedJob: {
    jobs: { [prReviewsResolvedJobId]: prReviewsResolvedJob({ runsOn: linuxX64Runner }) },
  },
  prSnapshotPackJob: {
    jobs: prSnapshotPackJob({
      topologyPath: 'release/topology.json',
      setupStepsAfterCheckout: [],
      packTask: 'release:pack',
      runsOn: [...linuxX64Runner],
    }),
  },
  prSnapshotReleaseJobs: {
    jobs: guardedFixtureJobs(snapshotRelease.jobs),
    on: {
      workflow_dispatch: { inputs: snapshotRelease.dispatchInputs },
      schedule: snapshotRelease.scheduleTrigger,
      workflow_run: snapshotRelease.workflowRunTrigger,
    },
  },
  releaseWorkflow: releaseWorkflow({
    workspaceName: 'example',
    releasePlanPaths: ['release/**'],
    releaseChannels: { latest: { manualGate: true } },
    setupSteps: [],
    validateSteps: [step],
    publishSteps: [step],
    runsOn: {
      createReleasePr: [...linuxX64Runner],
      validateReleasePlan: [...linuxX64Runner],
      publishRelease: [...linuxX64Runner],
    },
  }).data,
  notifyAlignmentJob: {
    jobs: { notify: notifyAlignmentJob({ targetRepo: 'example/workspace', needs: [] }) },
  },
  vercelDeployJobs: {
    jobs: vercelDeployJobs({
      projects: [{ name: 'docs', projectIdEnv: 'VERCEL_PROJECT_ID' }],
      runner: linuxX64Runner,
      baseSteps: [],
      env: {},
    }),
  },
  netlifyPreviewDeployJobs: {
    on: netlifyPreviewDeployTrigger('Build'),
    jobs: guardedFixtureJobs(
      netlifyPreviewDeployJobs({
        runsOn: {
          resolvePreview: linuxX64Runner,
          deployPreview: linuxX64Runner,
          publishPreviewComment: linuxX64Runner,
        },
        setupSteps: [],
        netlifyAuthToken: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
        title: 'Preview',
        noRecordsMessage: 'No previews',
        stateId: 'preview',
      }),
    ),
  },
  pipelineCloseJob: { jobs: { close: pipelineCloseJob({ jobs, runsOn: [...linuxX64Runner] }) } },
  withPipelineTelemetry: { jobs: withPipelineTelemetry(jobs) },
  withBuck2CacheEvidence: { jobs: withBuck2CacheEvidence(jobs) },
  withBuck2CachePostures: { jobs: withBuck2CachePostures({ jobs, postures: { check: 'reader' } }) },
  withNixRealisationTimeouts: { jobs: withNixRealisationTimeouts(jobs, {}) },
  ciWorkflow: ciWorkflow({ on: 'push', jobs, trustTier: 'public' }).data,
  mergeQueueAdmittedJob: {
    jobs: { check: mergeQueueAdmittedJob({ runsOn: linuxX64Runner, steps: [step] }) },
  },
  mergeQueueAdmissionGateJob: {
    jobs: { check: mergeQueueAdmissionGateJob({ runsOn: linuxX64Runner }) },
  },
  mergeQueueSemanticGateJob: {
    jobs: {
      check: mergeQueueSemanticGateJob({ name: 'quality', needs: [], runsOn: linuxX64Runner }),
    },
  },
  mergeQueueSemanticGateJobs: {
    jobs: mergeQueueSemanticGateJobs([
      { id: 'quality', name: 'quality', needs: [], runsOn: linuxX64Runner },
    ]),
  },
  plainFlakeJob: { jobs: { check: plainFlakeJob({ ...rustOptions, step }) } },
  cargoFmtJob: { jobs: { check: cargoFmtJob(rustOptions) } },
  cargoClippyJob: { jobs: { check: cargoClippyJob(rustOptions) } },
  cargoNextestJob: { jobs: { check: cargoNextestJob(rustOptions) } },
  plainFlakeGenieCheckJob: { jobs: { check: plainFlakeGenieCheckJob(rustOptions) } },
  devenvPerfJob: { jobs: { check: devenvPerfJob() } },
  nixClosureMeasurementsJob: {
    jobs: {
      check: nixClosureMeasurementsJob({
        artifactName: 'closure-measurements',
        targets: [
          {
            installable: '.#example',
            id: 'example',
            label: 'Example',
            group: 'build',
            description: 'Example closure',
          },
        ],
      }),
    },
  },
  standardSelfHostedPnpmCiPrepSteps: {
    jobs: { check: { ...job, steps: standardSelfHostedPnpmCiPrepSteps() } },
  },
  standardSelfHostedPnpmCiPostSteps: {
    jobs: { check: { ...job, steps: standardSelfHostedPnpmCiPostSteps() } },
  },
  restoreNixCacheStep: { jobs: { check: { ...job, steps: [restoreNixCacheStep()] } } },
  saveNixCacheStep: { jobs: { check: { ...job, steps: [saveNixCacheStep()] } } },
  restoreMegarepoStoreStep: { jobs: { check: { ...job, steps: [restoreMegarepoStoreStep()] } } },
  saveMegarepoStoreStep: { jobs: { check: { ...job, steps: [saveMegarepoStoreStep()] } } },
  netlifyPreviewBuildSteps: { jobs: { check: { ...job, steps: netlifyPreviewBuildSteps() } } },
  ciOtelSpansArtifactStep: { jobs: { check: { ...job, steps: [ciOtelSpansArtifactStep] } } },
  nixDiagnosticsArtifactStep: {
    jobs: { check: { ...job, steps: [nixDiagnosticsArtifactStep()] } },
  },
}

// TODO(L7): migrate these helpers' artifact/cache transport, then remove each entry.
const pendingStorageMigration: readonly (keyof typeof helperWorkflows)[] = [
  'standardSelfHostedDevenvTaskJob',
  'prSnapshotPackJob',
  'prSnapshotReleaseJobs',
  'netlifyPreviewDeployJobs',
  'withBuck2CacheEvidence',
  'devenvPerfJob',
  'nixClosureMeasurementsJob',
  'standardSelfHostedPnpmCiPrepSteps',
  'standardSelfHostedPnpmCiPostSteps',
  'restoreNixCacheStep',
  'saveNixCacheStep',
  'restoreMegarepoStoreStep',
  'saveMegarepoStoreStep',
  'netlifyPreviewBuildSteps',
  'ciOtelSpansArtifactStep',
  'nixDiagnosticsArtifactStep',
]
const storageRules: Partial<Record<WorkflowPolicyRule, true>> = {
  'banned-action': true,
  'setup-action-cache': true,
  'docker-gha-cache': true,
}

describe('megarepo store cache save guard', () => {
  it('requires success and a cache miss while excluding fork PRs without excluding pushes', () => {
    expect(saveMegarepoStoreStep().if).toBe(
      "${{ success() && steps.restore-megarepo-store.outputs.cache-hit != 'true' && github.event.pull_request.head.repo.fork != true }}",
    )
    expect(restoreMegarepoStoreStep()).not.toHaveProperty('if')
  })
})

// Some deploy helpers expose loose records and step helpers return readonly arrays;
// the fixture boundary only adapts those declarations, without changing emitted values.
const fixtureWorkflow = (fixture: { jobs: object; on?: unknown }): GitHubWorkflowArgs =>
  ({ on: 'push', ...fixture }) as GitHubWorkflowArgs

const expectedRequiredChecks = [
  'default-ref-policy',
  'pr/quality',
  'test (namespace-profile-linux-x86-64)',
  'test (namespace-profile-macos-arm64)',
  'test-playwright-utils',
  'test-playwright-tui-react',
  'test-megarepo-store-gc',
  'cargo',
  'weaver',
  'source-shape',
  'test-integration-restate',
  'build-products',
  'pr-reviews-resolved',
  'test-storybook-plays',
]

describe('shared helper fleet policy', () => {
  for (const [helper, fixture] of Object.entries(helperWorkflows)) {
    it(`${helper} admits only fleet runners and safe events`, () => {
      const violations = collectWorkflowPolicyViolations({
        workflow: fixtureWorkflow(fixture),
        policy,
      })
      const pending = pendingStorageMigration.some((name) => name === helper)
      expect(
        violations.filter(
          (violation) => pending === false || storageRules[violation.rule] !== true,
        ),
      ).toEqual([])
      if (pending === true) {
        expect(violations.some((violation) => storageRules[violation.rule] === true)).toBe(true)
      }
    })
  }

  it('preserves the literal required check contexts in CI and repository settings', () => {
    expect(requiredCIJobs).toEqual(expectedRequiredChecks)
    const requiredChecks = repoSettings.rules.flatMap((rule) =>
      rule.type === 'required_status_checks'
        ? (rule.parameters?.required_status_checks?.map((check) => check.context) ?? [])
        : [],
    )
    expect(requiredChecks).toEqual(expectedRequiredChecks)
  })

  it('admits the isolated heavy fleet runner for execution and private caches', () => {
    expect(isFleetCacheRunner(linuxX64HeavyRunner)).toBe(true)
    const workflow = fixtureWorkflow({
      jobs: { heavy: { ...job, 'runs-on': linuxX64HeavyRunner } },
    })
    expect(collectWorkflowPolicyViolations({ workflow, policy })).toEqual([])
  })

  it('rejects mixing the dedicated heavy scale set with generic selectors', () => {
    const workflow = fixtureWorkflow({
      jobs: { heavy: { ...job, 'runs-on': [...linuxX64HeavyRunner, 'nix'] } },
    })
    expect(
      collectWorkflowPolicyViolations({ workflow, policy }).map((violation) => violation.rule),
    ).toContain('runner-label-mix')
  })

  it('rejects a runner fallback even when its literal branch is a fleet label', () => {
    const workflow = fixtureWorkflow({
      jobs: { check: { ...job, 'runs-on': "${{ inputs.runner || 'sh-linux-x64' }}" } },
    })
    expect(
      collectWorkflowPolicyViolations({ workflow, policy }).map((violation) => violation.rule),
    ).toContain('runner-fallback')
  })
})

describe('shared workflow same-repository PR guards', () => {
  const guard = sameRepoPullRequestGuard()
  const rule = 'fleet-pr-without-same-repo-guard'

  it('requires a same-repository guard for every admitted fleet selector', () => {
    expect(policy.sameRepoGuardRunnerLabels).toEqual(policy.admittedRunnerLabels)
  })

  it('rejects an unguarded public PR workflow using only the nix selector', () => {
    const workflow = fixtureWorkflow({
      on: 'pull_request',
      jobs: { check: { ...job, 'runs-on': 'nix' } },
    })
    expect(
      collectWorkflowPolicyViolations({ workflow, policy }).map((violation) => violation.rule),
    ).toEqual([rule])
    expect(() => validateWorkflowPolicy({ workflow, policy })).toThrow(rule)
  })

  it('admits a guarded public PR workflow using only the nix selector', () => {
    const workflow = fixtureWorkflow({
      on: 'pull_request',
      jobs: { check: { ...job, 'runs-on': 'nix', if: guard } },
    })
    expect(collectWorkflowPolicyViolations({ workflow, policy })).toEqual([])
    expect(() => validateWorkflowPolicy({ workflow, policy })).not.toThrow()
  })

  it('cannot ledger-admit an unguarded public PR workflow using only the nix selector', () => {
    const workflow = fixtureWorkflow({
      on: 'pull_request',
      jobs: { check: { ...job, 'runs-on': 'nix' } },
    })
    const ledger = collectWorkflowPolicyViolations({ workflow, policy })
    expect(ledger.map((violation) => violation.rule)).toEqual([rule])
    const reportPolicy = fleetWorkflowPolicy({
      repository: policy.repository,
      workflow: policy.workflow,
      mode: 'report',
      ledger,
    })
    expect(() => validateWorkflowPolicy({ workflow, policy: reportPolicy })).toThrow(rule)
  })

  it('rejects the public PR fleet composer repro instead of injecting a guard', () => {
    expect(() =>
      ciWorkflow({
        on: 'pull_request',
        trustTier: 'public',
        jobs: {
          check: {
            'runs-on': ['sh-linux-x64', 'nix'],
            steps: [{ run: 'echo repro' }],
          },
        },
      }),
    ).toThrow(rule)
  })

  it.each(['enforce', 'report'] as const)(
    'hard-fails an unguarded public PR fleet workflow in %s mode',
    (mode) => {
      expect(() =>
        ciWorkflow({
          on: 'pull_request',
          trustTier: 'public',
          jobs,
          policy: fleetWorkflowPolicy({
            repository: 'example/project',
            workflow: 'ci.yml',
            mode,
          }),
        }),
      ).toThrow(rule)
    },
  )

  it.each([
    guard,
    `(${guard}) && (github.ref != 'refs/heads/disabled')`,
    `(github.ref != 'refs/heads/disabled') && (${guard})`,
  ])('admits an exact guard or top-level conjunction: %s', (condition) => {
    const workflow = ciWorkflow({
      on: 'pull_request',
      trustTier: 'public',
      jobs: { check: { ...job, if: condition } },
    }).data
    expect(workflow.jobs.check?.if).toBe(condition)
    expect(collectWorkflowPolicyViolations({ workflow, policy })).toEqual([])
  })

  it.each([
    `(${guard}) || github.event_name == 'pull_request'`,
    `((${guard}) && github.ref != 'refs/heads/disabled') || true`,
  ])('rejects a guard bypassable through OR: %s', (condition) => {
    expect(() =>
      ciWorkflow({
        on: 'pull_request',
        trustTier: 'public',
        jobs: { check: { ...job, if: condition } },
      }),
    ).toThrow(rule)
  })

  it('admits push-only public fleet CI without changing job conditions', () => {
    const workflow = ciWorkflow({ on: 'push', trustTier: 'public', jobs }).data
    expect(workflow.jobs.check?.if).toBeUndefined()
    expect(collectWorkflowPolicyViolations({ workflow, policy })).toEqual([])
  })

  it('guards the default fleet auto-review workflow', () => {
    const workflow = autoReviewWorkflow().data
    expect(workflow.jobs['request-review']?.if).toBe(guard)
    expect(collectWorkflowPolicyViolations({ workflow, policy })).toEqual([])
  })

  it('does not add a job condition to Namespace auto-review workflows', () => {
    const workflow = autoReviewWorkflow({
      runner: 'namespace-profile-linux-x86-64',
      policy: {
        repository: 'example/project',
        workflow: 'auto-review.yml',
        admittedRunnerLabels: ['namespace-profile-linux-x86-64'],
        mode: 'report',
        ledger: [
          {
            repository: 'example/project',
            workflow: 'auto-review.yml',
            job: 'request-review',
            rule: 'namespace-runner',
            path: 'jobs.request-review.runs-on',
            value: 'namespace-profile-linux-x86-64',
          },
        ],
      },
    }).data
    expect(workflow.jobs['request-review']).not.toHaveProperty('if')
  })

  it('guards every fleet release job without weakening its existing event condition', () => {
    const workflow = helperWorkflows.releaseWorkflow
    const conditions = {
      'create-release-pr':
        "github.event_name == 'workflow_dispatch' && inputs.mode == 'create-release-pr'",
      'validate-release-plan':
        "github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'validate-release-plan')",
      'publish-release':
        "github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'publish-release')",
    }
    for (const [id, condition] of Object.entries(conditions)) {
      expect(workflow.jobs[id]?.if).toBe(`(${guard}) && (${condition})`)
    }
    expect(collectWorkflowPolicyViolations({ workflow, policy })).toEqual([])
  })
})

describe('upstream setup-action cache contracts', () => {
  const setupViolations = (uses: string, inputs: Record<string, string | boolean> = {}) =>
    collectWorkflowPolicyViolations({
      workflow: fixtureWorkflow({ jobs: { check: { ...job, steps: [{ uses, with: inputs }] } } }),
      policy,
    }).filter((violation) => violation.rule === 'setup-action-cache')

  it.each([
    'v5',
    'v6',
    'v6.1.0',
    'v5-beta',
    '4.x-foo',
    'v4abc',
    'v4.1-branch',
    'v4.1.2.3',
    '4',
    '4.0',
    'main',
  ])('requires explicit automatic Node cache opt-out at %s', (ref) => {
    expect(setupViolations(`actions/setup-node@${ref}`)).toHaveLength(1)
    expect(setupViolations(`actions/setup-node@${ref}`, { cache: '' })).toHaveLength(1)
    for (const disabled of [false, 'false']) {
      expect(
        setupViolations(`actions/setup-node@${ref}`, { 'package-manager-cache': disabled }),
      ).toEqual([])
      expect(
        setupViolations(`actions/setup-node@${ref}`, {
          'package-manager-cache': disabled,
          cache: '',
        }),
      ).toEqual([])
      expect(
        setupViolations(`actions/setup-node@${ref}`, {
          'package-manager-cache': disabled,
          cache: 'npm',
        }),
      ).toHaveLength(1)
    }
    expect(
      setupViolations(`actions/setup-node@${ref}`, { 'package-manager-cache': '' }),
    ).toHaveLength(1)
    expect(
      setupViolations(`actions/setup-node@${ref}`, {
        'package-manager-cache': '${{ inputs.cache }}',
      }),
    ).toHaveLength(1)
  })
  it.each(['v4', 'v4.0', 'v4.0.0'])('preserves the exact pre-v5 tag %s contract', (ref) => {
    expect(setupViolations(`actions/setup-node@${ref}`)).toEqual([])
    expect(setupViolations(`actions/setup-node@${ref}`, { cache: 'npm' })).toHaveLength(1)
  })
  it('uses registered release metadata for SHA-pinned Node v4', () => {
    const uses = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'
    expect(setupViolations(uses)).toEqual([])
    expect(setupViolations(uses, { cache: 'npm' })).toHaveLength(1)
  })
  it('fails closed for unknown SHA-pinned Node releases, even with cache opt-out', () => {
    const uses = 'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444'
    const violations = setupViolations(uses, { 'package-manager-cache': false })
    expect(violations).toHaveLength(1)
    expect(violations[0]?.value).toContain('Unknown SHA-pinned action version')
  })
  it.each(['actions/setup-python@v6', 'actions/setup-java@v5', 'actions/setup-dotnet@v5'])(
    '%s does not cache unless requested',
    (uses) => {
      expect(setupViolations(uses)).toEqual([])
      expect(setupViolations(uses, { cache: '' })).toEqual([])
      expect(setupViolations(uses, { cache: false })).toEqual([])
      expect(setupViolations(uses, { cache: 'package-manager' })).toHaveLength(1)
    },
  )
  it('requires explicit Go cache opt-out', () => {
    expect(setupViolations('actions/setup-go@v6')).toHaveLength(1)
    expect(setupViolations('actions/setup-go@v6', { cache: false })).toEqual([])
    expect(setupViolations('actions/setup-go@v6', { cache: true })).toHaveLength(1)
  })
  it('requires the actual Bun executable-cache opt-out', () => {
    expect(setupViolations('oven-sh/setup-bun@v2')).toHaveLength(1)
    expect(setupViolations('oven-sh/setup-bun@v2', { cache: false })).toHaveLength(1)
    expect(setupViolations('oven-sh/setup-bun@v2', { 'no-cache': false })).toHaveLength(1)
    expect(setupViolations('oven-sh/setup-bun@v2', { 'no-cache': true })).toEqual([])
    expect(setupViolations('oven-sh/setup-bun@v2', { 'no-cache': 'true' })).toEqual([])
    expect(
      setupViolations('oven-sh/setup-bun@v2', { 'no-cache': '${{ inputs.disable }}' }),
    ).toHaveLength(1)
  })
})

describe('central exception scoping', () => {
  const repository = 'example/project'
  const exceptionEntries: readonly WorkflowPolicyException[] = [
    {
      repository,
      workflow: 'one.yml',
      job: 'check',
      rule: 'runner-not-admitted',
      owner: 'maintainer',
      approver: 'reviewer',
      justification: 'Temporary selector migration',
      expiry: '9999-12-31',
      trackingIssue: 'https://github.com/example/project/issues/1',
    },
    {
      repository,
      workflow: 'two.yml',
      job: 'other',
      rule: 'runner-not-admitted',
      owner: 'maintainer',
      approver: 'reviewer',
      justification: 'Temporary selector migration',
      expiry: '9999-12-31',
      trackingIssue: 'https://github.com/example/project/issues/2',
    },
    {
      repository: 'other/project',
      workflow: 'one.yml',
      job: 'elsewhere',
      rule: 'runner-not-admitted',
      owner: 'maintainer',
      approver: 'reviewer',
      justification: 'Unrelated repository',
      expiry: '9999-12-31',
      trackingIssue: 'https://github.com/other/project/issues/1',
    },
  ]
  const workflows = {
    'one.yml': fixtureWorkflow({ jobs: { check: { ...job, 'runs-on': 'temporary-one' } } }),
    'two.yml': fixtureWorkflow({ jobs: { other: { ...job, 'runs-on': 'temporary-two' } } }),
  }

  it('admits each workflow using only its own repository/workflow exceptions', () => {
    for (const [workflow, value] of Object.entries(workflows)) {
      const scoped = fleetWorkflowPolicy({ repository, workflow, exceptionEntries })
      expect(scoped.exceptions).toHaveLength(1)
      expect(() => validateWorkflowPolicy({ workflow: value, policy: scoped })).not.toThrow()
    }
    expect(() =>
      validateFleetPolicyExceptionRegistry({ repository, workflows, exceptionEntries }),
    ).not.toThrow()
  })
  it('round-trips report ledgers using the same exception-filtered observations as checks', () => {
    const workflow = 'one.yml'
    const value = workflows[workflow]
    const entries = exceptionEntries.filter(
      (entry) => entry.repository === repository && entry.workflow === workflow,
    )
    const before = fleetWorkflowPolicy({
      repository,
      workflow,
      mode: 'report',
      ledger: [],
      exceptionEntries: entries,
    })
    expect(collectWorkflowPolicyViolations({ workflow: value, policy: before })).toHaveLength(1)
    expect(() => validateWorkflowPolicy({ workflow: value, policy: before })).not.toThrow()

    const generated = collectFleetPolicyMigrationLedger({
      repository,
      workflows: { [workflow]: value },
      exceptionEntries: entries,
    })
    expect(generated).toEqual([])
    const regenerated = decodeWorkflowPolicyLedger(JSON.parse(JSON.stringify(generated)))
    const after = fleetWorkflowPolicy({
      repository,
      workflow,
      mode: 'report',
      ledger: regenerated,
      exceptionEntries: entries,
    })
    expect(() => validateWorkflowPolicy({ workflow: value, policy: after })).not.toThrow()
    expect(
      collectFleetPolicyMigrationLedger({
        repository,
        workflows: { [workflow]: value },
        exceptionEntries: entries,
      }),
    ).toEqual(regenerated)
    expect(() =>
      validateFleetPolicyExceptionRegistry({
        repository,
        workflows: { [workflow]: value },
        exceptionEntries: entries,
      }),
    ).not.toThrow()
  })
  it('reports unmatched or stale entries only against the full repository census', () => {
    const clean = fixtureWorkflow({ jobs })
    expect(() =>
      validateWorkflowPolicy({
        workflow: clean,
        policy: fleetWorkflowPolicy({ repository, workflow: 'two.yml', exceptionEntries }),
      }),
    ).not.toThrow()
    expect(() =>
      validateFleetPolicyExceptionRegistry({
        repository,
        workflows: { ...workflows, 'two.yml': clean },
        exceptionEntries,
      }),
    ).toThrow(/Stale or unmatched exception/)
    expect(() =>
      validateFleetPolicyExceptionRegistry({
        repository,
        workflows: { 'one.yml': workflows['one.yml'] },
        exceptionEntries,
      }),
    ).toThrow(/two.yml/)
  })
})

describe('consumer cold pnpm workflow', () => {
  it('generates under default enforcement with job-local state and an unconditional install', () => {
    const install = pnpmInstallWithDiagnosticsStep()
    const output = ciWorkflow({
      name: 'Consumer CI',
      on: 'push',
      actionlint: false,
      jobs: {
        check: {
          'runs-on': [...linuxX64Runner],
          steps: [pnpmStateSetupStep, ciDiagnosticsSetupStep, install, { run: 'pnpm test' }],
        },
      },
    })
    const yaml = output.stringify({ location: '.github/workflows/ci.yml', cwd: '/workspace' })
    expect(yaml).toContain('Isolate pnpm state')
    expect(yaml).toContain('Install pnpm dependencies')
    expect(yaml).toContain('pnpm:install')
    expect(yaml).not.toContain('actions/cache')
    expect(yaml).not.toContain('pnpm-state-v3-')
    expect(install).not.toHaveProperty('if')
    expect(pnpmStateSetupStep.run).toContain('mkdir -p')
  })
})

describe('consumer migration ledger', () => {
  const workflow = 'consumer-ci.yml'
  const definition: GitHubWorkflowArgs = {
    name: workflow,
    on: 'push',
    jobs: {
      check: {
        'runs-on': [...linuxX64Runner],
        steps: [
          { name: 'Restore legacy pnpm state', uses: 'actions/cache/restore@v4' },
          { run: 'pnpm test' },
          { name: 'Save legacy pnpm state', uses: 'actions/cache/save@v4' },
          { name: 'Upload results', uses: 'actions/upload-artifact@v4', with: { path: 'results' } },
        ],
      },
    },
  }
  const workflows = { [workflow]: definition }
  const ledger = consumerMigrationLedger({ workflows })
  const generate = (value = definition, baseline = ledger) =>
    ciWorkflow({
      ...value,
      actionlint: false,
      policy: consumerMigrationPolicy({ workflow, ledger: baseline }),
    })

  it('enforces by default, but generates existing pnpm state and artifact debt with a seeded ledger', () => {
    expect(() => ciWorkflow({ ...definition, actionlint: false })).toThrow(/banned-action/)
    expect(ledger.violations.filter((entry) => entry.rule === 'banned-action')).toHaveLength(3)
    const output = generate()
    const yaml = output.stringify({
      location: '.github/workflows/consumer-ci.yml',
      cwd: '/workspace',
    })
    expect(yaml).toContain('actions/cache/restore@v4')
    expect(yaml).toContain('actions/cache/save@v4')
    expect(yaml).toContain('actions/upload-artifact@v4')
  })

  it('rejects new debt both when generating and refreshing', () => {
    const changed: GitHubWorkflowArgs = {
      ...definition,
      jobs: {
        check: {
          ...definition.jobs.check!,
          steps: [...definition.jobs.check!.steps, { uses: 'actions/download-artifact@v4' }],
        },
      },
    }
    expect(() => generate(changed)).toThrow(/NEW/)
    expect(() => consumerMigrationLedger({ workflows: { [workflow]: changed }, ledger })).toThrow(
      /NEW/,
    )
  })

  const upload = (path: string, uses = 'actions/upload-artifact@v4', name = 'Upload results') => ({
    name,
    uses,
    with: { path },
  })
  const withSteps = (steps: GitHubWorkflowArgs['jobs'][string]['steps']): GitHubWorkflowArgs => ({
    ...definition,
    jobs: { check: { ...definition.jobs.check!, steps } },
  })
  const original = withSteps([upload('before')])
  const originalLedger = consumerMigrationLedger({ workflows: { [workflow]: original } })
  const refresh = (value: GitHubWorkflowArgs, baseline = originalLedger) =>
    consumerMigrationLedger({ workflows: { [workflow]: value }, ledger: baseline })

  it('re-keys content only, retaining row count and all other row fields', () => {
    const changed = withSteps([{ run: 'echo unrelated' }, upload('after')])
    const result = refresh(changed)
    expect(result.violations).toHaveLength(originalLedger.violations.length)
    expect(result.violations[0]!.path).not.toBe(originalLedger.violations[0]!.path)
    expect({ ...result.violations[0], path: originalLedger.violations[0]!.path }).toEqual(
      originalLedger.violations[0],
    )
    const output = generate(changed, originalLedger)
    expect(() => output.stringify({ cwd: '/workspace', location: '.' })).toThrow(
      /devenv tasks run genie:run/,
    )
    expect(() =>
      output.stringify({ cwd: '/workspace', location: '.', mode: 'generate' }),
    ).not.toThrow()
  })

  it.each([
    ['step', withSteps([upload('before'), upload('after', undefined, 'New upload')])],
    ['action', withSteps([upload('after', 'actions/download-artifact@v4')])],
    ['unlabelled', withSteps([{ uses: 'actions/upload-artifact@v4', with: { path: 'after' } }])],
    ['job', { ...original, jobs: { different: original.jobs.check! } }],
  ])('refuses new banned-action %s during refresh', (_label, changed) => {
    expect(() => refresh(changed)).toThrow(/NEW/)
  })

  it('keeps existing action ref bumps diagnostic-only, including during content refresh', () => {
    const refOnly = withSteps([upload('before', 'actions/upload-artifact@v5')])
    expect(() =>
      generate(refOnly, originalLedger).stringify({ cwd: '/workspace', location: '.' }),
    ).not.toThrow()
    expect(refresh(refOnly).violations).toHaveLength(1)
    expect(
      refresh(withSteps([upload('after', 'actions/upload-artifact@v5')])).violations,
    ).toHaveLength(1)
  })

  it('refuses ambiguous changed steps in the same job', () => {
    const baseline = consumerMigrationLedger({
      workflows: { [workflow]: withSteps([upload('one'), upload('two')]) },
    })
    expect(() => refresh(withSteps([upload('three'), upload('four')]), baseline)).toThrow(
      /Ambiguous banned-action re-key.*check/,
    )
  })

  it('never grows for every subset of removed, unchanged, or changed labelled steps (finite property)', () => {
    const steps = ['one', 'two', 'three'].map((name) => upload('before', undefined, name))
    const baseline = consumerMigrationLedger({ workflows: { [workflow]: withSteps(steps) } })
    for (let choices = 0; choices < 27; choices++) {
      const selected = steps.flatMap((step, index) => {
        const choice = Math.floor(choices / 3 ** index) % 3
        return choice === 0 ? [] : [{ ...step, with: { path: choice === 1 ? 'before' : 'after' } }]
      })
      const result = refresh(withSteps(selected), baseline)
      expect(result.violations.length).toBeLessThanOrEqual(baseline.violations.length)
      expect(result.violations).toHaveLength(selected.length)
    }
  })

  it('refreshes shrink-only, preserves hand-rolled ledgers and filters by workflow', () => {
    const clean: GitHubWorkflowArgs = {
      ...definition,
      jobs: { check: { ...definition.jobs.check!, steps: [{ run: 'pnpm test' }] } },
    }
    const refreshed = consumerMigrationLedger({
      workflows: { [workflow]: generate(clean).data },
      ledger,
    })
    expect(refreshed.violations).toEqual([])
    const multiWorkflowLedger = {
      violations: [
        ...ledger.violations,
        ...ledger.violations.map((entry) => ({ ...entry, workflow: 'other.yml' })),
      ],
    }
    expect(consumerMigrationPolicy({ workflow, ledger: multiWorkflowLedger }).ledger).toEqual(
      ledger.violations,
    )
    expect(() => generate(definition, JSON.parse(JSON.stringify(ledger)))).not.toThrow()
    expect(() =>
      ciWorkflow({
        ...definition,
        actionlint: false,
        policy: fleetWorkflowPolicy({
          repository: '${{ github.repository }}',
          workflow,
          mode: 'report',
          ledger: decodeWorkflowPolicyLedger(ledger.violations),
        }),
      }),
    ).not.toThrow()
  })

  it.each([
    ['pull-request-target', { ...definition, on: 'pull_request_target' as const }],
    ['fleet-pr-without-same-repo-guard', { ...definition, on: 'pull_request' as const }],
    [
      'fork-controlled-runner',
      {
        ...definition,
        on: 'pull_request' as const,
        jobs: {
          check: {
            ...definition.jobs.check!,
            if: sameRepoPullRequestGuard(),
            'runs-on': '${{ github.event.pull_request.head.repo.name }}',
          },
        },
      },
    ],
  ])('never seeds or accepts forbidden rule %s', (rule, value) => {
    const violations = collectFleetPolicyMigrationLedger({
      workflows: { [workflow]: value },
      repository: '${{ github.repository }}',
    })
    expect(violations.some((entry) => entry.rule === rule)).toBe(true)
    const forbiddenLedger = { violations }
    expect(() => consumerMigrationLedger({ workflows: { [workflow]: value } })).toThrow()
    expect(() =>
      validateWorkflowPolicy({
        workflow: value,
        policy: consumerMigrationPolicy({ workflow, ledger: forbiddenLedger }),
      }),
    ).toThrow()
  })
})
