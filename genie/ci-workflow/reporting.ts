import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import {
  encodeWorkflowReportRecordLine,
  workflowReportManagedMarker,
  workflowReportRecordLineMarker,
  type WorkflowReportRecord,
} from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { shellSingleQuote, workflowReportGenieCommand, workflowReportNixTokenSetup } from './shared.ts'

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
  readonly genieFlakeRef?: string
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
  readonly genieFlakeRef?: string
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
  readonly genieFlakeRef?: string
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
  },
  run: [
    ...workflowReportNixTokenSetup,
    workflowReportGenieCommand({
      genieFlakeRef: opts.genieFlakeRef,
      args: [
        'workflow-report',
        'collect-bundle',
        '--bundle-id "$WORKFLOW_REPORT_BUNDLE_ID"',
        '--input-paths-json "$WORKFLOW_REPORT_INPUT_PATHS_JSON"',
        '--output-path "$WORKFLOW_REPORT_OUTPUT_PATH"',
        '--record-marker "$WORKFLOW_REPORT_RECORD_MARKER"',
        ...(opts.allowMissingInput === true ? ['--allow-missing-input'] : []),
      ],
    }),
    ...(opts.outputName === undefined
      ? []
      : [`echo "${opts.outputName}=${opts.outputPath}" >> "$GITHUB_OUTPUT"`]),
  ].join('\n'),
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
  run: [
    ...workflowReportNixTokenSetup,
    'comments_json="$(mktemp)"',
    'if [ "${{ github.event_name }}" = "pull_request" ]; then',
    '  nix run nixpkgs#gh -- api "repos/$GH_REPO/issues/${{ github.event.pull_request.number }}/comments" --paginate > "$comments_json"',
    'else',
    '  printf \'[]\' > "$comments_json"',
    'fi',
    '',
    workflowReportGenieCommand({
      genieFlakeRef: opts.genieFlakeRef,
      args: [
        'workflow-report',
        'render-comment-body',
        '--bundle-path "$WORKFLOW_REPORT_BUNDLE_PATH"',
        '--comments-path "$comments_json"',
        '--comment-body-path "$WORKFLOW_REPORT_COMMENT_BODY_PATH"',
        '--summary-path "$WORKFLOW_REPORT_SUMMARY_PATH"',
        '--title "$WORKFLOW_REPORT_TITLE"',
        '--no-records-message "$WORKFLOW_REPORT_NO_RECORDS_MESSAGE"',
        '--state-id "$WORKFLOW_REPORT_STATE_ID"',
        '--entry-id "$WORKFLOW_REPORT_ENTRY_ID"',
        '--entry-label "$WORKFLOW_REPORT_ENTRY_LABEL"',
        '--created-at-utc "$WORKFLOW_REPORT_CREATED_AT_UTC"',
        '--time-zone "$WORKFLOW_REPORT_TIME_ZONE"',
        '--managed-marker "$WORKFLOW_REPORT_MANAGED_MARKER"',
      ],
    }),
  ].join('\n'),
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
    WORKFLOW_REPORT_STATE_ID: opts.stateId,
    WORKFLOW_REPORT_COMMENT_BODY_PATH: opts.commentBodyPath,
    WORKFLOW_REPORT_SUMMARY_PATH: opts.summaryPath ?? opts.commentBodyPath,
    WORKFLOW_REPORT_MANAGED_MARKER: opts.marker ?? workflowReportManagedMarker,
  },
  run: [
    ...workflowReportNixTokenSetup,
    'if [ -s "$WORKFLOW_REPORT_SUMMARY_PATH" ]; then',
    '  cat "$WORKFLOW_REPORT_SUMMARY_PATH" >> "$GITHUB_STEP_SUMMARY"',
    'fi',
    '',
    'if [ "${{ github.event_name }}" != "pull_request" ]; then',
    '  exit 0',
    'fi',
    '',
    'if [ ! -s "$WORKFLOW_REPORT_COMMENT_BODY_PATH" ]; then',
    '  echo "::notice::workflow report comment body is empty; skipping PR comment"',
    '  exit 0',
    'fi',
    '',
    'comments_json="$(mktemp)"',
    'comment_id_file="$(mktemp)"',
    'nix run nixpkgs#gh -- api "repos/$GH_REPO/issues/${{ github.event.pull_request.number }}/comments" --paginate > "$comments_json"',
    workflowReportGenieCommand({
      genieFlakeRef: opts.genieFlakeRef,
      args: [
        'workflow-report',
        'find-comment',
        '--comments-path "$comments_json"',
        '--comment-body-path "$WORKFLOW_REPORT_COMMENT_BODY_PATH"',
        '--comment-id-path "$comment_id_file"',
        '--state-id "$WORKFLOW_REPORT_STATE_ID"',
        '--managed-marker "$WORKFLOW_REPORT_MANAGED_MARKER"',
      ],
    }),
    '',
    'comment_id="$(cat "$comment_id_file")"',
    'if [ -n "$comment_id" ]; then',
    '  nix run nixpkgs#gh -- api \\',
    '    --method PATCH \\',
    '    "repos/$GH_REPO/issues/comments/$comment_id" \\',
    '    --field body=@"$WORKFLOW_REPORT_COMMENT_BODY_PATH" >/dev/null',
    'else',
    '  nix run nixpkgs#gh -- pr comment "${{ github.event.pull_request.number }}" --body-file "$WORKFLOW_REPORT_COMMENT_BODY_PATH"',
    'fi',
  ].join('\n'),
})
