type RunTasksBefore = (...tasks: [string, ...string[]]) => string

export const netlifyDeployStep = (runDevenvTasksBefore: RunTasksBefore) => ({
  id: 'deploy',
  name: 'Deploy storybooks to Netlify',
  shell: 'bash' as const,
  run: [
    'workflow_report_dir="${RUNNER_TEMP:-/tmp}/workflow-reports"',
    'mkdir -p "$workflow_report_dir"',
    'workflow_report_path="$(mktemp "$workflow_report_dir/netlify-storybooks.XXXXXX.jsonl")"',
    'export WORKFLOW_REPORT_OUTPUT_FILE="$workflow_report_path"',
    'deploy_ran=0',
    'if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then',
    '  deploy_ran=1',
    `  ${runDevenvTasksBefore('netlify:deploy', '--show-output', '--input', 'type=prod', '--input', 'missingAuthPolicy=skip', '--input', 'urlEnvKey=NETLIFY_DEPLOY_URL_STORYBOOK')}`,
    'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
    '  deploy_ran=1',
    `  ${runDevenvTasksBefore('netlify:deploy', '--show-output', '--input', 'type=pr', '--input', 'pr=${{ github.event.pull_request.number }}', '--input', 'missingAuthPolicy=skip', '--input', 'unauthorizedPolicy=skip', '--input', 'urlEnvKey=NETLIFY_DEPLOY_URL_STORYBOOK')}`,
    'fi',
    'if [ "$deploy_ran" = "1" ] && [ ! -s "$workflow_report_path" ]; then',
    '  echo "Error: ci-tools did not emit a Netlify workflow report record." >&2',
    '  exit 1',
    'fi',
    'if [ "$deploy_ran" = "1" ]; then',
    '  echo "workflow_report_path=$workflow_report_path" >> "$GITHUB_OUTPUT"',
    'fi',
  ].join('\n'),
})
