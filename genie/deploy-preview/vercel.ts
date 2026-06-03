import {
  workflowReportCollectorStep,
  workflowReportCommentBodyStep,
  workflowReportPublisherStep,
} from '../ci-workflow/reporting.ts'
import {
  deployTargetEnvSuffix,
  workflowReportKind,
  workflowReportMarker,
  workflowReportOutputName,
  workflowReportPathOutputName,
  workflowReportSchemaVersion,
} from './shared.ts'

type StepRecord = Record<string, unknown>

export type VercelProject = {
  name: string
  urlEnvKey?: string
  projectIdEnv: string
  label?: string
  stepsBeforeDeploy?: readonly StepRecord[]
}

export const vercelDeployStep = (
  project: { name: string; urlEnvKey?: string },
  runDevenvTasksBefore: (...tasks: [string, ...string[]]) => string,
) => {
  const envSuffix = deployTargetEnvSuffix(project.name)
  const urlEnvKey = project.urlEnvKey ?? `VERCEL_DEPLOY_URL_${envSuffix}`

  return {
    id: 'deploy',
    name: `Deploy ${project.name} to Vercel`,
    shell: 'bash' as const,
    run: [
      'if [ -z "${VERCEL_TOKEN:-}" ]; then',
      '  echo "::error::VERCEL_TOKEN is not set"',
      '  exit 1',
      'fi',
      'tmp_log="$(mktemp)"',
      'workflow_report_dir="${RUNNER_TEMP:-/tmp}/workflow-reports"',
      'mkdir -p "$workflow_report_dir"',
      `workflow_report_path="$(mktemp "$workflow_report_dir/vercel-${envSuffix}.XXXXXX.jsonl")"`,
      'export WORKFLOW_REPORT_OUTPUT_FILE="$workflow_report_path"',
      'if [ "${{ github.event_name }}" = "pull_request" ]; then',
      `  ${runDevenvTasksBefore(`vercel:deploy:${project.name}`, '--show-output', '--input', 'type=pr', '--input', 'pr=${{ github.event.pull_request.number }}')} 2>&1 | tee "$tmp_log"`,
      'else',
      `  ${runDevenvTasksBefore(`vercel:deploy:${project.name}`, '--show-output', '--input', 'type=prod')} 2>&1 | tee "$tmp_log"`,
      'fi',
      'deploy_exit=${PIPESTATUS[0]}',
      'if [ "$deploy_exit" -ne 0 ]; then exit "$deploy_exit"; fi',
      'workflow_report_json=""',
      'if [ -s "$workflow_report_path" ]; then',
      '  workflow_report_json="$(tail -n 1 "$workflow_report_path")"',
      'fi',
      'if [ -z "$workflow_report_json" ]; then',
      `  workflow_report_json=$(grep -F ${JSON.stringify(workflowReportMarker)} "$tmp_log" | sed 's/^.*${workflowReportMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}//' | tail -n 1 || true)`,
      'fi',
      'if [ -n "$workflow_report_json" ]; then',
      '  final_url=$(printf "%s" "$workflow_report_json" | jq -r \'.data.finalUrl // (.links[]? | select(.primary == true) | .url) // empty\' | head -n 1)',
      '  raw_deploy_url=$(printf "%s" "$workflow_report_json" | jq -r \'.data.rawDeployUrl // empty\')',
      '  deployed_at_utc=$(printf "%s" "$workflow_report_json" | jq -r \'.data.deployedAtUtc // .createdAtUtc // empty\')',
      'else',
      '  final_url=""',
      '  raw_deploy_url=""',
      '  deployed_at_utc=""',
      'fi',
      'if [ -z "$final_url" ]; then',
      `  final_url=$(grep -Eo 'Vercel deploy URL: https://[^[:space:]"]+' "$tmp_log" | sed 's/^Vercel deploy URL: //' | tail -n 1 || true)`,
      'fi',
      'if [ -z "$final_url" ]; then',
      `  final_url=$(grep -oE 'https://[^[:space:]"]+' "$tmp_log" | grep -E 'vercel\\.(app|com)' | tail -n 1 || true)`,
      'fi',
      'if [ -z "$raw_deploy_url" ]; then',
      '  raw_deploy_url="$final_url"',
      'fi',
      'if [ -z "$deployed_at_utc" ]; then',
      '  deployed_at_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
      'fi',
      'if [ -z "$workflow_report_json" ] && [ -n "$final_url" ]; then',
      '  workflow_report_json="$(jq -cn \\',
      `    --argjson schemaVersion ${workflowReportSchemaVersion} \\`,
      '    --arg tag WorkflowReportRecord \\',
      `    --arg id ${JSON.stringify(`deploy-vercel-${project.name}`)} \\`,
      `    --arg kind ${JSON.stringify(workflowReportKind)} \\`,
      '    --arg status success \\',
      '    --arg provider vercel \\',
      `    --arg target ${JSON.stringify(project.name)} \\`,
      `    --arg displayName ${JSON.stringify(project.name)} \\`,
      '    --arg rawDeployUrl "$raw_deploy_url" \\',
      '    --arg finalUrl "$final_url" \\',
      '    --arg deployedAtUtc "$deployed_at_utc" \\',
      '    \'{_tag: $tag, schemaVersion: $schemaVersion, id: $id, kind: $kind, subject: {id: $target, label: $displayName}, status: $status, title: ($displayName + " preview deployed"), summary: "Preview is ready", createdAtUtc: $deployedAtUtc, links: [{label: "Preview", url: $finalUrl, primary: true}], data: {provider: $provider, target: $target, displayName: $displayName, rawDeployUrl: $rawDeployUrl, finalUrl: $finalUrl, deployedAtUtc: $deployedAtUtc}}\')"',
      'fi',
      'if [ -z "$workflow_report_json" ]; then',
      '  workflow_report_json="$(jq -cn \\',
      `    --argjson schemaVersion ${workflowReportSchemaVersion} \\`,
      '    --arg tag WorkflowReportRecord \\',
      `    --arg id ${JSON.stringify(`deploy-vercel-${project.name}`)} \\`,
      `    --arg kind ${JSON.stringify(workflowReportKind)} \\`,
      '    --arg status skipped \\',
      '    --arg provider vercel \\',
      `    --arg target ${JSON.stringify(project.name)} \\`,
      `    --arg displayName ${JSON.stringify(project.name)} \\`,
      '    --arg deployedAtUtc "$deployed_at_utc" \\',
      '    --arg message "No Vercel deploy URL detected." \\',
      '    \'{_tag: $tag, schemaVersion: $schemaVersion, id: $id, kind: $kind, subject: {id: $target, label: $displayName}, status: $status, title: ($displayName + " preview not deployed"), summary: $message, createdAtUtc: $deployedAtUtc, data: {provider: $provider, target: $target, displayName: $displayName, reason: $message}}\')"',
      'fi',
      'workflow_report_json="$(printf "%s" "$workflow_report_json" | jq -c \'.\')"',
      'printf "%s\\n" "$workflow_report_json" > "$workflow_report_path"',
      `echo "${workflowReportMarker}$workflow_report_json"`,
      'if [ -n "$final_url" ]; then',
      `  echo "${urlEnvKey}=$final_url" >> "$GITHUB_ENV"`,
      '  echo "final_url=$final_url" >> "$GITHUB_OUTPUT"',
      '  echo "deploy_url=$final_url" >> "$GITHUB_OUTPUT"',
      'fi',
      'if [ -n "$raw_deploy_url" ]; then',
      '  echo "raw_deploy_url=$raw_deploy_url" >> "$GITHUB_OUTPUT"',
      'fi',
      'echo "deployed_at_utc=$deployed_at_utc" >> "$GITHUB_OUTPUT"',
      `echo "${workflowReportPathOutputName}=$workflow_report_path" >> "$GITHUB_OUTPUT"`,
      `printf '${workflowReportOutputName}=%s\\n' "$workflow_report_json" >> "$GITHUB_OUTPUT"`,
      'rm -f "$tmp_log"',
    ].join('\n'),
  }
}

