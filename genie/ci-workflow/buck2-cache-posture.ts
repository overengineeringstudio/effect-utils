import { trustedCacheWriterPredicate } from '../../packages/@overeng/genie/src/runtime/github-workflow/cache-policy.ts'
import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'

/** A job declaration, not authority: only a protected writer step receives credentials. */
export type Buck2CachePosture =
  | 'writer'
  | 'trusted-writer'
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
      posture === 'trusted-writer'
        ? `\${{ (${trustedCacheWriterPredicate}) && '0' || '1' }}`
        : posture === 'writer'
          ? '0'
          : '1',
    ...(posture === 'trusted-writer' ? { BUCK2_CACHE_WRITE_OPTIONAL: '1' } : {}),
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

/** Maintainer dispatch measures only Darwin; no cache saves or proof publication. */
export const withMacosMeasurementDispatch = (
  args: Parameters<typeof withBuck2CachePostures>[0],
): GitHubWorkflowArgs['jobs'] => {
  const jobs = withBuck2CachePostures(args)
  const measure = "github.event_name == 'workflow_dispatch' && inputs['measure-macos'] == true"
  return Object.fromEntries(
    Object.entries(jobs).map(([id, job]) => {
      // Keep explicit measurement exclusions and push-only promotion guards intact.
      if (id === 'promote-published' || job.if?.includes(`!(${measure})`) === true) return [id, job]
      return [
        id,
        {
          ...job,
          if: `\${{ ${id === 'test-macos' || id === 'tested-tree' ? `(${measure}) ||` : `!(${measure}) &&`} (${job.if?.replace(/^\$\{\{\s*|\s*\}\}$/g, '') ?? 'success()'}) }}`,
          steps: [
            ...job.steps.map((step) =>
              id === 'test-macos' &&
              /^(Save signed|Warm local)|Buck2 cache evidence/.test(step.name ?? '') === true
                ? {
                    ...step,
                    if: `\${{ !(${measure}) && ${step.if?.replace(/^\$\{\{\s*|\s*\}\}$/g, '') ?? 'success()'} }}`,
                  }
                : step,
            ),
            ...(id === 'test-macos'
              ? [
                  {
                    name: 'Mark macOS measurement',
                    if: `\${{ always() && (${measure}) }}`,
                    run: 'echo "## macOS measurement (read-only; excluded from cache proofs)" >> "$GITHUB_STEP_SUMMARY"',
                  },
                ]
              : []),
          ],
        },
      ]
    }),
  )
}
