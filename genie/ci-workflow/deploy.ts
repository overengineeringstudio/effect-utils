import {
  netlifyDeployStep as buildNetlifyDeployStep,
  netlifyStagedPreviewDeployStep as buildNetlifyStagedPreviewDeployStep,
  netlifyStageStep as buildNetlifyStageStep,
} from '../deploy-preview/netlify.ts'
import { workflowReportPathOutputName } from '../deploy-preview/shared.ts'
import {
  type VercelProject,
  vercelDeployJobs as buildVercelDeployJobs,
  vercelDeployStep as buildVercelDeployStep,
} from '../deploy-preview/vercel.ts'
import {
  workflowReportCollectorStep,
  workflowReportCommentBodyStep,
  workflowReportPublisherStep,
} from './reporting.ts'
import {
  bashShellDefaults,
  githubTokenEnv,
  linuxX64Runner,
  runDevenvTasksBefore,
} from './shared.ts'

export {
  workflowReportOutputName as deployPreviewWorkflowReportOutputName,
  workflowReportPathOutputName as deployPreviewWorkflowReportPathOutputName,
} from '../deploy-preview/shared.ts'

/** Job-level permissions required by deploy preview helpers to post/edit PR comments. */
export const deployCommentPermissions = {
  contents: 'read',
  'pull-requests': 'write',
} as const

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
  if: `\${{ (${(opts.branches ?? ['main']).map((b) => `github.ref == 'refs/heads/${b}'`).join(' || ')}) && github.event_name == 'push' }}`,
  steps: [dispatchAlignmentStep({ targetRepo: opts.targetRepo })],
})

// =============================================================================
// Vercel Deploy Helpers
// =============================================================================

const withGithubTokenEnv = (
  step: Record<string, unknown>,
  tokenExpression?: string,
): Record<string, unknown> => {
  const env = (step.env as Record<string, string> | undefined) ?? {}
  return {
    ...step,
    env: {
      ...githubTokenEnv(tokenExpression),
      ...env,
    },
  }
}

/**
 * Deploy a single Vercel project via devenv task.
 * Prod on push-to-main/schedule/dispatch, preview on PRs.
 * Captures final/raw deploy URLs plus deploy completion time and exports them
 * to both GITHUB_ENV and GITHUB_OUTPUT.
 */
