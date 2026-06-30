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
    'if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then',
    `  ${runDevenvTasksBefore('netlify:deploy', '--show-output', '--input', 'type=prod', '--input', 'missingAuthPolicy=skip', '--input', 'urlEnvKey=NETLIFY_DEPLOY_URL_STORYBOOK')}`,
    'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
    `  ${runDevenvTasksBefore('netlify:deploy', '--show-output', '--input', 'type=pr', '--input', 'pr=${{ github.event.pull_request.number }}', '--input', 'missingAuthPolicy=skip', '--input', 'urlEnvKey=NETLIFY_DEPLOY_URL_STORYBOOK')}`,
    'fi',
    'if [ ! -s "$workflow_report_path" ]; then',
    '  echo "Error: ci-tools did not emit a Netlify workflow report record." >&2',
    '  exit 1',
    'fi',
  ].join('\n'),
})
