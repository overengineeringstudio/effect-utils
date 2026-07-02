import {
  workflowReportCollectorStep,
  workflowReportCommentBodyStep,
  workflowReportPublisherStep,
} from '../ci-workflow/reporting.ts'
import {
  deployTargetEnvSuffix,
  workflowReportMarker,
  workflowReportOutputName,
  workflowReportPathOutputName,
} from './shared.ts'

type StepRecord = Record<string, unknown>

export type VercelProject = {
  name: string
  urlEnvKey?: string
  projectIdEnv: string
  label?: string
  stepsBeforeDeploy?: readonly StepRecord[]
}

export const vercelDeployStep = ({
  project,
  runDevenvTasksBefore,
}: {
  project: { name: string; urlEnvKey?: string }
  runDevenvTasksBefore: (...tasks: [string, ...string[]]) => string
}) => {
  const envSuffix = deployTargetEnvSuffix(project.name)
  const urlEnvKey = project.urlEnvKey ?? `VERCEL_DEPLOY_URL_${envSuffix}`

  return {
    id: 'deploy',
    name: `Deploy ${project.name} to Vercel`,
    shell: 'bash' as const,
    run: [
      'workflow_report_dir="${RUNNER_TEMP:-/tmp}/workflow-reports"',
      'mkdir -p "$workflow_report_dir"',
      `workflow_report_path="$(mktemp "$workflow_report_dir/vercel-${envSuffix}.XXXXXX.jsonl")"`,
      'export WORKFLOW_REPORT_OUTPUT_FILE="$workflow_report_path"',
      'if [ "${{ github.event_name }}" = "pull_request" ]; then',
      `  ${runDevenvTasksBefore(`vercel:deploy:${project.name}`, '--show-output', '--input', 'type=pr', '--input', 'pr=${{ github.event.pull_request.number }}', '--input', `urlEnvKey=${urlEnvKey}`)}`,
      'else',
      `  ${runDevenvTasksBefore(`vercel:deploy:${project.name}`, '--show-output', '--input', 'type=prod', '--input', `urlEnvKey=${urlEnvKey}`)}`,
      'fi',
      'if [ ! -s "$workflow_report_path" ]; then',
      '  echo "Error: ci-tools did not emit a Vercel workflow report record." >&2',
      '  exit 1',
      'fi',
      `echo "${workflowReportPathOutputName}=$workflow_report_path" >> "$GITHUB_OUTPUT"`,
    ].join('\n'),
  }
}

const vercelDeployReportSteps = (opts: {
  commentTitle: string
  noRecordsMessage: string
  projects: readonly Pick<VercelProject, 'name' | 'label'>[]
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
      if: ifPredicate,
    }),
    workflowReportPublisherStep({
      commentBodyPath,
      summaryPath,
      stateId: 'deploy-preview',
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
            vercelDeployStep({ project, runDevenvTasksBefore: opts.runDevenvTasksBefore }),
            project,
          ) ?? vercelDeployStep({ project, runDevenvTasksBefore: opts.runDevenvTasksBefore }),
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
      }),
    ],
  }

  return {
    ...deployJobs,
    'post-deploy-comment': commentJob,
  }
}
