import { describe, expect, it } from 'vitest'

import repoSettings from '../../.github/repo-settings.json' with { type: 'json' }
import { isFleetCacheRunner } from '../../packages/@overeng/genie/src/runtime/github-workflow/cache-policy.ts'
import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/github-workflow/mod.ts'
import {
  collectWorkflowPolicyViolations,
  type WorkflowPolicyRule,
} from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'
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
import { fleetWorkflowPolicy } from './policy.ts'
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
  ciOtelSpansArtifactStep,
  nixDiagnosticsArtifactStep,
  pnpmStatePublisherPostSteps,
  restoreNixCacheStep,
  restorePnpmStateStep,
  saveNixCacheStep,
  savePnpmStateStep,
  standardSelfHostedDevenvTaskJob,
  standardSelfHostedPnpmCiPostSteps,
  standardSelfHostedPnpmCiPrepSteps,
  withSinglePnpmStatePublisher,
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
    jobs: snapshotRelease.jobs,
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
    jobs: netlifyPreviewDeployJobs({
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
  },
  pipelineCloseJob: { jobs: { close: pipelineCloseJob({ jobs, runsOn: [...linuxX64Runner] }) } },
  withPipelineTelemetry: { jobs: withPipelineTelemetry(jobs) },
  withBuck2CacheEvidence: { jobs: withBuck2CacheEvidence(jobs) },
  withBuck2CachePostures: { jobs: withBuck2CachePostures({ jobs, postures: { check: 'reader' } }) },
  withNixRealisationTimeouts: { jobs: withNixRealisationTimeouts(jobs, {}) },
  ciWorkflow: ciWorkflow({ on: 'pull_request', jobs, trustTier: 'public' }).data,
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
  withSinglePnpmStatePublisher: {
    jobs: withSinglePnpmStatePublisher({ jobs, publisher: 'check' }),
  },
  standardSelfHostedPnpmCiPrepSteps: {
    jobs: { check: { ...job, steps: standardSelfHostedPnpmCiPrepSteps() } },
  },
  standardSelfHostedPnpmCiPostSteps: {
    jobs: { check: { ...job, steps: standardSelfHostedPnpmCiPostSteps() } },
  },
  pnpmStatePublisherPostSteps: {
    jobs: { check: { ...job, steps: pnpmStatePublisherPostSteps({ publish: true }) } },
  },
  restoreNixCacheStep: { jobs: { check: { ...job, steps: [restoreNixCacheStep()] } } },
  saveNixCacheStep: { jobs: { check: { ...job, steps: [saveNixCacheStep()] } } },
  restorePnpmStateStep: { jobs: { check: { ...job, steps: [restorePnpmStateStep()] } } },
  savePnpmStateStep: { jobs: { check: { ...job, steps: [savePnpmStateStep()] } } },
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
  'withSinglePnpmStatePublisher',
  'standardSelfHostedPnpmCiPrepSteps',
  'standardSelfHostedPnpmCiPostSteps',
  'pnpmStatePublisherPostSteps',
  'restoreNixCacheStep',
  'saveNixCacheStep',
  'restorePnpmStateStep',
  'savePnpmStateStep',
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

// Some deploy helpers expose loose records and step helpers return readonly arrays;
// the fixture boundary only adapts those declarations, without changing emitted values.
const fixtureWorkflow = (fixture: { jobs: object; on?: unknown }): GitHubWorkflowArgs =>
  ({ on: 'pull_request', ...fixture }) as GitHubWorkflowArgs

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
