/**
 * Shared CI workflow building blocks for GitHub Actions.
 *
 * Provides composable step atoms and job configuration helpers
 * that peer repos import to avoid CI template duplication.
 *
 * @example
 * ```ts
 * import {
 *   checkoutStep, installNixStep, cachixStep,
 *   preparePinnedDevenvStep, validateNixStoreStep, nixDiagnosticsArtifactStep,
 *   runDevenvTasksBefore, standardCIEnv,
 * } from '../../repos/effect-utils/genie/ci-workflow.ts'
 *
 * const baseSteps = [
 *   checkoutStep(),
 *   installNixStep(),
 *   cachixStep({ name: 'my-cache' }),
 *   preparePinnedDevenvStep,
 *   validateNixStoreStep,
 *   nixDiagnosticsArtifactStep(),
 * ]
 * ```
 */

import type { GitHubWorkflowArgs } from '../packages/@overeng/genie/src/runtime/mod.ts'
import { defaultRefPolicyCheckStep, type DefaultRefPolicyCheckStepOptions } from './ci-workflow/megarepo.ts'
import { bashShellDefaults, linuxX64Runner, standardCIEnv } from './ci-workflow/shared.ts'
import { checkoutStep, installNixStep } from './ci-workflow/setup.ts'

type GitHubWorkflowJob = GitHubWorkflowArgs['jobs'][string]
type GitHubWorkflowStep = GitHubWorkflowJob['steps'][number]

export type DefaultRefPolicyCheckJobOptions = DefaultRefPolicyCheckStepOptions & {
  readonly name?: string
  readonly runsOn?: GitHubWorkflowJob['runs-on']
  readonly env?: Record<string, string>
  readonly permissions?: GitHubWorkflowJob['permissions']
  readonly defaults?: GitHubWorkflowJob['defaults']
  readonly preSteps?: readonly GitHubWorkflowStep[]
  readonly postSteps?: readonly GitHubWorkflowStep[]
}

/** Dedicated CI job for first-party default-ref policy so normal jobs keep their signal. */
export const defaultRefPolicyCheckJob = (opts: DefaultRefPolicyCheckJobOptions = {}) => {
  const { name, runsOn, env, permissions, defaults, preSteps, postSteps, ...stepOpts } = opts

  return {
    ...(name === undefined ? {} : { name }),
    'runs-on': runsOn ?? linuxX64Runner,
    permissions: permissions ?? { contents: 'read' },
    defaults: defaults ?? bashShellDefaults,
    env: { ...standardCIEnv, ...env },
    steps: [
      checkoutStep(),
      installNixStep(),
      ...(preSteps ?? []),
      defaultRefPolicyCheckStep(stepOpts),
      ...(postSteps ?? []),
    ],
  } satisfies GitHubWorkflowJob
}

