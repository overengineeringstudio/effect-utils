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
  devenvPerfArtifactStep,
  devenvPerfBenchmarkStep,
  devenvPerfJob,
  nixClosureMeasurementStep,
  type CiMeasurementObservation,
  type DevenvPerfJobOptions,
  type DevenvPerfProbe,
  type NixClosureMeasurementBucket,
  type NixClosureMeasurementStepOptions,
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
  standardSelfHostedPnpmCiPostSteps,
  standardSelfHostedPnpmCiPrepSteps,
  validateColdPnpmDepsStep,
  validateNixStoreStep,
  withGitHubAccessTokenEnv,
  withPrivateCachixReadAuth,
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
