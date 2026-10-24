import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import {
  workflowReportCollectorStep,
  workflowReportCommentBodyStep,
  workflowReportPublisherStep,
} from '../ci-workflow/reporting.ts'
import {
  deployTargetEnvSuffix,
  workflowReportMarker,
  workflowReportPathOutputName,
} from './shared.ts'

type WorkflowJob = GitHubWorkflowArgs['jobs'][string]
type WorkflowStep = WorkflowJob['steps'][number]
type RunTasksBefore = (...tasks: [string, ...string[]]) => string

/** Never widen this predicate: Wrangler configuration and Worker code are executable inputs. */
export const cloudflareWorkersTrustedJobCondition =
  "(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)"

export type CloudflareWorkersTarget = {
  readonly name: string
  readonly stepsBeforeDeploy?: readonly WorkflowStep[]
}

/**
 * Low-level task launcher. Use cloudflareWorkersDeployJobs to guard the whole
 * credentialed job, including checkout, consumer builds, and configuration loading.
 */
export const cloudflareWorkersDeployStep = (opts: {
  readonly target: Pick<CloudflareWorkersTarget, 'name'>
  readonly runDevenvTasksBefore: RunTasksBefore
}): WorkflowStep => ({
  id: 'deploy',
  name: `Deploy ${opts.target.name} to Cloudflare Workers`,
  shell: 'bash',
  run: [
    'workflow_report_dir="${RUNNER_TEMP:-/tmp}/workflow-reports"',
    'mkdir -p "$workflow_report_dir"',
    `workflow_report_path="$workflow_report_dir/cloudflare-workers-${deployTargetEnvSuffix(opts.target.name)}.jsonl"`,
    ': > "$workflow_report_path"',
    'export WORKFLOW_REPORT_OUTPUT_FILE="$workflow_report_path"',
    'if [ "${{ github.event_name }}" = "pull_request" ]; then',
    `  ${opts.runDevenvTasksBefore(`cloudflare-workers:deploy:${opts.target.name}`, '--show-output', '--input', 'type=pr', '--input', 'pr=${{ github.event.pull_request.number }}')}`,
    'else',
    `  ${opts.runDevenvTasksBefore(`cloudflare-workers:deploy:${opts.target.name}`, '--show-output', '--input', 'type=prod')}`,
    'fi',
    'if [ ! -s "$workflow_report_path" ]; then',
    '  echo "Error: ci-tools did not emit a Cloudflare Workers workflow report record." >&2',
    '  exit 1',
    'fi',
    `echo "${workflowReportPathOutputName}=$workflow_report_path" >> "$GITHUB_OUTPUT"`,
  ].join('\n'),
})

/**
 * Same-repository PRs are explicitly trusted executable code. Fork PRs and
 * pull_request_target never start these jobs or receive their job environment.
 * The caller configures targets/build prerequisites in the reusable Nix module.
 */
export const cloudflareWorkersDeployJobs = (opts: {
  readonly targets: readonly CloudflareWorkersTarget[]
  readonly runner: readonly string[]
  readonly baseSteps: readonly WorkflowStep[]
  readonly env: Record<string, string>
  readonly needs?: readonly string[]
  /** Additional restriction, ANDed with the non-overridable trust boundary. No ${{ }} wrapper. */
  readonly deployCondition?: string
  readonly includeComment?: boolean
  readonly commentTitle?: string
  readonly noRecordsMessage?: string
  readonly commentRunner?: readonly string[]
  /** Checkout/setup steps for workflow-report tasks; do not attach Cloudflare credentials here. */
  readonly commentBaseSteps?: readonly WorkflowStep[]
  readonly runDevenvTasksBefore: RunTasksBefore
}): GitHubWorkflowArgs['jobs'] => {
  const trustCondition = `(${cloudflareWorkersTrustedJobCondition})`
  const jobs: GitHubWorkflowArgs['jobs'] = Object.fromEntries(
    opts.targets.map((target): [string, WorkflowJob] => [
      `deploy-${target.name}`,
      {
        ...(opts.needs === undefined ? {} : { needs: [...opts.needs] }),
        if:
          opts.deployCondition === undefined
            ? trustCondition
            : `${trustCondition} && (${opts.deployCondition})`,
        'runs-on': [...opts.runner],
        permissions: { contents: 'read' },
        env: { ...opts.env },
        outputs: {
          final_url: '${{ steps.deploy.outputs.final_url }}',
          raw_deploy_url: '${{ steps.deploy.outputs.raw_deploy_url }}',
          deployed_at_utc: '${{ steps.deploy.outputs.deployed_at_utc }}',
          [workflowReportPathOutputName]: `\${{ steps.deploy.outputs.${workflowReportPathOutputName} }}`,
        },
        steps: [
          ...opts.baseSteps,
          ...(target.stepsBeforeDeploy ?? []),
          cloudflareWorkersDeployStep({ target, runDevenvTasksBefore: opts.runDevenvTasksBefore }),
          {
            name: `Upload ${target.name} deployment report`,
            if: 'always()',
            uses: 'actions/upload-artifact@v4',
            with: {
              name: `cloudflare-workers-report-${target.name}`,
              path: `\${{ runner.temp }}/workflow-reports/cloudflare-workers-${deployTargetEnvSuffix(target.name)}.jsonl`,
              'if-no-files-found': 'ignore',
              'retention-days': 3,
            },
          },
        ],
      },
    ]),
  )

  if (opts.includeComment === false) return jobs

  const stateId = 'cloudflare-workers-deploy-preview'
  const bundlePath = '${{ runner.temp }}/workflow-reports/cloudflare-workers-bundle.json'
  const commentBodyPath = '${{ runner.temp }}/workflow-reports/cloudflare-workers-comment.md'
  const summaryPath = '${{ runner.temp }}/workflow-reports/cloudflare-workers-summary.md'
  jobs['post-cloudflare-workers-deploy-comment'] = {
    needs: opts.targets.map((target) => `deploy-${target.name}`),
    if: `always() && !cancelled() && ${trustCondition}`,
    'runs-on': [...(opts.commentRunner ?? opts.runner)],
    permissions: { contents: 'read', actions: 'read', 'pull-requests': 'write' },
    steps: [
      ...(opts.commentBaseSteps ?? opts.baseSteps),
      {
        name: 'Download Cloudflare Workers deployment reports',
        uses: 'actions/download-artifact@v4',
        with: {
          pattern: 'cloudflare-workers-report-*',
          path: '${{ runner.temp }}/workflow-reports/cloudflare-workers-inputs',
          'merge-multiple': true,
        },
      },
      workflowReportCollectorStep({
        bundleId: stateId,
        inputPaths: opts.targets.map(
          (target) =>
            `\${{ runner.temp }}/workflow-reports/cloudflare-workers-inputs/cloudflare-workers-${deployTargetEnvSuffix(target.name)}.jsonl`,
        ),
        outputPath: bundlePath,
        marker: workflowReportMarker,
        allowMissingInput: true,
      }),
      workflowReportCommentBodyStep({
        bundlePath,
        commentBodyPath,
        summaryPath,
        title: opts.commentTitle ?? 'Cloudflare Workers Deploy Preview',
        noRecordsMessage: opts.noRecordsMessage ?? 'No Cloudflare Workers deploy URLs detected.',
        stateId,
        entryId:
          "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
        entryLabel:
          "${{ github.event_name == 'pull_request' && format('PR {0}', github.event.pull_request.number) || 'prod' }}",
      }),
      workflowReportPublisherStep({ commentBodyPath, summaryPath, stateId }),
    ],
  }
  return jobs
}
