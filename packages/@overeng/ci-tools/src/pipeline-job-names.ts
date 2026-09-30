/* GitHub Jobs API names for the generated CI workflow. A generator assertion guards this finite list. */

/** GitHub Jobs API step names proving that the job-end adapter can export a trace. */
export const pipelineIdentityStepName = 'Prepare pipeline job identity'
/** The adapter needs a resolved devenv executable to emit and export the job root. */
export const pipelineDevenvStepName = 'Resolve devenv'
/** The always-run adapter step performs job-end capture and export when ready. */
export const pipelineExportStepName = 'Export completed job trace'

/** Runner profiles used to generate matrix job identities. */
export const pipelineRunnerProfiles = [
  'namespace-profile-linux-x86-64',
  'namespace-profile-macos-arm64',
] as const

/** Static job identifiers declared by the generated CI workflow. */
export const pipelineJobIds = [
  'default-ref-policy',
  'typecheck',
  'lint',
  'test-playwright-utils',
  'test-playwright-tui-react',
  'test-megarepo-cold-gc',
  'pnpm-builder-contract',
  'pnpm-regression',
  'bundle-smoke',
  'cargo',
  'weaver',
  'bootstrap-cold-proof',
  'nix-closure-sizes',
  'source-shape',
  'test-integration-restate',
  'build-products',
  'pr-reviews-resolved',
  'test-integration-notion',
  'test-live-deploy-ci-tools',
  'deploy-storybooks',
  'publish-products',
  'devenv-perf',
  'ci-measurements-report',
  'notify-alignment',
  'trusted-buck2-remote-cache-proof',
  'seed-pnpm-archives',
  'pr-a-inert-buck',
  'pipeline-attempt-close',
  'pipeline-traces',
] as const

/** Canonical identity of a GitHub Actions job and its matrix dimensions. */
export type PipelineJobIdentity = {
  readonly job: string
  readonly dimensions: Readonly<Record<string, string>>
}

/** Never guess a canonical key for an unknown or ambiguous provider job name. */
export const pipelineJobIdentityForName = (name: string): PipelineJobIdentity | undefined =>
  duplicateNames.has(name) === true ? undefined : identities.get(name)

/** All known job identifiers, used to check the generator's declarations. */
export const pipelineJobIdentifierSet = new Set([...pipelineJobIds, 'test'])

const names = [
  ...pipelineJobIds.map((job) => ({
    name: job === 'ci-measurements-report' ? 'ci/measurements-report' : job,
    identity: { job, dimensions: {} },
  })),
  ...pipelineRunnerProfiles.map((runner) => ({
    name: `test (${runner})`,
    identity: { job: 'test', dimensions: { runner } },
  })),
]

const identities = new Map<string, PipelineJobIdentity>()
const duplicateNames = new Set<string>()
for (const { name, identity } of names) {
  if (identities.has(name) === true) duplicateNames.add(name)
  identities.set(name, identity)
}
