import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import {
  encodeWorkflowReportRecordLine,
  workflowReportManagedMarker,
  workflowReportRecordLineMarker,
  type WorkflowReportRecord,
} from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { shellSingleQuote } from './shared.ts'

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
    "cat > /tmp/collect-workflow-report-bundle.mjs <<'EOF'",
    [
      "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
      "import { dirname } from 'node:path'",
      '',
      'const fail = (message) => {',
      '  throw new Error(message)',
      '}',
      '',
      'const expectObject = (value, path) => {',
      "  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${path} must be an object`)",
      '  return value',
      '}',
      '',
      'const expectString = (value, path) => {',
      "  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`)",
      '  return value',
      '}',
      '',
      'const expectArray = (value, path) => {',
      '  if (!Array.isArray(value)) fail(`${path} must be an array`)',
      '  return value',
      '}',
      '',
      'const expectExactKeys = (record, keys, path) => {',
      '  const actual = Object.keys(record).sort()',
      '  const expected = [...keys].sort()',
      '  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {',
      '    fail(`${path} keys must be exactly: ${expected.join(", ")}`)',
      '  }',
      '}',
      '',
      'const expectIsoUtc = (value, path) => {',
      '  const string = expectString(value, path)',
      '  if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$/.test(string) || Number.isNaN(Date.parse(string))) {',
      '    fail(`${path} must be an ISO UTC timestamp`)',
      '  }',
      '  return string',
      '}',
      '',
      'const expectHttpsUrl = (value, path) => {',
      '  const string = expectString(value, path)',
      "  if (!string.startsWith('https://')) fail(`${path} must be an HTTPS URL`)",
      '  return string',
      '}',
      '',
      'const validateSubject = (value, path) => {',
      '  const record = expectObject(value, path)',
      "  expectExactKeys(record, record.label === undefined ? ['id'] : ['id', 'label'], path)",
      '  return {',
      '    id: expectString(record.id, `${path}.id`),',
      '    ...(record.label === undefined ? {} : { label: expectString(record.label, `${path}.label`) }),',
      '  }',
      '}',
      '',
      'const validateLink = (value, path) => {',
      '  const record = expectObject(value, path)',
      "  expectExactKeys(record, record.primary === undefined ? ['label', 'url'] : ['label', 'primary', 'url'], path)",
      '  return {',
      '    label: expectString(record.label, `${path}.label`),',
      '    url: expectHttpsUrl(record.url, `${path}.url`),',
      '    ...(record.primary === undefined ? {} : { primary: record.primary === true || record.primary === false ? record.primary : fail(`${path}.primary must be boolean`) }),',
      '  }',
      '}',
      '',
      'const validateRecord = (value, path) => {',
      '  const record = expectObject(value, path)',
      '  const required = ["_tag", "createdAtUtc", "id", "kind", "schemaVersion", "status", "subject", "title"]',
      '  const optional = ["data", "links", "summary"]',
      '  for (const key of Object.keys(record)) {',
      '    if (!required.includes(key) && !optional.includes(key)) fail(`${path}.${key} is not allowed`)',
      '  }',
      "  if (record._tag !== 'WorkflowReportRecord') fail(`${path}._tag must be WorkflowReportRecord`)",
      '  if (record.schemaVersion !== 1) fail(`${path}.schemaVersion must be 1`)',
      "  if (!['success', 'failure', 'skipped', 'neutral'].includes(record.status)) fail(`${path}.status is invalid`)",
      '  return {',
      "    _tag: 'WorkflowReportRecord',",
      '    schemaVersion: 1,',
      '    id: expectString(record.id, `${path}.id`),',
      '    kind: expectString(record.kind, `${path}.kind`),',
      '    subject: validateSubject(record.subject, `${path}.subject`),',
      '    status: record.status,',
      '    title: expectString(record.title, `${path}.title`),',
      '    ...(record.summary === undefined ? {} : { summary: String(record.summary) }),',
      '    createdAtUtc: expectIsoUtc(record.createdAtUtc, `${path}.createdAtUtc`),',
      '    ...(record.links === undefined ? {} : { links: expectArray(record.links, `${path}.links`).map((link, index) => validateLink(link, `${path}.links[${index}]`)) }),',
      '    ...(record.data === undefined ? {} : { data: expectObject(record.data, `${path}.data`) }),',
      '  }',
      '}',
      '',
      'const marker = expectString(process.env.WORKFLOW_REPORT_RECORD_MARKER, "WORKFLOW_REPORT_RECORD_MARKER")',
      'const inputPaths = JSON.parse(expectString(process.env.WORKFLOW_REPORT_INPUT_PATHS_JSON, "WORKFLOW_REPORT_INPUT_PATHS_JSON"))',
      'const outputPath = expectString(process.env.WORKFLOW_REPORT_OUTPUT_PATH, "WORKFLOW_REPORT_OUTPUT_PATH")',
      'const bundleId = expectString(process.env.WORKFLOW_REPORT_BUNDLE_ID, "WORKFLOW_REPORT_BUNDLE_ID")',
      'const allowMissingInput = process.env.WORKFLOW_REPORT_ALLOW_MISSING_INPUT === "1"',
      '',
      'const records = []',
      'for (const path of inputPaths) {',
      '  if (!existsSync(path)) {',
      '    if (allowMissingInput) continue',
      '    fail(`workflow report input file does not exist: ${path}`)',
      '  }',
      '  for (const line of readFileSync(path, "utf8").split(/\\r?\\n/u)) {',
      '    const markerIndex = line.indexOf(marker)',
      '    if (markerIndex === -1) continue',
      '    records.push(validateRecord(JSON.parse(line.slice(markerIndex + marker.length)), `records[${records.length}]`))',
      '  }',
      '}',
      '',
      'const bundle = {',
      "  _tag: 'WorkflowReportBundle',",
      '  schemaVersion: 1,',
      '  bundleId,',
      '  generatedAtUtc: new Date().toISOString(),',
      '  records,',
      '}',
      '',
      'mkdirSync(dirname(outputPath), { recursive: true })',
      'writeFileSync(outputPath, `${JSON.stringify(bundle, undefined, 2)}\\n`)',
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
    WORKFLOW_REPORT_COMMENT_BODY_PATH: opts.commentBodyPath,
    WORKFLOW_REPORT_SUMMARY_PATH: opts.summaryPath ?? opts.commentBodyPath,
    WORKFLOW_REPORT_MANAGED_MARKER: opts.marker ?? workflowReportManagedMarker,
  },
  run: [
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
      '',
      'const [commentsPath, commentIdPath] = process.argv.slice(2)',
      'const marker = process.env.WORKFLOW_REPORT_MANAGED_MARKER',
      'if (typeof marker !== "string" || marker.length === 0) throw new Error("WORKFLOW_REPORT_MANAGED_MARKER is required")',
      'const comments = JSON.parse(readFileSync(commentsPath, "utf8"))',
      'if (!Array.isArray(comments)) throw new Error("comments response must be an array")',
      'const existingComment = comments',
      '  .filter((comment) => typeof comment?.body === "string" && comment.body.includes(marker))',
      '  .at(-1)',
      'writeFileSync(commentIdPath, existingComment?.id === undefined ? "" : String(existingComment.id))',
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