export const vercelDeployStep = (project: { name: string; urlEnvKey?: string }) =>
  withGithubTokenEnv(buildVercelDeployStep({ project, runDevenvTasksBefore }))

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
  const { GITHUB_TOKEN: tokenExpression, ...jobEnv } = opts.env
  const deployStepDecorator = (
    step: Record<string, unknown>,
    project: VercelProject,
  ): Record<string, unknown> =>
    withGithubTokenEnv(opts.deployStepDecorator?.(step, project) ?? step, tokenExpression)

  return buildVercelDeployJobs({
    ...opts,
    env: jobEnv,
    runDevenvTasksBefore,
    deployCommentPermissions,
    bashShellDefaults,
    commentRunner: linuxX64Runner,
    deployStepDecorator,
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
export const netlifyDeployStep = (env: Record<string, string> = {}) =>
  withGithubTokenEnv({
    ...buildNetlifyDeployStep(runDevenvTasksBefore),
    env,
  })

// =============================================================================
// Netlify Split Build/Deploy (PR previews)
// =============================================================================
//
// PR previews split into two trust zones:
//
// 1. An uncredentialed `pull_request` job runs `netlifyPreviewBuildSteps`: it
//    builds every Netlify target and uploads the static output as an artifact.
// 2. A `workflow_run` workflow on the default branch runs
//    `netlifyPreviewDeployJobs`: it resolves the PR from the triggering run's
//    event payload, deploys the artifact as static files with the Netlify
//    token, and posts the managed PR comment.
//
// The deploy side treats the artifact as data: it checks out only the
// default-branch revision for its tooling and never executes artifact content.

/** Artifact carrying `<stageDir>/<target>/` static output from build to deploy. */
export const netlifyPreviewArtifactName = 'netlify-preview-static'

const netlifyPreviewCommentArtifactName = 'netlify-preview-comment'
const netlifyPreviewStageDir = '${{ runner.temp }}/netlify-preview-stage'
const netlifyPreviewReportDir = '${{ runner.temp }}/workflow-reports/netlify-preview'
const netlifyPreviewBundlePath = `${netlifyPreviewReportDir}/bundle.json`
const netlifyPreviewCommentBodyPath = `${netlifyPreviewReportDir}/comment.md`
const netlifyPreviewSummaryPath = `${netlifyPreviewReportDir}/summary.md`

/**
 * Steps for the uncredentialed PR job: build + stage every Netlify target, then
 * upload the staged static output. Requires no secrets.
 */
export const netlifyPreviewBuildSteps = (opts: { readonly artifactName?: string } = {}) => [
  withGithubTokenEnv(
    buildNetlifyStageStep(runDevenvTasksBefore, { stageDir: netlifyPreviewStageDir }),
  ),
  {
    name: 'Upload staged Netlify output',
    uses: 'actions/upload-artifact@v4',
    with: {
      name: opts.artifactName ?? netlifyPreviewArtifactName,
      path: netlifyPreviewStageDir,
      'if-no-files-found': 'error',
      'retention-days': 3,
    },
  },
]

/** `on:` block for a deploy workflow triggered by the named PR build workflow. */
export const netlifyPreviewDeployTrigger = (buildWorkflowName: string) => ({
  workflow_run: { workflows: [buildWorkflowName], types: ['completed'] },
})

/** One deploy at a time per PR head; a newer build supersedes an older deploy. */
export const netlifyPreviewDeployConcurrency = {
  group:
    '${{ github.workflow }}-${{ github.event.workflow_run.head_repository.full_name }}-${{ github.event.workflow_run.head_branch }}',
  'cancel-in-progress': true,
} as const

/** Deploy only after a successful `pull_request` run of the build workflow. */
export const netlifyPreviewDeployIf =
  "${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'pull_request' }}"

/**
 * Resolves the pull request for a `workflow_run` event from the event payload
 * and the GitHub API only (never from artifact contents). Outputs `deploy`,
 * `number`, `head-sha`, and `head-repo`.
 *
 * Fork policy: fork PRs are resolved but not deployed (`deploy=false`), so no
 * fork-authored content is published under the repository's Netlify site. A
 * PR whose head moved past the triggering run is skipped as stale.
 */
const workflowRunPullRequestStep = {
  id: 'pull-request',
  name: 'Resolve pull request from the triggering run',
  shell: 'bash',
  env: {
    GH_TOKEN: '${{ github.token }}',
    RUN_EVENT: '${{ github.event.workflow_run.event }}',
    RUN_CONCLUSION: '${{ github.event.workflow_run.conclusion }}',
    RUN_HEAD_SHA: '${{ github.event.workflow_run.head_sha }}',
    RUN_HEAD_BRANCH: '${{ github.event.workflow_run.head_branch }}',
    RUN_HEAD_REPO: '${{ github.event.workflow_run.head_repository.full_name }}',
    RUN_PR_NUMBER: '${{ github.event.workflow_run.pull_requests[0].number }}',
  },
  run: [
    'set -euo pipefail',
    'test "$RUN_EVENT" = pull_request',
    'test "$RUN_CONCLUSION" = success',
    '[[ "$RUN_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]',
    'test -n "$RUN_HEAD_REPO"',
    'test -n "$RUN_HEAD_BRANCH"',
    'pr_number="$RUN_PR_NUMBER"',
    'if [ -z "$pr_number" ]; then',
    '  # `workflow_run.pull_requests` is empty for fork heads; match the open PR by head.',
    '  pr_number=$(gh api --paginate "/repos/$GITHUB_REPOSITORY/pulls?state=open&per_page=100" --slurp \\',
    '    | jq -r --arg repo "$RUN_HEAD_REPO" --arg ref "$RUN_HEAD_BRANCH" --arg sha "$RUN_HEAD_SHA" \\',
    '      \'[.[][] | select(.head.repo.full_name == $repo and .head.ref == $ref and .head.sha == $sha)] | if length == 1 then .[0].number else "" end\')',
    'fi',
    'deploy=true',
    'if [ -z "$pr_number" ]; then',
    '  echo "::notice::No open pull request matches $RUN_HEAD_REPO@$RUN_HEAD_SHA; skipping preview deploy"',
    '  deploy=false',
    'else',
    '  [[ "$pr_number" =~ ^[1-9][0-9]*$ ]]',
    '  pr_json=$(gh api "/repos/$GITHUB_REPOSITORY/pulls/$pr_number")',
    '  test "$(jq -r \'.head.repo.full_name\' <<<"$pr_json")" = "$RUN_HEAD_REPO"',
    '  if [ "$(jq -r \'.state\' <<<"$pr_json")" != open ] || [ "$(jq -r \'.head.sha\' <<<"$pr_json")" != "$RUN_HEAD_SHA" ]; then',
    '    echo "::notice::PR #$pr_number is closed or its head moved past $RUN_HEAD_SHA; skipping stale preview deploy"',
    '    deploy=false',
    '  fi',
    'fi',
    'if [ "$RUN_HEAD_REPO" != "$GITHUB_REPOSITORY" ]; then',
    '  echo "::notice::Fork pull request from $RUN_HEAD_REPO; fork previews are not deployed"',
    '  deploy=false',
    'fi',
    '{',
    '  echo "deploy=$deploy"',
    '  echo "number=$pr_number"',
    '  echo "head-sha=$RUN_HEAD_SHA"',
    '  echo "head-repo=$RUN_HEAD_REPO"',
    '} >> "$GITHUB_OUTPUT"',
  ].join('\n'),
} as const

const trustedDefaultBranchCheckoutStep = {
  name: 'Checkout default-branch tooling',
  uses: 'actions/checkout@v6',
  with: { ref: '${{ github.workflow_sha }}', 'persist-credentials': false },
} as const

/**
 * Jobs for the trusted `workflow_run` deploy workflow.
 *
 * - `resolve-preview`: payload/API-derived PR identity (`pull-requests: read`).
 * - `deploy-preview`: downloads the artifact (`actions: read`), deploys it with
 *   the Netlify token scoped to the deploy step env only, and renders the
 *   comment body.
 * - `publish-preview-comment`: the only job with `pull-requests: write`.
 *
 * `setupSteps` must not check out code: the helper checks out the
 * default-branch workflow revision itself.
 */
export const netlifyPreviewDeployJobs = (opts: {
  readonly runsOn: string | readonly string[]
  readonly setupSteps: readonly Record<string, unknown>[]
  /** Secret expression, e.g. `${{ secrets.NETLIFY_AUTH_TOKEN }}`. */
  readonly netlifyAuthToken: string
  readonly title: string
  readonly noRecordsMessage: string
  readonly stateId: string
  readonly artifactName?: string
  readonly timeoutMinutes?: number
}): Record<string, Record<string, unknown>> => {
  const pullRequest = {
    eventName: 'pull_request',
    number: '${{ needs.resolve-preview.outputs.number }}',
    headRepo: '${{ needs.resolve-preview.outputs.head-repo }}',
  }
  const timeoutMinutes = opts.timeoutMinutes ?? 30
  const deployStep = buildNetlifyStagedPreviewDeployStep(runDevenvTasksBefore, {
    stageDir: netlifyPreviewStageDir,
    prNumber: pullRequest.number,
  })
  return {
    'resolve-preview': {
      if: netlifyPreviewDeployIf,
      'runs-on': opts.runsOn,
      'timeout-minutes': 5,
      permissions: { 'pull-requests': 'read' },
      defaults: bashShellDefaults,
      outputs: {
        deploy: '${{ steps.pull-request.outputs.deploy }}',
        number: '${{ steps.pull-request.outputs.number }}',
        'head-sha': '${{ steps.pull-request.outputs.head-sha }}',
        'head-repo': '${{ steps.pull-request.outputs.head-repo }}',
      },
      steps: [workflowRunPullRequestStep],
    },
    'deploy-preview': {
      needs: ['resolve-preview'],
      if: "${{ needs.resolve-preview.outputs.deploy == 'true' }}",
      'runs-on': opts.runsOn,
      'timeout-minutes': timeoutMinutes,
      permissions: { actions: 'read', contents: 'read', 'pull-requests': 'read' },
      defaults: bashShellDefaults,
      steps: [
        trustedDefaultBranchCheckoutStep,
        ...opts.setupSteps,
        {
          name: 'Download staged Netlify output',
          uses: 'actions/download-artifact@v4',
          with: {
            name: opts.artifactName ?? netlifyPreviewArtifactName,
            path: netlifyPreviewStageDir,
            'run-id': '${{ github.event.workflow_run.id }}',
            'github-token': '${{ github.token }}',
          },
        },
        withGithubTokenEnv({
          ...deployStep,
          // The Netlify token exists only in this step's environment.
          env: { ...deployStep.env, NETLIFY_AUTH_TOKEN: opts.netlifyAuthToken },
        }),
        workflowReportCollectorStep({
          bundleId: opts.stateId,
          inputPaths: [`\${{ steps.deploy.outputs.${workflowReportPathOutputName} }}`],
          outputPath: netlifyPreviewBundlePath,
          allowMissingInput: true,
        }),
        workflowReportCommentBodyStep({
          bundlePath: netlifyPreviewBundlePath,
          commentBodyPath: netlifyPreviewCommentBodyPath,
          summaryPath: netlifyPreviewSummaryPath,
          title: opts.title,
          noRecordsMessage: opts.noRecordsMessage,
          stateId: opts.stateId,
          entryId: '${{ needs.resolve-preview.outputs.head-sha }}',
          entryLabel: "${{ format('PR {0}', needs.resolve-preview.outputs.number) }}",
          pullRequest,
        }),
        {
          name: 'Upload rendered preview comment',
          uses: 'actions/upload-artifact@v4',
          with: {
            name: netlifyPreviewCommentArtifactName,
            path: netlifyPreviewReportDir,
            'if-no-files-found': 'error',
            'retention-days': 1,
          },
        },
      ],
    },
    'publish-preview-comment': {
      needs: ['resolve-preview', 'deploy-preview'],
      'runs-on': opts.runsOn,
      'timeout-minutes': timeoutMinutes,
      permissions: deployCommentPermissions,
      defaults: bashShellDefaults,
      steps: [
        trustedDefaultBranchCheckoutStep,
        ...opts.setupSteps,
        {
          name: 'Download rendered preview comment',
          uses: 'actions/download-artifact@v4',
          with: { name: netlifyPreviewCommentArtifactName, path: netlifyPreviewReportDir },
        },
        workflowReportPublisherStep({
          commentBodyPath: netlifyPreviewCommentBodyPath,
          summaryPath: netlifyPreviewSummaryPath,
          stateId: opts.stateId,
          pullRequest,
        }),
      ],
    },
  }
}