export {
  RUNNER_PROFILES,
  bashShellDefaults,
  cachixBinaryCache,
  ciWorkflow,
  ciWorkflowConcurrency,
  darwinArm64Runner,
  defaultActionlintConfig,
  devenvBinaryCache,
  jobLocalCiDiagnosticsDir,
  jobLocalPnpmHome,
  jobLocalPnpmStatePaths,
  jobLocalPnpmStore,
  linuxArm64Runner,
  linuxX64Runner,
  nixBinaryCachesExtraConf,
  nixExtraConf,
  runDevenvTasksBefore,
  standardCIEnv,
  workspaceLocalNixCachePath,
  workspaceLocalNixCacheRoot,
  type NixBinaryCache,
  type RunnerProfile,
} from './ci-workflow/shared.ts'
export {
  ciMeasurementMetrics,
  ciMeasurementBaselineBackfillPredicate,
  ciMeasurementBaselineCheckoutStep,
  ciMeasurementBaselineWorkflowDispatchInputs,
  ciMeasurementNotBaselineBackfillPredicate,
  ciMeasurementSubjectEnv,
  ciMeasurementsArtifactStep,
  ciMeasurementsCommentPermissions,
  compareCiMeasurementsStep,
  defaultNixClosureMeasurementBuckets,
  downloadPreviousGitHubArtifactStep,
  devenvPerfArtifactStep,
  devenvPerfBenchmarkStep,
  devenvPerfJob,
  nixClosureMeasurementSteps,
  nixClosureMeasurementsJob,
  nixClosureMeasurementStep,
  sourceShapeMeasurementStep,
  type CiMeasurementDescriptor,
  type CiMeasurementObservation,
  type CiMeasurementsArtifactStepOptions,
  type CiMeasurementsComparisonStepOptions,
  type DevenvPerfJobOptions,
  type DevenvPerfProbe,
  type DevenvPerfTaskProbe,
  type GitHubPreviousArtifactStepOptions,
  type NixClosureMeasurementBucket,
  type NixClosureMeasurementStepOptions,
  type NixClosureMeasurementTarget,
  type NixClosureMeasurementsJobOptions,
  type NixClosureMeasurementsStepsOptions,
  type SourceShapeMeasurementScope,
  type SourceShapeMeasurementStepOptions,
} from './ci-workflow/measurements.ts'
export {
  appendGitHubAccessTokenToNixConfigStep,
  cachixCliBuildStep,
  cachixStep,
  checkoutStep,
  ciDiagnosticsArtifactStep,
  ciDiagnosticsSetupStep,
  captureRunnerPressureStep,
  coldFreshNixBuildStep,
  evictCachedPnpmDepsStep,
  githubAccessTokenEnv,
  githubAppInstallationTokenStep,
  installNixStep,
  namespaceRunner,
  nixCacheSetupStep,
  nixDiagnosticsArtifactStep,
  pnpmBuilderContractStep,
  pnpmInstallWithDiagnosticsStep,
  pnpmStateSetupStep,
  preparePinnedDevenvStep,
  restoreNixCacheStep,
  restorePnpmStateStep,
  saveNixCacheStep,
  savePnpmStateStep,
  devenvTaskStep,
  standardSelfHostedDevenvTaskJob,
  standardSelfHostedPnpmCiPostSteps,
  standardSelfHostedPnpmCiPrepSteps,
  validateColdPnpmDepsStep,
  validateNixStoreStep,
  withGitHubAccessTokenEnv,
  withPrivateCachixReadAuth,
  type StandardSelfHostedDevenvTaskJobOptions,
} from './ci-workflow/setup.ts'
export {
  applyMegarepoLockStep,
  defaultRefPolicyCheckStep,
  installMegarepoStep,
  jobLocalMegarepoStore,
  syncMegarepoWorkspaceStep,
  type DefaultRefPolicyCheckStepOptions,
} from './ci-workflow/megarepo.ts'
export {
  fullPullRequestCiEvent,
  githubApiGetFunctionLines,
  mergeQueueAdmissionCheckLines,
  mergeQueueAdmissionDeferredLines,
  mergeQueueAdmissionEvidence,
  mergeQueueAdmissionGateJob,
  mergeQueueAdmissionLabel,
  mergeQueueAdmissionLabelEvent,
  mergeQueueAdmissionStep,
  mergeQueueAdmittedJob,
  mergeQueuePullRequestTrigger,
  mergeQueueRequiredCIJobs,
  mergeQueueSemanticGateJob,
  mergeQueueSemanticGateJobs,
  mergeQueueWorkflowOn,
  mergeQueueWorkflowConcurrency,
  nonScheduleRequiredGateIf,
  requiredCiMaterializingEvent,
  requiredGateCheckName,
  skipNonMaterializingPrControlEventLines,
  type MergeQueueAdmissionCheckOptions,
  type MergeQueueAdmissionGateJobOptions,
  type MergeQueueAdmissionStepOptions,
  type MergeQueueAdmittedJobOptions,
  type MergeQueueSemanticGateJobOptions,
  type MergeQueueSemanticGateSpec,
} from './ci-workflow/merge-queue.ts'
export {
  deployCommentPermissions,
  deployCommentStep,
  deployModeScript,
  dispatchAlignmentStep,
  netlifyDeployStep,
  netlifyStorybookCommentStep,
  notifyAlignmentJob,
  vercelDeployJobs,
  vercelDeployStep,
  vercelGitAuthorStep,
} from './ci-workflow/deploy.ts'
