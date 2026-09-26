type RunTasksBefore = (...tasks: [string, ...string[]]) => string

const netlifyDeployTaskArgs = [
  '--input',
  'missingAuthPolicy=skip',
  '--input',
  'urlEnvKey=NETLIFY_DEPLOY_URL_STORYBOOK',
] as const

const workflowReportPreamble = [
  'workflow_report_dir="${RUNNER_TEMP:-/tmp}/workflow-reports"',
  'mkdir -p "$workflow_report_dir"',
  'workflow_report_path="$(mktemp "$workflow_report_dir/netlify-storybooks.XXXXXX.jsonl")"',
  'export WORKFLOW_REPORT_OUTPUT_FILE="$workflow_report_path"',
]

const workflowReportPostamble = [
  'if [ "$deploy_ran" = "1" ] && [ ! -s "$workflow_report_path" ]; then',
  '  echo "Error: ci-tools did not emit a Netlify workflow report record." >&2',
  '  exit 1',
  'fi',
  'if [ "$deploy_ran" = "1" ]; then',
  '  echo "workflow_report_path=$workflow_report_path" >> "$GITHUB_OUTPUT"',
  'fi',
]

/**
 * Single-job build + deploy. Builds each target and deploys it with the
 * credentials present in the same job, so it must only run in a trusted
 * context (never on `pull_request` with secrets). Prefer the split
 * `netlifyStageStep` / `netlifyStagedPreviewDeployStep` pair for PR previews.
 */
export const netlifyDeployStep = (runDevenvTasksBefore: RunTasksBefore) => ({
  id: 'deploy',
  name: 'Deploy storybooks to Netlify',
  shell: 'bash' as const,
  run: [
    ...workflowReportPreamble,
    'deploy_ran=0',
    'if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then',
    '  deploy_ran=1',
    `  ${runDevenvTasksBefore('netlify:deploy', '--show-output', '--input', 'type=prod', ...netlifyDeployTaskArgs)}`,
    'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
    '  deploy_ran=1',
    `  ${runDevenvTasksBefore('netlify:deploy', '--show-output', '--input', 'type=pr', '--input', 'pr=${{ github.event.pull_request.number }}', ...netlifyDeployTaskArgs)}`,
    'fi',
    ...workflowReportPostamble,
  ].join('\n'),
})

/**
 * Uncredentialed half of the split build/deploy: builds every configured
 * Netlify target and copies its static output to `<stageDir>/<target>/`.
 * The caller uploads `stageDir` as an artifact; nothing here needs secrets.
 */
export const netlifyStageStep = (
  runDevenvTasksBefore: RunTasksBefore,
  opts: { readonly stageDir: string },
) => ({
  id: 'stage',
  name: 'Build and stage Netlify static output',
  shell: 'bash' as const,
  env: { NETLIFY_STAGE_DIR: opts.stageDir },
  run: runDevenvTasksBefore(
    'netlify:stage',
    '--show-output',
    '--input',
    '"stageDir=$NETLIFY_STAGE_DIR"',
  ),
})

/**
 * Credentialed half of the split build/deploy: deploys the already-staged
 * static output in `stageDir` as the preview for `prNumber` without building.
 * `stageDir` is untrusted data; the task only hands it to `netlify deploy
 * --no-build`. `prNumber` must come from the trusted event payload.
 */
export const netlifyStagedPreviewDeployStep = (
  runDevenvTasksBefore: RunTasksBefore,
  opts: { readonly stageDir: string; readonly prNumber: string },
) => ({
  id: 'deploy',
  name: 'Deploy staged storybook previews to Netlify',
  shell: 'bash' as const,
  env: { NETLIFY_STAGE_DIR: opts.stageDir, NETLIFY_PREVIEW_PR: opts.prNumber },
  run: [
    ...workflowReportPreamble,
    'deploy_ran=1',
    runDevenvTasksBefore(
      'netlify:deploy-staged',
      '--show-output',
      '--input',
      'type=pr',
      '--input',
      '"pr=$NETLIFY_PREVIEW_PR"',
      '--input',
      '"stageDir=$NETLIFY_STAGE_DIR"',
      ...netlifyDeployTaskArgs,
    ),
    ...workflowReportPostamble,
  ].join('\n'),
})