const vercelDeployReportSteps = (opts: {
  commentTitle: string
  noRecordsMessage: string
  projects: readonly Pick<VercelProject, 'name' | 'label'>[]
  workflowReportFlakeRef?: string
}): readonly StepRecord[] => {
  const bundlePath = '${{ runner.temp }}/workflow-reports/deploy-preview-bundle.json'
  const commentBodyPath = '${{ runner.temp }}/workflow-reports/deploy-preview-comment.md'
  const summaryPath = '${{ runner.temp }}/workflow-reports/deploy-preview-summary.md'
  const ifPredicate =
    "${{ github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main') }}"

  return [
    workflowReportCollectorStep({
      bundleId: 'deploy-preview',
      inputPaths: opts.projects.map(
        (project) => `\${{ needs.deploy-${project.name}.outputs.${workflowReportPathOutputName} }}`,
      ),
      outputPath: bundlePath,
      marker: workflowReportMarker,
      allowMissingInput: true,
      workflowReportFlakeRef: opts.workflowReportFlakeRef,
      if: ifPredicate,
    }),
    workflowReportCommentBodyStep({
      bundlePath,
      commentBodyPath,
      summaryPath,
      title: opts.commentTitle,
      noRecordsMessage: opts.noRecordsMessage,
      stateId: 'deploy-preview',
      entryId:
        "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
      entryLabel:
        "${{ github.event_name == 'pull_request' && format('PR {0}', github.event.pull_request.number) || 'prod' }}",
      timeZone: 'Europe/Berlin',
      workflowReportFlakeRef: opts.workflowReportFlakeRef,
      if: ifPredicate,
    }),
    workflowReportPublisherStep({
      commentBodyPath,
      summaryPath,
      stateId: 'deploy-preview',
      workflowReportFlakeRef: opts.workflowReportFlakeRef,
      if: ifPredicate,
    }),
  ]
}

