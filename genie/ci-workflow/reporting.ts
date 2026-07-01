import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import {
  encodeWorkflowReportRecordLine,
  workflowReportManagedMarker,
  workflowReportRecordLineMarker,
  type WorkflowReportRecord,
} from '../../packages/@overeng/ci-tools/src/workflow-report-contract.ts'
import { runDevenvTasksBefore, shellSingleQuote } from './shared.ts'

type GitHubWorkflowStep = GitHubWorkflowArgs['jobs'][string]['steps'][number]

export type WorkflowReportProducerStepOptions = {
  readonly record: WorkflowReportRecord
  readonly id?: string
  readonly name?: string
  readonly marker?: string
  readonly outputPath?: string
  readonly if?: string
}

export type WorkflowReportCollectorStepOptions = {
  readonly bundleId: string
  readonly inputPaths: readonly string[]
  readonly outputPath: string
  readonly id?: string
  readonly name?: string
  readonly marker?: string
  readonly outputName?: string
  readonly allowMissingInput?: boolean
  readonly if?: string
}

export type WorkflowReportPublisherStepOptions = {
  readonly commentBodyPath: string
  readonly summaryPath?: string
  readonly stateId: string
  readonly id?: string
  readonly name?: string
  readonly marker?: string
  readonly if?: string
}

export type WorkflowReportCommentBodyStepOptions = {
  readonly bundlePath: string
  readonly commentBodyPath: string
  readonly title: string
  readonly noRecordsMessage: string
  readonly stateId: string
  readonly entryId: string
  readonly entryLabel: string
  readonly createdAtUtc?: string
  readonly summaryPath?: string
  readonly timeZone?: string
  readonly id?: string
  readonly name?: string
  readonly marker?: string
  readonly if?: string
}

export const workflowReportProducerStep = (
  opts: WorkflowReportProducerStepOptions,
): GitHubWorkflowStep => {
  const line = encodeWorkflowReportRecordLine(
    opts.record,
    opts.marker ?? workflowReportRecordLineMarker,
  )
  const outputPath = opts.outputPath

  return {
    ...(opts.id === undefined ? {} : { id: opts.id }),
    name: opts.name ?? 'Emit workflow report record',
    ...(opts.if === undefined ? {} : { if: opts.if }),
    shell: 'bash',
    run: [
      `workflow_report_line=${shellSingleQuote(line)}`,
      'printf "%s\\n" "$workflow_report_line"',
      ...(outputPath === undefined
        ? []
        : [
            `workflow_report_output_path=${shellSingleQuote(outputPath)}`,
            'mkdir -p "$(dirname "$workflow_report_output_path")"',
            'printf "%s\\n" "$workflow_report_line" >> "$workflow_report_output_path"',
          ]),
    ].join('\n'),
  }
}

export const workflowReportCollectorStep = (
  opts: WorkflowReportCollectorStepOptions,
): GitHubWorkflowStep => ({
  ...(opts.id === undefined ? {} : { id: opts.id }),
  name: opts.name ?? 'Collect workflow report bundle',
  ...(opts.if === undefined ? {} : { if: opts.if }),
  shell: 'bash',
  env: {
    GH_TOKEN: '${{ github.token }}',
    WORKFLOW_REPORT_BUNDLE_ID: opts.bundleId,
    WORKFLOW_REPORT_INPUT_PATHS_JSON: JSON.stringify(opts.inputPaths),
    WORKFLOW_REPORT_OUTPUT_PATH: opts.outputPath,
    WORKFLOW_REPORT_RECORD_MARKER: opts.marker ?? workflowReportRecordLineMarker,
    WORKFLOW_REPORT_ALLOW_MISSING_INPUT: opts.allowMissingInput === true ? '1' : '0',
    ...(opts.outputName === undefined ? {} : { WORKFLOW_REPORT_GITHUB_OUTPUT_NAME: opts.outputName }),
  },
  run: runDevenvTasksBefore('workflow-report:collect-bundle', '--show-output'),
})

export const workflowReportCommentBodyStep = (
  opts: WorkflowReportCommentBodyStepOptions,
): GitHubWorkflowStep => ({
  ...(opts.id === undefined ? {} : { id: opts.id }),
  name: opts.name ?? 'Render workflow report comment',
  ...(opts.if === undefined ? {} : { if: opts.if }),
  shell: 'bash',
  env: {
    GH_TOKEN: '${{ github.token }}',
    GH_REPO: '${{ github.repository }}',
    WORKFLOW_REPORT_EVENT_NAME: '${{ github.event_name }}',
    WORKFLOW_REPORT_PR_NUMBER: '${{ github.event.pull_request.number }}',
    WORKFLOW_REPORT_BUNDLE_PATH: opts.bundlePath,
    WORKFLOW_REPORT_COMMENT_BODY_PATH: opts.commentBodyPath,
    WORKFLOW_REPORT_SUMMARY_PATH: opts.summaryPath ?? opts.commentBodyPath,
    WORKFLOW_REPORT_TITLE: opts.title,
    WORKFLOW_REPORT_NO_RECORDS_MESSAGE: opts.noRecordsMessage,
    WORKFLOW_REPORT_STATE_ID: opts.stateId,
    WORKFLOW_REPORT_ENTRY_ID: opts.entryId,
    WORKFLOW_REPORT_ENTRY_LABEL: opts.entryLabel,
    WORKFLOW_REPORT_CREATED_AT_UTC: opts.createdAtUtc ?? '',
    WORKFLOW_REPORT_TIME_ZONE: opts.timeZone ?? 'UTC',
    WORKFLOW_REPORT_MANAGED_MARKER: opts.marker ?? workflowReportManagedMarker,
  },
  run: runDevenvTasksBefore('workflow-report:render-comment-body', '--show-output'),
})

export const workflowReportPublisherStep = (
  opts: WorkflowReportPublisherStepOptions,
): GitHubWorkflowStep => ({
  ...(opts.id === undefined ? {} : { id: opts.id }),
  name: opts.name ?? 'Publish workflow report',
  if: opts.if ?? 'always() && !cancelled()',
  shell: 'bash',
  env: {
    GH_TOKEN: '${{ github.token }}',
    GH_REPO: '${{ github.repository }}',
    WORKFLOW_REPORT_EVENT_NAME: '${{ github.event_name }}',
    WORKFLOW_REPORT_PR_NUMBER: '${{ github.event.pull_request.number }}',
    WORKFLOW_REPORT_HEAD_REPO: '${{ github.event.pull_request.head.repo.full_name }}',
    WORKFLOW_REPORT_STATE_ID: opts.stateId,
    WORKFLOW_REPORT_COMMENT_BODY_PATH: opts.commentBodyPath,
    WORKFLOW_REPORT_SUMMARY_PATH: opts.summaryPath ?? opts.commentBodyPath,
    WORKFLOW_REPORT_MANAGED_MARKER: opts.marker ?? workflowReportManagedMarker,
  },
  run: runDevenvTasksBefore('workflow-report:publish', '--show-output'),
})
