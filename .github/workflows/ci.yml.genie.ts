import { githubWorkflow, type GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { type CIJobName } from '../../genie/ci.ts'
import {
  RUNNER_PROFILES,
  type RunnerProfile,
  cachixStep,
  checkoutStep,
  devenvShellDefaults,
  installDevenvFromLockStep,
  installNixStep,
  standardCIEnv,
  namespaceRunner,
  validateNixStoreStep,
} from '../../genie/ci-workflow.ts'

const baseSteps = [
  checkoutStep(),
  installNixStep(),
  cachixStep({ name: 'overeng-effect-utils', authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}' }),
  installDevenvFromLockStep,
  validateNixStoreStep,
] as const

const failureReminderStep = {
  name: 'Failure note',
  if: 'failure()',
  shell: 'bash',
  run: [
    'echo "If this looks like Namespace macOS Nix store corruption (e.g. \\"... is not valid\\", \\"config.cachix\\", \\"cachix.package\\"), add the run link + full nix-store output to:"',
    'echo "  https://github.com/overengineeringstudio/effect-utils/issues/201"',
  ].join('\n'),
} as const

const job = (step: { name: string; run: string }) => ({
  'runs-on': namespaceRunner('namespace-profile-linux-x86-64', '${{ github.run_id }}'),
  defaults: devenvShellDefaults,
  env: standardCIEnv,
  steps: [...baseSteps, step, failureReminderStep],
})

const multiPlatformJob = (step: { name: string; run: string }) => ({
  strategy: {
    'fail-fast': false,
    matrix: {
      runner: [...RUNNER_PROFILES],
    },
  },
  'runs-on': namespaceRunner('${{ matrix.runner }}' as RunnerProfile, '${{ github.run_id }}'),
  defaults: devenvShellDefaults,
  env: standardCIEnv,
  steps: [...baseSteps, step, failureReminderStep],
})

// Jobs keyed by CIJobName for type safety with required status checks
const jobs: Record<CIJobName, ReturnType<typeof job> | ReturnType<typeof multiPlatformJob>> = {
  typecheck: job({
    name: 'Type check',
    run: 'dt ts:check',
  }),
  lint: job({
    name: 'Format + lint',
    run: 'dt lint:check',
  }),
  test: multiPlatformJob({
    name: 'Unit tests',
    run: 'dt test:run',
  }),
  // Verify Nix hashes are up-to-date (pnpmDepsHash + localDeps)
  // This catches stale hashes before they break downstream consumers
  'nix-check': multiPlatformJob({
    name: 'Nix hash check',
    run: 'dt nix:check',
  }),
}

const NETLIFY_SITE = 'overeng-utils'

// Deploy job — NOT a required status check (separate from CIJobName)
const deployJobs = {
  'deploy-storybooks': {
    'runs-on': namespaceRunner('namespace-profile-linux-x86-64', '${{ github.run_id }}'),
    // No `needs` — run in parallel with other jobs for faster feedback
    permissions: {
      contents: 'read',
      'pull-requests': 'write',
    },
    defaults: devenvShellDefaults,
    env: {
      ...standardCIEnv,
      NETLIFY_AUTH_TOKEN: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
    },
    steps: [
      ...baseSteps,
      {
        name: 'Deploy storybooks to Netlify',
        run: [
          'if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then',
          '  dt netlify:deploy --input type=prod',
          'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
          '  dt netlify:deploy --input type=pr --input pr=${{ github.event.pull_request.number }}',
          'fi',
        ].join('\n'),
      },
      {
        name: 'Post deploy URLs',
        if: "always() && !cancelled()",
        shell: 'bash',
        env: {
          GH_TOKEN: '${{ github.token }}',
        },
        run: [
          `site="${NETLIFY_SITE}"`,
          'if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then',
          '  suffix=""',
          '  label="prod"',
          'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
          '  suffix="-pr-${{ github.event.pull_request.number }}"',
          '  label="PR #${{ github.event.pull_request.number }}"',
          'else',
          '  exit 0',
          'fi',
          '',
          '# Collect deployed storybooks by checking for build output',
          'rows=""',
          'for dir in packages/@overeng/*/storybook-static; do',
          '  [ -d "$dir" ] || continue',
          '  name="${dir#packages/@overeng/}"',
          '  name="${name%/storybook-static}"',
          '  url="https://${name}${suffix}--${site}.netlify.app"',
          '  rows="${rows}| ${name} | ${url} |\\n"',
          'done',
          '',
          'if [ -z "$rows" ]; then',
          '  echo "No storybooks were deployed." >> "$GITHUB_STEP_SUMMARY"',
          '  exit 0',
          'fi',
          '',
          '# Write job summary',
          '{',
          '  echo "## Storybook Previews (${label})"',
          '  echo ""',
          '  echo "| Package | URL |"',
          '  echo "| --- | --- |"',
          '  echo -e "$rows"',
          '} >> "$GITHUB_STEP_SUMMARY"',
          '',
          '# Post/update PR comment',
          'if [ "${{ github.event_name }}" = "pull_request" ]; then',
          '  {',
          '    echo "## Storybook Previews"',
          '    echo ""',
          '    echo "| Package | URL |"',
          '    echo "| --- | --- |"',
          '    echo -e "$rows"',
          '  } > /tmp/comment.md',
          '  gh pr comment "${{ github.event.pull_request.number }}" --body-file /tmp/comment.md --edit-last 2>/dev/null \\',
          '    || gh pr comment "${{ github.event.pull_request.number }}" --body-file /tmp/comment.md',
          'fi',
        ].join('\n'),
      },
    ],
  },
} as const

export default githubWorkflow({
  name: 'CI',
  on: {
    push: { branches: ['main'] },
    pull_request: { branches: ['main'] },
  },
  jobs: { ...jobs, ...deployJobs },
} satisfies GitHubWorkflowArgs)
