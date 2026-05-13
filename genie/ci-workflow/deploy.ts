import {
  netlifyDeployStep as buildNetlifyDeployStep,
  netlifyStorybookCommentStep as buildNetlifyStorybookCommentStep,
} from '../deploy-preview/netlify.ts'
import {
  type VercelProject,
  vercelDeployJobs as buildVercelDeployJobs,
  vercelDeployStep as buildVercelDeployStep,
} from '../deploy-preview/vercel.ts'
import {
  bashShellDefaults,
  linuxX64Runner,
  runDevenvTasksBefore,
  shellSingleQuote,
} from './shared.ts'

/** Job-level permissions required by `deployCommentStep` to post/edit PR comments. */
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
 * Reusable step that writes a deployment summary and upserts a PR comment.
 *
 * The consuming job must include `permissions: deployCommentPermissions` (or equivalent)
 * so that `github.token` can read/write PR comments.
 *
 * The provided scripts run in order and must:
 * - `modeScript`: set `label` (or `exit 0` for unsupported events)
 * - `rowsScript`: set `rows` as markdown table rows (`| a | b |\n`)
 */
export const deployCommentStep = (opts: {
  summaryTitle: string
  tableHeaders: readonly [string, string]
  modeScript: string
  rowsScript: string
  noRowsMessage: string
  commentTitle?: string
  if?: string
}) => ({
  name: 'Post deploy URLs',
  if: opts.if ?? 'always() && !cancelled()',
  shell: 'bash' as const,
  env: {
    GH_TOKEN: '${{ github.token }}',
    GH_REPO: '${{ github.repository }}',
  },
  run: [
    opts.modeScript,
    '',
    opts.rowsScript,
    '',
    'if [ -z "$rows" ]; then',
    `  echo "${opts.noRowsMessage}" >> "$GITHUB_STEP_SUMMARY"`,
    '  exit 0',
    'fi',
    '',
    '# Write job summary',
    '{',
    `  echo "## ${opts.summaryTitle} ($label)"`,
    '  echo ""',
    `  echo "| ${opts.tableHeaders[0]} | ${opts.tableHeaders[1]} |"`,
    '  echo "| --- | --- |"',
    '  echo -e "$rows"',
    '} >> "$GITHUB_STEP_SUMMARY"',
    '',
    '# Post/update PR comment',
    'if [ "${{ github.event_name }}" = "pull_request" ]; then',
    '  {',
    `    echo "## ${opts.commentTitle ?? opts.summaryTitle}"`,
    '    echo ""',
    `    echo "| ${opts.tableHeaders[0]} | ${opts.tableHeaders[1]} |"`,
    '    echo "| --- | --- |"',
    '    echo -e "$rows"',
    '  } > /tmp/comment.md',
    '  export NIX_CONFIG="${NIX_CONFIG:+$NIX_CONFIG$\'\\n\'}access-tokens = github.com=${GH_TOKEN}"',
    '  nix run nixpkgs#gh -- pr comment "${{ github.event.pull_request.number }}" --body-file /tmp/comment.md --edit-last 2>/dev/null \\',
    '    || nix run nixpkgs#gh -- pr comment "${{ github.event.pull_request.number }}" --body-file /tmp/comment.md',
    'fi',
  ].join('\n'),
})

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
  noRowsMessage?: string
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

/**
 * Combined deploy comment step for Netlify storybook previews.
 *
 * When `packages` is provided, constructs preview URLs directly from the known package list.
 * This works regardless of whether the deploy task emits metadata markers, making it suitable
 * for repos that pin an older effect-utils version for Nix while using the latest for genie.
 *
 * When omitted, uses the metadata-based approach that reads deploy output from the deploy step.
 *
 * The `packages` shape matches the Nix `taskModules.netlify` / `taskModules.storybook` config:
 * `{ path: "flakes/oi", name: "flakes-oi" }` where `name` is the Netlify deploy alias.
 */
export const netlifyStorybookCommentStep = (
  site: string,
  opts?: { packages?: ReadonlyArray<{ path: string; name: string }> },
) => {
  if (!opts?.packages) {
    return buildNetlifyStorybookCommentStep(site, deployModeScript)
  }

  return deployCommentStep({
    summaryTitle: 'Storybook Previews',
    tableHeaders: ['Package', 'URL'],
    noRowsMessage: 'No storybooks were deployed.',
    modeScript: [
      `site="${site}"`,
      deployModeScript,
      '# Set Netlify branch-deploy suffix based on mode',
      'if [ "$label" = "prod" ]; then suffix=""; else suffix="-pr-${{ github.event.pull_request.number }}"; fi',
    ].join('\n'),
    rowsScript: [
      'rows=""',
      ...opts.packages.map((pkg) =>
        [
          `if [ -d "${pkg.path}/storybook-static" ]; then`,
          `  rows="\${rows}| ${pkg.name} | https://${pkg.name}\${suffix}--\${site}.netlify.app |\\n"`,
          'fi',
        ].join('\n'),
      ),
    ].join('\n'),
  })
}
