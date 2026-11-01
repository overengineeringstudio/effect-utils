import {
  ciWorkflow,
  type CiWorkflowArgs,
  netlifyPreviewDeployConcurrency,
  netlifyPreviewDeployJobs,
  netlifyPreviewDeployTrigger,
} from '../../genie/ci-workflow.ts'
import { effectUtilsWorkflowPolicy } from '../../genie/ci-workflow/policy.ts'
import { linuxX64Runner } from '../../genie/ci-workflow/runners.ts'
import {
  storybookPreviewBuildWorkflowName,
  storybookPreviewRunner,
  storybookPreviewSetupSteps,
} from '../../genie/storybook-preview.ts'
import { sameRepoPullRequestGuard } from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'

const previewJobs = netlifyPreviewDeployJobs({
  runsOn: {
    resolvePreview: linuxX64Runner,
    // Both jobs run storybookPreviewSetupSteps, including the Cachix Nix build.
    deployPreview: storybookPreviewRunner('always'),
    publishPreviewComment: storybookPreviewRunner('always'),
  },
  setupSteps: storybookPreviewSetupSteps('always'),
  netlifyAuthToken: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
  title: 'Storybook Previews',
  noRecordsMessage: 'No storybooks were deployed.',
  stateId: 'storybook-preview',
})

// Trusted half of the Storybook preview split. Runs from the default branch on
// `workflow_run`, so it only takes effect once merged to `main`.
// oxlint-disable-next-line overeng/exports-first -- generated entrypoint
export default ciWorkflow({
  policy: effectUtilsWorkflowPolicy('storybook-preview-deploy.yml'),
  trustTier: 'public',
  name: 'Storybook Preview Deploy',
  on: netlifyPreviewDeployTrigger(storybookPreviewBuildWorkflowName),
  concurrency: netlifyPreviewDeployConcurrency,
  permissions: {},
  jobs: {
    ...previewJobs,
    'resolve-preview': {
      ...previewJobs['resolve-preview'],
      if: `\${{ (${sameRepoPullRequestGuard()}) && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'pull_request' }}`,
      steps: [
        {
          id: 'pull-request',
          name: 'Resolve pull request from the triggering run',
          shell:
            'nix shell nixpkgs#gh nixpkgs#jq --command bash --noprofile --norc -e -o pipefail {0}',
          env: {
            GH_TOKEN: '${{ github.token }}',
            RUN_HEAD_SHA: '${{ github.event.workflow_run.head_sha }}',
            RUN_HEAD_REPO: '${{ github.event.workflow_run.head_repository.full_name }}',
            RUN_PR_NUMBER: '${{ github.event.workflow_run.pull_requests[0].number }}',
          },
          run: [
            'set -euo pipefail',
            '[[ "$RUN_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]',
            'test "$RUN_HEAD_REPO" = "$GITHUB_REPOSITORY"',
            'pr_number="$RUN_PR_NUMBER"',
            'if [ -z "$pr_number" ]; then',
            '  pr_number=$(gh api --paginate "/repos/$GITHUB_REPOSITORY/pulls?state=open&per_page=100" --slurp \\',
            '    | jq -r --arg repo "$RUN_HEAD_REPO" --arg sha "$RUN_HEAD_SHA" \\',
            '      \'[.[][] | select(.head.repo.full_name == $repo and .head.sha == $sha)] | if length == 1 then .[0].number else "" end\')',
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
            '{',
            '  echo "deploy=$deploy"',
            '  echo "number=$pr_number"',
            '  echo "head-sha=$RUN_HEAD_SHA"',
            '  echo "head-repo=$RUN_HEAD_REPO"',
            '} >> "$GITHUB_OUTPUT"',
          ].join('\n'),
        },
      ],
    },
  },
} satisfies CiWorkflowArgs)
