/**
 * Shared CI configuration for genie files.
 * Single source of truth for CI job names used in both:
 * - .github/workflows/ci.yml.genie.ts (job definitions)
 * - .github/repo-settings.json.genie.ts (required status checks)
 */

/** Runner profiles for multi-platform CI jobs */
export const RUNNER_PROFILES = [
  'namespace-profile-linux-x86-64',
  'namespace-profile-macos-arm64',
] as const

/** Union of supported GitHub Actions runner profile labels. */
export type RunnerProfile = (typeof RUNNER_PROFILES)[number]

/** Core CI job keys used for the typed product-job block in the workflow generator. */
export const CORE_CI_JOB_NAMES = [
  'typecheck',
  'lint',
  'test',
  'test-megarepo-cold-gc',
  'nix-check',
  'nix-fod-check',
  'pnpm-builder-contract',
  'pnpm-regression',
  'bundle-smoke',
  // Rust lane for the otelite crate: build/test/clippy/fmt via the nix toolchain.
  'cargo',
] as const

/** Union of core CI job keys used by the shared product-job generator. */
export type CoreCIJobName = (typeof CORE_CI_JOB_NAMES)[number]

/** Required source-policy job key generated before the core product-job block. */
export const DEFAULT_REF_POLICY_CI_JOB_NAME = 'default-ref-policy' as const

/** Additional required CI job keys generated outside the core product-job block. */
export const REQUIRED_EXTRA_CI_JOB_NAMES = [
  'devenv-perf',
  'nix-closure-sizes',
  'source-shape',
  'test-integration-notion',
  'test-integration-restate',
  'test-live-deploy-ci-tools',
] as const

/** Required deploy/reporting job keys that block merge when they fail. */
export const REQUIRED_DEPLOY_CI_JOB_NAMES = ['deploy-storybooks'] as const

/** Workflow jobs that intentionally do not block merging. */
export const advisoryCIJobNames = ['ci-measurements-report', 'notify-alignment'] as const

/** CI job keys emitted by the generated workflow. */
export const CI_JOB_NAMES = [
  DEFAULT_REF_POLICY_CI_JOB_NAME,
  ...CORE_CI_JOB_NAMES,
  ...REQUIRED_EXTRA_CI_JOB_NAMES,
  ...REQUIRED_DEPLOY_CI_JOB_NAMES,
  ...advisoryCIJobNames,
] as const

/** Union of canonical CI job keys used across workflow generation and repo settings. */
export type CIJobName = (typeof CI_JOB_NAMES)[number]

const matrixCIJobNames = ['test', 'nix-check', 'nix-fod-check'] as const
const advisoryCIJobNameSet = new Set<CIJobName>(advisoryCIJobNames)

/** GitHub status-check context names emitted by a workflow job key. */
export const ciJobCheckContexts = (jobName: CIJobName) => {
  if (jobName === 'ci-measurements-report') return ['ci/measurements-report']

  return matrixCIJobNames.includes(jobName as (typeof matrixCIJobNames)[number])
    ? RUNNER_PROFILES.map((runner) => `${jobName} (${runner})`)
    : [jobName]
}

/**
 * Required status checks for branch protection.
 * Every generated non-advisory workflow job is required. Matrix jobs are
 * reported as "job-name (matrix-value)" by GitHub Actions.
 */
export const requiredCIJobs = CI_JOB_NAMES.filter(
  (jobName) => advisoryCIJobNameSet.has(jobName) === false,
).flatMap(ciJobCheckContexts)
