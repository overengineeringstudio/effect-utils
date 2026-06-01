import { netlifyDeployStep as buildNetlifyDeployStep } from '../deploy-preview/netlify.ts'
import {
  type VercelProject,
  vercelDeployJobs as buildVercelDeployJobs,
  vercelDeployStep as buildVercelDeployStep,
} from '../deploy-preview/vercel.ts'
import { bashShellDefaults, linuxX64Runner, runDevenvTasksBefore } from './shared.ts'

export {
  workflowReportOutputName as deployPreviewWorkflowReportOutputName,
  workflowReportPathOutputName as deployPreviewWorkflowReportPathOutputName,
} from '../deploy-preview/shared.ts'

/** Job-level permissions required by deploy preview helpers to post/edit PR comments. */
export const deployCommentPermissions = {
  contents: 'read',
  'pull-requests': 'write',
} as const

/** Shared mode detection script for deploy comments. Sets `label` based on event type. */
export const deployModeScript = [
  'if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then',
  '  label="prod"',
  'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
  '  label="PR #${{ github.event.pull_request.number }}"',
  'else',
  '  exit 0',
  'fi',
].join('\n')

/**
 * Step that dispatches `upstream-changed` repository_dispatch to a target repo.
 * Add this to upstream CI workflows so merges to main trigger downstream alignment.
 *
 * Requires `MEGAREPO_ALIGNMENT_TOKEN` secret (fine-grained PAT with Contents + Pull Requests write).
 */
export const dispatchAlignmentStep = (opts: {
  /** Target repo that receives the dispatch (e.g. 'schickling/megarepo-all') */
  targetRepo: string
  /** Event type sent in the dispatch (default: 'upstream-changed') */
  eventType?: string
}) => ({
  name: 'Dispatch alignment to coordinator',
  env: { GH_TOKEN: '${{ secrets.MEGAREPO_ALIGNMENT_TOKEN }}' },
  run: [
    `payload=$(printf '{"event_type":"${opts.eventType ?? 'upstream-changed'}","client_payload":{"source_repo":"%s","source_sha":"%s"}}' "${'${{ github.repository }}'}" "${'${{ github.sha }}'}")`,
    `curl --fail-with-body --silent --show-error --request POST \\`,
    `  --url "https://api.github.com/repos/${opts.targetRepo}/dispatches" \\`,
    `  --header "Accept: application/vnd.github+json" \\`,
    `  --header "Content-Type: application/json" \\`,
    `  --header "Authorization: Bearer ${'${GH_TOKEN}'}" \\`,
    `  --header "X-GitHub-Api-Version: 2022-11-28" \\`,
    `  --data "$payload"`,
  ].join('\n'),
  shell: 'bash',
})

/**
 * Complete notify-alignment job definition.
 * Runs on self-hosted runner after CI passes, dispatches `upstream-changed` to the coordinator.
 */
export const notifyAlignmentJob = (opts: {
  targetRepo: string
  needs: readonly string[]
  runner?: readonly string[]
  timeoutMinutes?: number
  /** Branches that trigger notification (default: main only) */
  branches?: readonly string[]
}) => ({
  'runs-on': opts.runner ?? linuxX64Runner,
  'timeout-minutes': opts.timeoutMinutes ?? 30,
  needs: [...opts.needs],
  if: `(${(opts.branches ?? ['main']).map((b) => `github.ref == 'refs/heads/${b}'`).join(' || ')}) && github.event_name == 'push'`,
  steps: [dispatchAlignmentStep({ targetRepo: opts.targetRepo })],
})

// =============================================================================
// Vercel Deploy Helpers
// =============================================================================

/**
 * Deploy a single Vercel project via devenv task.
 * Prod on push-to-main/schedule/dispatch, preview on PRs.
 * Captures final/raw deploy URLs plus deploy completion time and exports them
 * to both GITHUB_ENV and GITHUB_OUTPUT.
 */
export const vercelDeployStep = (project: { name: string; urlEnvKey?: string }) =>
  buildVercelDeployStep(project, runDevenvTasksBefore)

/**
 * Configure git author so Vercel Deployment Protection
 * associates the deploy with a team member.
 */
export const vercelGitAuthorStep = (opts: { name: string; email: string }) => ({
  name: 'Configure git author for Vercel',
  shell: 'bash' as const,
  run: [
    `git config user.name "${opts.name}"`,
    `git config user.email "${opts.email}"`,
    'git commit --amend --no-edit --reset-author',
  ].join('\n'),
})

/**
 * Generate Vercel deploy jobs and optionally a combined comment collector job.
 *
 * Returns a flat record of GitHub Actions jobs:
 * - `deploy-<name>` — one per project, runs `vercelDeployStep`, exposes structured deploy metadata
 * - `post-deploy-comment` — optional lightweight job that collects URLs from all
 *   deploy jobs and posts a stateful deploy preview comment
 *
 * The helper is deployment-mode agnostic. The unified `vercel.nix` task module
 * decides whether a project runs build mode or static mode based on `cwd` vs
 * `staticDir`; CI only needs to invoke `vercel:deploy:<name>`.
 */
export const vercelDeployJobs = (opts: {
  projects: readonly VercelProject[]
  /** CI job names that deploy jobs depend on */
  needs?: readonly string[]
  runner: readonly string[]
  baseSteps: readonly Record<string, unknown>[]
  env: Record<string, string>
  /** Extra steps to add after deploy */
  extraSteps?: readonly Record<string, unknown>[]
  /** Deploy condition override. Default: always after CI passes, or directly on schedule. */
  deployCondition?: string
  /** Whether to add a combined deploy comment job. Default: true. */
  includeComment?: boolean
  commentTitle?: string
  noRecordsMessage?: string
  deployStepDecorator?: (
    step: Record<string, unknown>,
    project: VercelProject,
  ) => Record<string, unknown>
}): Record<string, Record<string, unknown>> => {
  return buildVercelDeployJobs({
    ...opts,
    runDevenvTasksBefore,
    deployModeScript,
    deployCommentPermissions,
    bashShellDefaults,
    commentRunner: linuxX64Runner,
  })
}

// =============================================================================
// Netlify Deploy Helpers
// =============================================================================

/**
 * Deploy step for Netlify storybooks via devenv tasks.
 * Runs `netlify:deploy` with prod/PR mode based on the event trigger.
 * Gracefully skips if NETLIFY_AUTH_TOKEN is not available.
 */
export const netlifyDeployStep = () => buildNetlifyDeployStep(runDevenvTasksBefore)
