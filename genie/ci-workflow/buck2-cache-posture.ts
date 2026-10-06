import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'

/** A job declaration, not authority: only a protected writer step receives credentials. */
export type Buck2CachePosture =
  | 'writer'
  | 'main-writer'
  | 'reader'
  | 'none'
  | { readonly posture: 'reader'; readonly disabledWhen: string }

/** Explicit job-local values; a credential cannot override reader or none. */
export const buck2CachePostureEnv = (declaration: Buck2CachePosture): Record<string, string> => {
  const posture = typeof declaration === 'string' ? declaration : declaration.posture
  return {
    BUCK2_NO_REMOTE_CACHE:
      typeof declaration === 'string'
        ? posture === 'none'
          ? '1'
          : '0'
        : `\${{ ${declaration.disabledWhen} && '1' || '0' }}`,
    BUCK2_PUBLIC_CACHE_READ_ONLY:
      posture === 'main-writer'
        ? "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && '0' || '1' }}"
        : posture === 'writer'
          ? '0'
          : '1',
    ...(posture === 'main-writer' ? { BUCK2_CACHE_WRITE_OPTIONAL: '1' } : {}),
  }
}

/** Project a complete per-job declaration into explicit environment values. */
export const withBuck2CachePostures = ({
  jobs,
  postures,
}: {
  readonly jobs: GitHubWorkflowArgs['jobs']
  readonly postures: Readonly<Record<string, Buck2CachePosture>>
}): GitHubWorkflowArgs['jobs'] => {
  for (const jobId of Object.keys(postures)) {
    if (Object.hasOwn(jobs, jobId) === false)
      throw new Error(`Buck2 cache posture declares unknown job ${jobId}`)
  }
  return Object.fromEntries(
    Object.entries(jobs).map(([jobId, job]) => {
      const declaration = postures[jobId]
      if (declaration === undefined)
        throw new Error(`CI job ${jobId} requires an explicit Buck2 cache posture`)
      const posture = typeof declaration === 'string' ? declaration : declaration.posture
      const env = buck2CachePostureEnv(declaration)
      for (const [key, value] of Object.entries(env)) {
        if (job.env?.[key] !== undefined && job.env[key] !== value)
          throw new Error(`CI job ${jobId} has conflicting ${key} for Buck2 ${posture} posture`)
      }
      return [jobId, { ...job, env: { ...job.env, ...env } }]
    }),
  )
}
