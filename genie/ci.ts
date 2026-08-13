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

export type CiMeasurementExpectation =
  | { readonly _tag: 'exact'; readonly value: number }
  | { readonly _tag: 'at-least'; readonly value: number }
  | { readonly _tag: 'at-most'; readonly value: number }
  | { readonly _tag: 'range'; readonly min: number; readonly max: number }

export type Buck2MeasurementAssertion = {
  readonly id: string
  readonly label: string
  readonly phase: string
  readonly metric: 'actionCount' | 'materializationCount'
  readonly expectation: CiMeasurementExpectation
}

export type Buck2MeasurementTarget = {
  readonly id: string
  readonly label: string
  readonly workContract: string
  readonly benchmarkSchema: 'effect-utils-buck2-benchmark/v0'
  readonly buckTarget: string
  readonly rawPath: string
  readonly runs: number
  readonly assertions: readonly Buck2MeasurementAssertion[]
}

/** Consumer-owned Buck measurement policy used by native admission and the canonical report. */
export const buck2MeasurementTargets = [
  {
    id: 'megarepo-mr',
    label: 'Megarepo CLI',
    workContract: 'megarepo-cli-product/no-equivalent-devenv-lane/v1',
    benchmarkSchema: 'effect-utils-buck2-benchmark/v0',
    buckTarget: '//packages/@overeng/megarepo:mr',
    rawPath: 'tmp/buck2-benchmark/megarepo-mr.jsonl',
    runs: 7,
    assertions: [
      {
        id: 'warm-actions',
        label: 'Warm actions',
        phase: 'warm-noop',
        metric: 'actionCount',
        expectation: { _tag: 'exact', value: 0 },
      },
      {
        id: 'warm-materializations',
        label: 'Warm materializations',
        phase: 'warm-noop',
        metric: 'materializationCount',
        expectation: { _tag: 'exact', value: 0 },
      },
      {
        id: 'mtime-actions',
        label: 'Mtime-only actions',
        phase: 'mtime-only',
        metric: 'actionCount',
        expectation: { _tag: 'exact', value: 0 },
      },
      {
        id: 'irrelevant-actions',
        label: 'Role-excluded actions',
        phase: 'irrelevant-edit',
        metric: 'actionCount',
        expectation: { _tag: 'exact', value: 0 },
      },
      {
        id: 'irrelevant-materializations',
        label: 'Role-excluded materializations',
        phase: 'irrelevant-edit',
        metric: 'materializationCount',
        expectation: { _tag: 'exact', value: 0 },
      },
      {
        id: 'relevant-actions',
        label: 'Relevant-edit actions',
        phase: 'relevant-edit',
        metric: 'actionCount',
        expectation: { _tag: 'at-least', value: 1 },
      },
      {
        id: 'declared-unreachable-actions',
        label: 'Declared-unreachable actions',
        phase: 'declared-unreachable-edit',
        metric: 'actionCount',
        expectation: { _tag: 'at-least', value: 1 },
      },
    ],
  },
  {
    id: 'otel-scrape-product',
    label: 'OTel scrape native product',
    workContract: 'effect-utils/otel-scrape-native-product-v1',
    benchmarkSchema: 'effect-utils-buck2-benchmark/v0',
    buckTarget: '//packages/@overeng/otel-scrape:product',
    rawPath: 'tmp/buck2-benchmark/otel-scrape-product.jsonl',
    runs: 7,
    assertions: [
      {
        id: 'warm-actions',
        label: 'Warm actions',
        phase: 'warm-noop',
        metric: 'actionCount',
        expectation: { _tag: 'exact', value: 0 },
      },
      {
        id: 'warm-materializations',
        label: 'Warm materializations',
        phase: 'warm-noop',
        metric: 'materializationCount',
        expectation: { _tag: 'exact', value: 0 },
      },
      {
        id: 'irrelevant-actions',
        label: 'Irrelevant-edit actions',
        phase: 'irrelevant-edit',
        metric: 'actionCount',
        expectation: { _tag: 'exact', value: 0 },
      },
      {
        id: 'irrelevant-materializations',
        label: 'Irrelevant-edit materializations',
        phase: 'irrelevant-edit',
        metric: 'materializationCount',
        expectation: { _tag: 'exact', value: 0 },
      },
      {
        id: 'relevant-actions',
        label: 'Relevant-edit actions',
        phase: 'relevant-edit',
        metric: 'actionCount',
        expectation: { _tag: 'exact', value: 2 },
      },
    ],
  },
] as const satisfies readonly Buck2MeasurementTarget[]

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
  // Local-only Buck graph, receipt, bridge, and benchmark-contract evidence.
  'buck2',
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
  // proves `genie --phase bootstrap` + `pnpm install` run cold (no node_modules). Merge-blocking.
  'bootstrap-cold-proof',
  'devenv-perf',
  'nix-closure-sizes',
  'source-shape',
  'ci-measurements-report',
  'test-integration-notion',
  'test-integration-restate',
  'test-live-deploy-ci-tools',
] as const

/** Required deploy/reporting job keys that block merge when they fail. */
export const REQUIRED_DEPLOY_CI_JOB_NAMES = ['deploy-storybooks'] as const

/** Workflow jobs that intentionally do not block merging. */
export const advisoryCIJobNames = ['notify-alignment'] as const

/** CI job keys emitted by the generated workflow. */
export const CI_JOB_NAMES = [
  DEFAULT_REF_POLICY_CI_JOB_NAME,
  ...CORE_CI_JOB_NAMES,
  ...EXTRA_CI_JOB_NAMES,
  ...REQUIRED_DEPLOY_CI_JOB_NAMES,
  ...advisoryCIJobNames,
] as const

/** Union of canonical CI job keys used across workflow generation and repo settings. */
export type CIJobName = (typeof CI_JOB_NAMES)[number]

/**
 * Merge-blocking CI job keys for branch protection.
 *
 * Every non-advisory workflow lane is required. Measurement jobs can still run
 * warn-mode comparisons internally, but the lane must produce its artifact and
 * complete successfully so branch protection covers CI evidence production.
 */
export const REQUIRED_CI_JOB_NAMES = [
  DEFAULT_REF_POLICY_CI_JOB_NAME,
  ...CORE_CI_JOB_NAMES,
  ...EXTRA_CI_JOB_NAMES,
  ...REQUIRED_DEPLOY_CI_JOB_NAMES,
] as const satisfies readonly CIJobName[]

const matrixCIJobNames = ['test', 'nix-check', 'nix-fod-check'] as const

/** GitHub status-check context names emitted by a workflow job key. */
export const ciJobCheckContexts = (jobName: CIJobName) => {
  if (jobName === 'ci-measurements-report') return ['ci/measurements-report']

  return matrixCIJobNames.includes(jobName as (typeof matrixCIJobNames)[number]) === true
    ? RUNNER_PROFILES.map((runner) => `${jobName} (${runner})`)
    : [jobName]
}

/**
 * Required status checks for branch protection.
 * Matrix jobs are reported as "job-name (matrix-value)" by GitHub Actions.
 */
export const requiredCIJobs = REQUIRED_CI_JOB_NAMES.flatMap(ciJobCheckContexts)
