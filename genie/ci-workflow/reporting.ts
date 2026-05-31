import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import {
  encodeWorkflowReportRecordLine,
  workflowReportManagedMarker,
  workflowReportRecordLineMarker,
  type WorkflowReportRecord,
} from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { shellSingleQuote, workflowReportRuntimeModuleSetup } from './shared.ts'

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
  readonly runtimeModulePath?: string
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
  readonly runtimeModulePath?: string
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
    WORKFLOW_REPORT_BUNDLE_ID: opts.bundleId,
    WORKFLOW_REPORT_INPUT_PATHS_JSON: JSON.stringify(opts.inputPaths),
    WORKFLOW_REPORT_OUTPUT_PATH: opts.outputPath,
    WORKFLOW_REPORT_RECORD_MARKER: opts.marker ?? workflowReportRecordLineMarker,
    WORKFLOW_REPORT_ALLOW_MISSING_INPUT: opts.allowMissingInput === true ? '1' : '0',
  },
  run: [
    ...workflowReportRuntimeModuleSetup(opts.runtimeModulePath),
    "cat > /tmp/collect-workflow-report-bundle.mjs <<'EOF'",
    [
      "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
      "import { dirname, resolve } from 'node:path'",
      "import { pathToFileURL } from 'node:url'",
      '',
      "const runtimeModule = process.env.WORKFLOW_REPORT_RUNTIME_MODULE",
      'if (typeof runtimeModule !== "string" || runtimeModule.length === 0) throw new Error("WORKFLOW_REPORT_RUNTIME_MODULE is required")',
      'const { collectWorkflowReportBundle, encodeWorkflowReportBundleJson } = await import(pathToFileURL(resolve(runtimeModule)).href)',
      '',
      'const expectString = (value, path) =>',
      '  typeof value === "string" && value.length > 0 ? value : (() => { throw new Error(`${path} must be a non-empty string`) })()',
      '',
      'const marker = expectString(process.env.WORKFLOW_REPORT_RECORD_MARKER, "WORKFLOW_REPORT_RECORD_MARKER")',
      'const inputPaths = JSON.parse(expectString(process.env.WORKFLOW_REPORT_INPUT_PATHS_JSON, "WORKFLOW_REPORT_INPUT_PATHS_JSON"))',
      'const outputPath = expectString(process.env.WORKFLOW_REPORT_OUTPUT_PATH, "WORKFLOW_REPORT_OUTPUT_PATH")',
      'const bundleId = expectString(process.env.WORKFLOW_REPORT_BUNDLE_ID, "WORKFLOW_REPORT_BUNDLE_ID")',
      'const allowMissingInput = process.env.WORKFLOW_REPORT_ALLOW_MISSING_INPUT === "1"',
      '',
      'const sources = []',
      'for (const path of inputPaths) {',
      '  if (!existsSync(path)) {',
      '    if (allowMissingInput) continue',
      '    throw new Error(`workflow report input file does not exist: ${path}`)',
      '  }',
      '  sources.push(readFileSync(path, "utf8"))',
      '}',
      '',
      'const bundle = collectWorkflowReportBundle({ bundleId, generatedAtUtc: new Date().toISOString(), sources, marker })',
      '',
      'mkdirSync(dirname(outputPath), { recursive: true })',
      'writeFileSync(outputPath, encodeWorkflowReportBundleJson(bundle))',
    ].join('\n'),
    'EOF',
    'nix run nixpkgs#bun -- /tmp/collect-workflow-report-bundle.mjs',
    ...(opts.outputName === undefined
      ? []
      : [`echo "${opts.outputName}=${opts.outputPath}" >> "$GITHUB_OUTPUT"`]),
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
    ...workflowReportRuntimeModuleSetup(opts.runtimeModulePath),
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
    `export NIX_CONFIG="\${NIX_CONFIG:+$NIX_CONFIG$'\\n'}access-tokens = github.com=\${GH_TOKEN}"`,
    'nix run nixpkgs#gh -- api "repos/$GH_REPO/issues/${{ github.event.pull_request.number }}/comments" --paginate > "$comments_json"',
    'nix run nixpkgs#bun -- - "$comments_json" "$comment_id_file" <<\'EOF\'',
    [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "import { resolve } from 'node:path'",
      "import { pathToFileURL } from 'node:url'",
      '',
      'const [commentsPath, commentIdPath] = process.argv.slice(2)',
      'const runtimeModule = process.env.WORKFLOW_REPORT_RUNTIME_MODULE',
      'if (typeof runtimeModule !== "string" || runtimeModule.length === 0) throw new Error("WORKFLOW_REPORT_RUNTIME_MODULE is required")',
      'const { extractWorkflowReportManagedState, findWorkflowReportManagedComment } = await import(pathToFileURL(resolve(runtimeModule)).href)',
      'const stateId = process.env.WORKFLOW_REPORT_STATE_ID',
      'if (typeof stateId !== "string" || stateId.length === 0) throw new Error("WORKFLOW_REPORT_STATE_ID is required")',
      'const marker = process.env.WORKFLOW_REPORT_MANAGED_MARKER',
      'if (typeof marker !== "string" || marker.length === 0) throw new Error("WORKFLOW_REPORT_MANAGED_MARKER is required")',
      'const commentBodyPath = process.env.WORKFLOW_REPORT_COMMENT_BODY_PATH',
      'if (typeof commentBodyPath !== "string" || commentBodyPath.length === 0) throw new Error("WORKFLOW_REPORT_COMMENT_BODY_PATH is required")',
      'const targetState = extractWorkflowReportManagedState(readFileSync(commentBodyPath, "utf8"), { stateId })',
      'if (targetState === undefined) throw new Error("workflow report comment body is missing managed state")',
      'const comments = JSON.parse(readFileSync(commentsPath, "utf8"))',
      'if (!Array.isArray(comments)) throw new Error("comments response must be an array")',
      'const existingComment = findWorkflowReportManagedComment(comments, { stateId: targetState.stateId, marker })',
      'writeFileSync(commentIdPath, existingComment?.id ?? "")',
    ].join('\n'),
    'EOF',
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
