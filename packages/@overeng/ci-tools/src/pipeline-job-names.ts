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
  'quality',
  'test-playwright-utils',
  'test-playwright-tui-react',
  'test-megarepo-cold-gc',
  'cargo',
  'weaver',
  'bootstrap-cold-proof',
  'nix-closure-sizes',
  'source-shape',
  'main-source-shape',
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

/** Resolves provider job names against one workflow definition's declared jobs and runner matrix. */
export const pipelineJobIdentityResolver = (workflow: {
  readonly jobIds: readonly string[]
  readonly runnerProfiles: readonly string[]
}): ((name: string) => PipelineJobIdentity | undefined) => {
  const identities = new Map<string, PipelineJobIdentity>()
  const duplicateNames = new Set<string>()
  const names = [
    ...workflow.jobIds.map((job) => ({
      name:
        job === 'quality'
          ? 'pr/quality'
          : job === 'ci-measurements-report'
            ? 'ci/measurements-report'
            : job === 'main-source-shape'
              ? 'main/source-shape'
              : job,
      identity: { job, dimensions: {} },
    })),
    ...workflow.runnerProfiles.map((runner) => ({
      name: `test (${runner})`,
      identity: { job: 'test', dimensions: { runner } },
    })),
  ]
  for (const { name, identity } of names) {
    if (identities.has(name) === true) duplicateNames.add(name)
    identities.set(name, identity)
  }
  /* Never guess a canonical key for an unknown or ambiguous provider job name. */
  return (name) => (duplicateNames.has(name) === true ? undefined : identities.get(name))
}

/** Resolves provider job names against the generated CI workflow of this commit. */
export const pipelineJobIdentityForName = pipelineJobIdentityResolver({
  jobIds: pipelineJobIds,
  runnerProfiles: pipelineRunnerProfiles,
})

/** All known job identifiers, used to check the generator's declarations. */
export const pipelineJobIdentifierSet = new Set([...pipelineJobIds, 'test'])

/** Jobs API fields that locate one job row within a run's attempts. */
export type AttemptJob = {
  readonly name: string
  readonly run_attempt: number
  readonly started_at: string | null
  readonly completed_at: string | null
}

/**
 * Selects the latest attempt's jobs from a `filter=all` listing and resolves each job's execution
 * attempt. A partial rerun reports carried-over jobs under the new `run_attempt`, but their
 * producer ran (and exported its trace) in the earliest attempt whose same-named job has identical
 * `started_at` and `completed_at`.
 */
export const latestJobsWithExecutionAttempt = <J extends AttemptJob>(
  all: readonly J[],
): (J & { readonly executionAttempt: number })[] => {
  const latest = all.reduce((max, job) => Math.max(max, job.run_attempt), 0)
  const byAttemptAndName = new Map<string, J[]>()
  for (const job of all) {
    const key = `${job.run_attempt}\0${job.name}`
    byAttemptAndName.set(key, [...(byAttemptAndName.get(key) ?? []), job])
  }
  return all
    .filter((job) => job.run_attempt === latest)
    .map((job) => {
      let executionAttempt = job.run_attempt
      while (executionAttempt > 1) {
        const earlier = byAttemptAndName.get(`${executionAttempt - 1}\0${job.name}`)
        const copy = earlier?.length === 1 ? earlier[0]! : undefined
        if (
          copy === undefined ||
          job.started_at === null ||
          copy.started_at !== job.started_at ||
          copy.completed_at !== job.completed_at
        )
          break
        executionAttempt--
      }
      return Object.assign({}, job, { executionAttempt })
    })
}
