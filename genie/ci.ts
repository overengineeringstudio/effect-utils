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
  // One Linux bootstrap; named steps retain each quality invariant's failure attribution.
  'quality',
  'test',
  'test-playwright-utils',
  'test-playwright-tui-react',
  'test-megarepo-cold-gc',
  // Rust lane: delegates build/test/clippy/fmt semantics to devenv task cargo:check.
  'cargo',
  // Additive Weaver semantic-conventions gate (separate lane; degrades if weaver unavailable).
  'weaver',
] as const

/** Union of core CI job keys used by the shared product-job generator. */
export type CoreCIJobName = (typeof CORE_CI_JOB_NAMES)[number]

/** Required source-policy job key generated before the core product-job block. */
export const DEFAULT_REF_POLICY_CI_JOB_NAME = 'default-ref-policy' as const

/** Additional CI job keys generated outside the core product-job block. */
export const EXTRA_CI_JOB_NAMES = [
  // Empirical bootstrap-safety authority (R32, issue #884): builds the self-contained nix genie and
  // proves `genie --phase bootstrap` + `pnpm install` run cold (no node_modules).
  'bootstrap-cold-proof',
  'nix-closure-sizes',
  'source-shape',
  'test-integration-restate',
  // Credential-free build of every published `.#buck-product-*-from-source` attr, so a PR
  // cannot break the trusted `publish-products` lane after merge. Merge-blocking.
  'build-products',
  // Review-thread resolution gate: fails while any PR review thread is unresolved.
  // The native ruleset flag (`required_review_thread_resolution`) is the live merge
  // gate; this job is the early visible PR signal. Merge-blocking.
  'pr-reviews-resolved',
] as const

/** CI job keys that run only after changes reach `main`. */
export const MAIN_ONLY_CI_JOB_NAMES = [
  'test-integration-notion',
  'test-live-deploy-ci-tools',
  'deploy-storybooks',
  'publish-products',
  'main-source-shape',
] as const

/**
 * Lanes that deliberately do not run on every pull request.
 *
 * These cannot be required status checks: a lane that is skipped reports no check run at
 * all, so branch protection would wait for a status that never arrives.
 *
 * `devenv-perf` is the paired wall-clock lane. Its cost is paid only for an explicit
 * operator `workflow_dispatch`.
 */
export const OPT_IN_CI_JOB_NAMES = ['devenv-perf'] as const

/** Empirical proofs run on trusted main or a credential-free PR opt-in, not every PR. */
export const EMPIRICAL_PROOF_CI_JOB_NAMES = [
  'bootstrap-cold-proof',
  'test-megarepo-cold-gc',
  'nix-closure-sizes',
] as const

/** Workflow jobs that intentionally do not block merging. */
export const advisoryCIJobNames = ['ci-measurements-report', 'notify-alignment'] as const

/** CI job keys emitted by the generated workflow. */
export const CI_JOB_NAMES = [
  DEFAULT_REF_POLICY_CI_JOB_NAME,
  ...CORE_CI_JOB_NAMES,
  ...EXTRA_CI_JOB_NAMES,
  ...OPT_IN_CI_JOB_NAMES,
  ...MAIN_ONLY_CI_JOB_NAMES,
  ...advisoryCIJobNames,
] as const

/** Union of canonical CI job keys used across workflow generation and repo settings. */
export type CIJobName = (typeof CI_JOB_NAMES)[number]

/**
 * Merge-blocking CI job keys for branch protection.
 *
 * Every lane that runs on every pull request and is not advisory is required. Measurement
 * jobs can still run warn-mode comparisons internally, but the lane must produce its
 * artifact and complete successfully so branch protection covers CI evidence production.
 * Opt-in and main-only lanes are excluded because they do not run on every pull request.
 */
export const REQUIRED_CI_JOB_NAMES = [
  DEFAULT_REF_POLICY_CI_JOB_NAME,
  ...[...CORE_CI_JOB_NAMES, ...EXTRA_CI_JOB_NAMES].filter(
    (jobName) => !EMPIRICAL_PROOF_CI_JOB_NAMES.some((proofJobName) => proofJobName === jobName),
  ),
] as const satisfies readonly CIJobName[]

/**
 * Merge-blocking job keys emitted by workflows other than `ci.yml`.
 *
 * Each runs on every pull request with no path filter or job-level `if`, so its check run
 * always materializes. `test-storybook-plays` lives in `storybook-plays.yml` because `ci.yml`
 * sits at the GitHub Actions workflow size limit.
 */
export const STANDALONE_REQUIRED_CI_JOB_NAMES = ['test-storybook-plays'] as const

const matrixCIJobNames = ['test'] as const

/** GitHub status-check context names emitted by a workflow job key. */
export const ciJobCheckContexts = (jobName: CIJobName) => {
  if (jobName === 'quality') return ['pr/quality']
  if (jobName === 'main-source-shape') return ['main/source-shape']
  if (jobName === 'ci-measurements-report') return ['ci/measurements-report']

  return matrixCIJobNames.includes(jobName as (typeof matrixCIJobNames)[number]) === true
    ? RUNNER_PROFILES.map((runner) => `${jobName} (${runner})`)
    : [jobName]
}

/**
 * Required status checks for branch protection.
 * Matrix jobs are reported as "job-name (matrix-value)" by GitHub Actions.
 */
export const requiredCIJobs = [
  ...REQUIRED_CI_JOB_NAMES.flatMap(ciJobCheckContexts),
  ...STANDALONE_REQUIRED_CI_JOB_NAMES,
]
