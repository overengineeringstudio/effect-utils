import {
  RUNNER_PROFILES,
  type RunnerProfile,
  bashShellDefaults,
  cachixStep,
  checkoutStep,
  preparePinnedDevenvStep,
  installNixStep,
  runDevenvTasksBefore,
  standardCIEnv,
  namespaceRunner,
  validateNixStoreStep,
} from '../../genie/ci-workflow.ts'
import { type CIJobName } from '../../genie/ci.ts'
import {
  githubWorkflow,
  type GitHubWorkflowArgs,
} from '../../packages/@overeng/genie/src/runtime/mod.ts'

const baseSteps = [
  checkoutStep(),
  installNixStep(),
  cachixStep({ name: 'overeng-effect-utils', authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}' }),
  preparePinnedDevenvStep,
  validateNixStoreStep,
] as const

const failureReminderStep = {
  name: 'Failure note',
  if: 'failure()',
  shell: 'bash',
  run: [
    'echo "If this looks like Namespace runner Nix store corruption (e.g. \\"... is not valid\\", \\"config.cachix\\", \\"cachix.package\\"), add the run link + full nix-store output to:"',
    'echo "  https://github.com/overengineeringstudio/effect-utils/issues/201"',
  ].join('\n'),
} as const

/**
 * Temporary diagnostics summary for #272.
 * Remove once #201/#272 are root-caused and we can return to a minimal CI flow.
 */
const nixDiagnosticsSummaryStep = {
  name: 'Nix diagnostics summary',
  if: 'failure()',
  shell: 'bash',
  run: [
    'diag_dir="${NIX_STORE_DIAGNOSTICS_DIR:-}"',
    'if [ -z "$diag_dir" ] || [ ! -d "$diag_dir" ]; then',
    '  echo "## Nix Store Diagnostics" >> "$GITHUB_STEP_SUMMARY"',
    '  echo "" >> "$GITHUB_STEP_SUMMARY"',
    '  echo "No diagnostics directory found (validation may have failed before capture)." >> "$GITHUB_STEP_SUMMARY"',
    '  exit 0',
    'fi',
    '',
    '{',
    '  echo "## Nix Store Diagnostics"',
    '  echo ""',
    '  echo "Temporary instrumentation for #272; remove after root cause is confirmed and CI is stable."',
    '  echo ""',
    '  echo "- Diagnostics directory: `$diag_dir`"',
    '  echo "- Tracking issue: https://github.com/overengineeringstudio/effect-utils/issues/272"',
    '} >> "$GITHUB_STEP_SUMMARY"',
    '',
    'markers_file="$diag_dir/signature-markers.txt"',
    'grep -R -n -E "config\\\\.cachix|cachix\\\\.package|error: path \'/nix/store/.+ is not valid" "$diag_dir" > "$markers_file" || true',
    '',
    'if [ -s "$markers_file" ]; then',
    '  {',
    '    echo ""',
    '    echo "### Signature markers"',
    '    echo "```text"',
    '    sed -n "1,120p" "$markers_file"',
    '    echo "```"',
    '  } >> "$GITHUB_STEP_SUMMARY"',
    'else',
    '  echo "" >> "$GITHUB_STEP_SUMMARY"',
    '  echo "- No signature markers found in captured diagnostics." >> "$GITHUB_STEP_SUMMARY"',
    'fi',
  ].join('\n'),
} as const

/**
 * Temporary artifact upload for #272 root-cause analysis.
 * Remove together with `nixDiagnosticsSummaryStep` after the issue class is resolved.
 */
const nixDiagnosticsArtifactStep = {
  name: 'Upload Nix diagnostics artifact',
  if: "failure() && env.NIX_STORE_DIAGNOSTICS_DIR != ''",
  uses: 'actions/upload-artifact@v4',
  with: {
    name: 'nix-store-diagnostics-${{ github.job }}-${{ runner.os }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}',
    path: '${{ env.NIX_STORE_DIAGNOSTICS_DIR }}',
    'if-no-files-found': 'ignore',
    'retention-days': 14,
  },
} as const

const job = (step: { name: string; run: string }) => ({
  'runs-on': namespaceRunner('namespace-profile-linux-x86-64', '${{ github.run_id }}'),
  defaults: bashShellDefaults,
  env: standardCIEnv,
  steps: [
    ...baseSteps,
    step,
    nixDiagnosticsSummaryStep,
    nixDiagnosticsArtifactStep,
    failureReminderStep,
  ],
})

const multiPlatformJob = (step: { name: string; run: string }) => ({
  strategy: {
    'fail-fast': false,
    matrix: {
      runner: [...RUNNER_PROFILES],
    },
  },
  'runs-on': namespaceRunner('${{ matrix.runner }}' as RunnerProfile, '${{ github.run_id }}'),
  defaults: bashShellDefaults,
  env: standardCIEnv,
  steps: [
    ...baseSteps,
    step,
    nixDiagnosticsSummaryStep,
    nixDiagnosticsArtifactStep,
    failureReminderStep,
  ],
})

// Jobs keyed by CIJobName for type safety with required status checks
const jobs: Record<CIJobName, ReturnType<typeof job> | ReturnType<typeof multiPlatformJob>> = {
  typecheck: job({
    name: 'Type check',
    run: runDevenvTasksBefore('ts:check'),
  }),
  lint: job({
    name: 'Format + lint',
    run: runDevenvTasksBefore('lint:check'),
  }),
  test: multiPlatformJob({
    name: 'Unit tests',
    run: runDevenvTasksBefore('test:run'),
  }),
  // Verify Nix hashes are up-to-date (pnpmDepsHash + localDeps)
  // This catches stale hashes before they break downstream consumers
  'nix-check': multiPlatformJob({
    name: 'Nix hash check',
    run: runDevenvTasksBefore('nix:check'),
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
    defaults: bashShellDefaults,
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
          `  ${runDevenvTasksBefore('netlify:deploy', '--input', 'type=prod')}`,
          'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
          `  ${runDevenvTasksBefore('netlify:deploy', '--input', 'type=pr', '--input', 'pr=${{ github.event.pull_request.number }}')}`,
          'fi',
        ].join('\n'),
      },
      {
        name: 'Post deploy URLs',
        if: 'always() && !cancelled()',
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
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep,
      failureReminderStep,
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
