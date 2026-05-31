import {
  deployTargetEnvSuffix,
  workflowReportEnvKey,
  workflowReportKind,
  workflowReportMarker,
  workflowReportOutputName,
  workflowReportPathEnvKey,
  workflowReportPathOutputName,
  workflowReportRuntimeModuleSetup,
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
      `metadata_json=$(grep -F 'DEPLOY_TASK_METADATA: ' "$tmp_log" | sed 's/^.*DEPLOY_TASK_METADATA: //' | tail -n 1 || true)`,
      'if [ -n "$metadata_json" ]; then',
      '  final_url=$(printf "%s" "$metadata_json" | jq -r \'.finalUrl // empty\')',
      '  raw_deploy_url=$(printf "%s" "$metadata_json" | jq -r \'.rawDeployUrl // empty\')',
      '  deployed_at_utc=$(printf "%s" "$metadata_json" | jq -r \'.deployedAtUtc // empty\')',
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
      'workflow_report_json=""',
      'if [ -s "$workflow_report_path" ]; then',
      '  workflow_report_json="$(tail -n 1 "$workflow_report_path")"',
      'fi',
      'if [ -z "$workflow_report_json" ]; then',
      `  workflow_report_json=$(grep -F ${JSON.stringify(workflowReportMarker)} "$tmp_log" | sed 's/^.*${workflowReportMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}//' | tail -n 1 || true)`,
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

export const vercelDeployCommentStep = (opts: {
  commentTitle: string
  noRowsMessage: string
  projects: readonly Pick<VercelProject, 'name' | 'label'>[]
  deployModeScript: string
}) => {
  const projects = opts.projects.map((project) => ({
    name: project.name,
    displayName: project.label ?? project.name,
    envSuffix: deployTargetEnvSuffix(project.name),
    reportEnvKey: workflowReportEnvKey(project.name),
    reportPathEnvKey: workflowReportPathEnvKey(project.name),
  }))

  const renderCommentScript = [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "import { resolve } from 'node:path'",
    "import { pathToFileURL } from 'node:url'",
    '',
    `const commentTitle = ${JSON.stringify(opts.commentTitle)}`,
    `const noRecordsMessage = ${JSON.stringify(opts.noRowsMessage)}`,
    `const projects = ${JSON.stringify(projects)}`,
    `const workflowReportKind = ${JSON.stringify(workflowReportKind)}`,
    'const stateId = "deploy-preview"',
    '',
    'const [commentsPath, commentBodyPath, summaryPath, commentIdPath] = process.argv.slice(2)',
    'const runtimeModule = process.env.WORKFLOW_REPORT_RUNTIME_MODULE',
    'if (typeof runtimeModule !== "string" || runtimeModule.length === 0) throw new Error("WORKFLOW_REPORT_RUNTIME_MODULE is required")',
    'const {',
    '  decodeWorkflowReportRecord,',
    '  deriveWorkflowReportManagedState,',
    '  encodeWorkflowReportRecordLine,',
    '  findWorkflowReportManagedComment,',
    '  legacyDeployPreviewManagedStateMigration,',
    '  renderWorkflowReportCommentBody,',
    '} = await import(pathToFileURL(resolve(runtimeModule)).href)',
    '',
    'const fail = (message) => {',
    '  throw new Error(message)',
    '}',
    '',
    'const expectObject = (value, path) => {',
    "  if (typeof value !== 'object' || value === null || Array.isArray(value)) {",
    '    fail(`${path} must be an object`)',
    '  }',
    '  return value',
    '}',
    '',
    'const expectString = (value, path) => {',
    "  if (typeof value !== 'string' || value.length === 0) {",
    '    fail(`${path} must be a non-empty string`)',
    '  }',
    '  return value',
    '}',
    '',
    'const expectUrl = (value, path) => {',
    '  const string = expectString(value, path)',
    "  if (!string.startsWith('https://')) {",
    '    fail(`${path} must start with https://`)',
    '  }',
    '  return string',
    '}',
    '',
    'const reportFromLegacyOutputs = (project) => {',
    '  const finalUrl = process.env[`DEPLOY_FINAL_URL_${project.envSuffix}`] ?? ""',
    '  const rawDeployUrl = process.env[`DEPLOY_RAW_DEPLOY_URL_${project.envSuffix}`] ?? finalUrl',
    '  const deployedAtUtc = process.env[`DEPLOYED_AT_UTC_${project.envSuffix}`] ?? ""',
    '  if (finalUrl.length > 0 && deployedAtUtc.length > 0) {',
    '    return decodeWorkflowReportRecord({',
    '      _tag: "WorkflowReportRecord",',
    '      schemaVersion: 1,',
    '      id: `deploy-vercel-${project.name}`,',
    '      kind: workflowReportKind,',
    '      subject: { id: project.name, label: project.displayName },',
    '      status: "success",',
    '      title: `${project.displayName} preview deployed`,',
    '      summary: "Preview is ready",',
    '      createdAtUtc: deployedAtUtc,',
    '      links: [{ label: "Preview", url: finalUrl, primary: true }],',
    '      data: {',
    '        provider: "vercel",',
    '        target: project.name,',
    '        displayName: project.displayName,',
    '        finalUrl,',
    '        rawDeployUrl: rawDeployUrl.length === 0 ? finalUrl : rawDeployUrl,',
    '        deployedAtUtc,',
    '      },',
    '    })',
    '  }',
    '  return decodeWorkflowReportRecord({',
    '    _tag: "WorkflowReportRecord",',
    '    schemaVersion: 1,',
    '    id: `deploy-vercel-${project.name}`,',
    '    kind: workflowReportKind,',
    '    subject: { id: project.name, label: project.displayName },',
    '    status: "skipped",',
    '    title: `${project.displayName} preview not deployed`,',
    '    summary: "No Vercel deploy URL detected.",',
    '    createdAtUtc: deployedAtUtc.length === 0 ? new Date().toISOString().replace(/\\.\\d{3}Z$/, "Z") : deployedAtUtc,',
    '    data: {',
    '      provider: "vercel",',
    '      target: project.name,',
    '      displayName: project.displayName,',
    '      reason: "No Vercel deploy URL detected.",',
    '    },',
    '  })',
    '}',
    '',
    'const currentReports = projects.map((project, index) => {',
    '  const rawReport = process.env[project.reportEnvKey] ?? ""',
    '  if (rawReport.length === 0) return reportFromLegacyOutputs(project)',
    '  return decodeWorkflowReportRecord(JSON.parse(rawReport), `workflowReports[${index}]`)',
    '})',
    '',
    'for (const report of currentReports) {',
    '  console.log(encodeWorkflowReportRecordLine(report))',
    '}',
    '',
    "const comments = JSON.parse(readFileSync(commentsPath, 'utf8'))",
    'if (!Array.isArray(comments)) fail("comments response must be an array")',
    '',
    'const commitSha = expectString(process.env.DEPLOY_COMMIT_SHA, "DEPLOY_COMMIT_SHA")',
    'const modeLabel = expectString(process.env.DEPLOY_LABEL, "DEPLOY_LABEL")',
    'const existingComment = findWorkflowReportManagedComment(comments, {',
    '  stateId,',
    '  migrations: [legacyDeployPreviewManagedStateMigration],',
    '})',
    'const createdAtUtc = currentReports',
    '  .map((report) => report.createdAtUtc)',
    '  .toSorted((left, right) => Date.parse(right) - Date.parse(left))[0] ?? new Date().toISOString()',
    'const state = deriveWorkflowReportManagedState({',
    '  stateId,',
    '  priorState: existingComment?.state,',
    '  entryId: commitSha,',
    '  entryLabel: modeLabel,',
    '  createdAtUtc,',
    '  records: currentReports,',
    '})',
    'const body = renderWorkflowReportCommentBody({ title: commentTitle, noRecordsMessage, state })',
    'const visibleBody = body.slice(0, body.indexOf("<!-- workflow-report:managed -->")).trimEnd() + "\\n"',
    'writeFileSync(summaryPath, visibleBody)',
    'writeFileSync(commentBodyPath, body)',
    "writeFileSync(commentIdPath, existingComment?.id ?? '')",
    '',
  ].join('\n')

  return {
    name: 'Post deploy URLs',
    if: 'always() && !cancelled()',
    shell: 'bash' as const,
    env: {
      GH_TOKEN: '${{ github.token }}',
      GH_REPO: '${{ github.repository }}',
      ...Object.fromEntries(
        projects.flatMap((project) => [
          [
            `DEPLOY_FINAL_URL_${project.envSuffix}`,
            `\${{ needs.deploy-${project.name}.outputs.final_url }}`,
          ],
          [
            `DEPLOY_RAW_DEPLOY_URL_${project.envSuffix}`,
            `\${{ needs.deploy-${project.name}.outputs.raw_deploy_url }}`,
          ],
          [
            `DEPLOYED_AT_UTC_${project.envSuffix}`,
            `\${{ needs.deploy-${project.name}.outputs.deployed_at_utc }}`,
          ],
          [
            project.reportEnvKey,
            `\${{ needs.deploy-${project.name}.outputs.${workflowReportOutputName} }}`,
          ],
          [
            project.reportPathEnvKey,
            `\${{ needs.deploy-${project.name}.outputs.${workflowReportPathOutputName} }}`,
          ],
        ]),
      ),
    },
    run: [
      opts.deployModeScript,
      ...workflowReportRuntimeModuleSetup,
      'if [ "${{ github.event_name }}" = "pull_request" ]; then',
      '  commit_sha="${{ github.event.pull_request.head.sha }}"',
      'else',
      '  commit_sha="${{ github.sha }}"',
      'fi',
      'export DEPLOY_LABEL="$label"',
      'export DEPLOY_COMMIT_SHA="$commit_sha"',
      'comments_json="/tmp/deploy-comments.json"',
      'if [ "${{ github.event_name }}" = "pull_request" ]; then',
      '  export NIX_CONFIG="${NIX_CONFIG:+$NIX_CONFIG$\'\\n\'}access-tokens = github.com=${GH_TOKEN}"',
      '  nix run nixpkgs#gh -- api "repos/$GH_REPO/issues/${{ github.event.pull_request.number }}/comments" --paginate > "$comments_json"',
      'else',
      '  printf \'[]\' > "$comments_json"',
      'fi',
      "cat > /tmp/render-deploy-comment.mjs <<'EOF'",
      renderCommentScript,
      'EOF',
      'nix run nixpkgs#nodejs_24 -- /tmp/render-deploy-comment.mjs "$comments_json" /tmp/comment.md /tmp/summary.md /tmp/comment-id.txt',
      'cat /tmp/summary.md >> "$GITHUB_STEP_SUMMARY"',
      'if [ "${{ github.event_name }}" = "pull_request" ]; then',
      '  comment_id="$(cat /tmp/comment-id.txt)"',
      '  if [ -n "$comment_id" ]; then',
      '    nix run nixpkgs#gh -- api "repos/$GH_REPO/issues/comments/$comment_id" --method PATCH --field body="$(cat /tmp/comment.md)" > /dev/null',
      '  else',
      '    nix run nixpkgs#gh -- api "repos/$GH_REPO/issues/${{ github.event.pull_request.number }}/comments" --method POST --field body="$(cat /tmp/comment.md)" > /dev/null',
      '  fi',
      'fi',
    ].join('\n'),
  }
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
  noRowsMessage?: string
  runDevenvTasksBefore: (...tasks: [string, ...string[]]) => string
  deployModeScript: string
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
      vercelDeployCommentStep({
        commentTitle: opts.commentTitle ?? 'Deploy Preview',
        projects: opts.projects,
        noRowsMessage: opts.noRowsMessage ?? 'No deploy URLs detected.',
        deployModeScript: opts.deployModeScript,
      }),
    ],
  }

  return {
    ...deployJobs,
    'post-deploy-comment': commentJob,
  }
}