export const vercelDeployJobs = (opts: {
  projects: readonly VercelProject[]
  needs?: readonly string[]
  runner: readonly string[]
  baseSteps: readonly StepRecord[]
  env: Record<string, string>
  extraSteps?: readonly StepRecord[]
  deployCondition?: string
  includeComment?: boolean
  commentTitle?: string
  noRecordsMessage?: string
  runDevenvTasksBefore: (...tasks: [string, ...string[]]) => string
  deployCommentPermissions: Record<string, string>
  bashShellDefaults: { run: { shell: string } }
  commentRunner: readonly string[]
  workflowReportFlakeRef?: string
  deployStepDecorator?: (step: StepRecord, project: VercelProject) => StepRecord
}) => {
  const deployCondition =
    opts.deployCondition ??
    [
      'always()',
      `(github.event_name == 'schedule' || (${(opts.needs ?? []).map((j) => `needs.${j}.result == 'success'`).join(' && ')}))`,
    ].join(' && ')

  const deployJobNames = opts.projects.map((p) => `deploy-${p.name}`)

  const deployJobs = Object.fromEntries(
    opts.projects.map((project) => [
      `deploy-${project.name}`,
      {
        ...(opts.needs !== undefined && opts.needs.length > 0 ? { needs: [...opts.needs] } : {}),
        if: deployCondition,
        'runs-on': [...opts.runner],
        defaults: opts.bashShellDefaults,
        outputs: {
          final_url: '${{ steps.deploy.outputs.final_url }}',
          raw_deploy_url: '${{ steps.deploy.outputs.raw_deploy_url }}',
          deployed_at_utc: '${{ steps.deploy.outputs.deployed_at_utc }}',
          deploy_url: '${{ steps.deploy.outputs.deploy_url }}',
          [workflowReportOutputName]: `\${{ steps.deploy.outputs.${workflowReportOutputName} }}`,
          [workflowReportPathOutputName]: `\${{ steps.deploy.outputs.${workflowReportPathOutputName} }}`,
        },
        env: {
          ...opts.env,
          [project.projectIdEnv]:
            opts.env[project.projectIdEnv] ?? `\${{ secrets.${project.projectIdEnv} }}`,
        },
        steps: [
          ...opts.baseSteps,
          ...(project.stepsBeforeDeploy ?? []),
          opts.deployStepDecorator?.(
            vercelDeployStep(project, opts.runDevenvTasksBefore),
            project,
          ) ?? vercelDeployStep(project, opts.runDevenvTasksBefore),
          ...(opts.extraSteps ?? []),
        ],
      },
    ]),
  )

  if (opts.includeComment === false) {
    return deployJobs
  }

  const commentJob = {
    needs: deployJobNames,
    if: 'always() && !cancelled()',
    permissions: opts.deployCommentPermissions,
    'runs-on': [...opts.commentRunner],
    steps: [
      ...vercelDeployReportSteps({
        commentTitle: opts.commentTitle ?? 'Deploy Preview',
        projects: opts.projects,
        noRecordsMessage: opts.noRecordsMessage ?? 'No deploy URLs detected.',
        workflowReportFlakeRef: opts.workflowReportFlakeRef,
      }),
    ],
  }

  return {
    ...deployJobs,
    'post-deploy-comment': commentJob,
  }
}
