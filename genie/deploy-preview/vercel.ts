import {
  deployPreviewManagedMarker,
  deployPreviewStatePrefix,
  deployPreviewStateSuffix,
  deployTargetEnvSuffix,
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
  const urlEnvKey =
    project.urlEnvKey ??
    `VERCEL_DEPLOY_URL_${project.name
      .toUpperCase()
      .replaceAll('-', '_')
      .replaceAll(/[^A-Z0-9_]/g, '')}`

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
      'if [ -n "$final_url" ]; then',
      `  echo "${urlEnvKey}=$final_url" >> "$GITHUB_ENV"`,
      '  echo "final_url=$final_url" >> "$GITHUB_OUTPUT"',
      '  echo "deploy_url=$final_url" >> "$GITHUB_OUTPUT"',
      'fi',
      'if [ -n "$raw_deploy_url" ]; then',
      '  echo "raw_deploy_url=$raw_deploy_url" >> "$GITHUB_OUTPUT"',
      'fi',
      'echo "deployed_at_utc=$deployed_at_utc" >> "$GITHUB_OUTPUT"',
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
  }))

  const renderCommentScript = [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    '',
    `const commentTitle = ${JSON.stringify(opts.commentTitle)}`,
    `const noRowsMessage = ${JSON.stringify(opts.noRowsMessage)}`,
    `const projects = ${JSON.stringify(projects)}`,
    `const managedMarker = ${JSON.stringify(deployPreviewManagedMarker)}`,
    `const statePrefix = ${JSON.stringify(deployPreviewStatePrefix)}`,
    `const stateSuffix = ${JSON.stringify(deployPreviewStateSuffix)}`,
    `const stateTag = 'deploy-preview-comment-state'`,
    `const schemaVersion = 1`,
    `const timeZone = 'Europe/Berlin'`,
    `const maxCommits = 50`,
    '',
    'const [commentsPath, commentBodyPath, summaryPath, commentIdPath] = process.argv.slice(2)',
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
    'const expectArray = (value, path) => {',
    '  if (!Array.isArray(value)) {',
    '    fail(`${path} must be an array`)',
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
    'const expectExactKeys = (record, keys, path) => {',
    '  const actualKeys = Object.keys(record).sort()',
    '  const expectedKeys = [...keys].sort()',
    '  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {',
    '    fail(`${path} keys must be exactly: ${expectedKeys.join(", ")}`)',
    '  }',
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
    'const expectIsoUtc = (value, path) => {',
    '  const string = expectString(value, path)',
    '  if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$/.test(string) || Number.isNaN(Date.parse(string))) {',
    '    fail(`${path} must be a valid UTC ISO timestamp`)',
    '  }',
    '  return string',
    '}',
    '',
    'const validateTarget = (value, path) => {',
    '  const record = expectObject(value, path)',
    "  expectExactKeys(record, ['target', 'displayName', 'finalUrl', 'rawDeployUrl', 'deployedAtUtc'], path)",
    '  return {',
    '    target: expectString(record.target, `${path}.target`),',
    '    displayName: expectString(record.displayName, `${path}.displayName`),',
    '    finalUrl: expectUrl(record.finalUrl, `${path}.finalUrl`),',
    '    rawDeployUrl: expectUrl(record.rawDeployUrl, `${path}.rawDeployUrl`),',
    '    deployedAtUtc: expectIsoUtc(record.deployedAtUtc, `${path}.deployedAtUtc`),',
    '  }',
    '}',
    '',
    'const validateCommit = (value, path) => {',
    '  const record = expectObject(value, path)',
    "  expectExactKeys(record, ['commitSha', 'modeLabel', 'targets'], path)",
    '  const targets = expectArray(record.targets, `${path}.targets`).map((target, index) =>',
    '    validateTarget(target, `${path}.targets[${index}]`),',
    '  )',
    '  return {',
    '    commitSha: expectString(record.commitSha, `${path}.commitSha`),',
    '    modeLabel: expectString(record.modeLabel, `${path}.modeLabel`),',
    '    targets,',
    '  }',
    '}',
    '',
    'const validateState = (value) => {',
    "  const record = expectObject(value, 'state')",
    "  expectExactKeys(record, ['_tag', 'schemaVersion', 'timeZone', 'targetOrder', 'commits'], 'state')",
    '  if (record._tag !== stateTag) fail(`state._tag must be ${stateTag}`)',
    '  if (record.schemaVersion !== schemaVersion) fail(`state.schemaVersion must be ${schemaVersion}`)',
    '  if (record.timeZone !== timeZone) fail(`state.timeZone must be ${timeZone}`)',
    '  const targetOrder = expectArray(record.targetOrder, "state.targetOrder").map((target, index) =>',
    '    expectString(target, `state.targetOrder[${index}]`),',
    '  )',
    '  const commits = expectArray(record.commits, "state.commits").map((commit, index) =>',
    '    validateCommit(commit, `state.commits[${index}]`),',
    '  )',
    '  return { _tag: stateTag, schemaVersion, timeZone, targetOrder, commits }',
    '}',
    '',
    'const formatBerlin = (isoUtc) => {',
    "  const formatter = new Intl.DateTimeFormat('en-GB', {",
    '    timeZone,',
    "    year: 'numeric',",
    "    month: '2-digit',",
    "    day: '2-digit',",
    "    hour: '2-digit',",
    "    minute: '2-digit',",
    '    hour12: false,',
    "    timeZoneName: 'short',",
    '  })',
    '  const parts = Object.fromEntries(',
    '    formatter.formatToParts(new Date(isoUtc)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),',
    '  )',
    '  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`',
    '}',
    '',
    'const extractState = (body) => {',
    '  const start = body.indexOf(statePrefix)',
    '  if (start === -1) return undefined',
    '  const end = body.indexOf(stateSuffix, start + statePrefix.length)',
    '  if (end === -1) fail("existing managed comment is missing the state suffix marker")',
    '  const raw = body.slice(start + statePrefix.length, end)',
    '  return validateState(JSON.parse(raw))',
    '}',
    '',
    'const renderHistoryUrl = (target) =>',
    '  target.finalUrl === target.rawDeployUrl',
    '    ? target.rawDeployUrl',
    '    : `${target.rawDeployUrl}<br><sub>Alias: ${target.finalUrl}</sub>`',
    '',
    'const currentTargets = projects.flatMap((project) => {',
    '  const finalUrl = process.env[`DEPLOY_FINAL_URL_${project.envSuffix}`] ?? ""',
    '  const rawDeployUrl = process.env[`DEPLOY_RAW_DEPLOY_URL_${project.envSuffix}`] ?? finalUrl',
    '  const deployedAtUtc = process.env[`DEPLOYED_AT_UTC_${project.envSuffix}`] ?? ""',
    '  if (finalUrl.length === 0 || deployedAtUtc.length === 0) return []',
    '  return [{',
    '    target: project.name,',
    '    displayName: project.displayName,',
    '    finalUrl,',
    '    rawDeployUrl: rawDeployUrl.length === 0 ? finalUrl : rawDeployUrl,',
    '    deployedAtUtc,',
    '  }]',
    '})',
    '',
    'const dedupedCurrentTargets = [...new Map(currentTargets.map((target) => [target.target, target])).values()]',
    'dedupedCurrentTargets.forEach((target, index) => validateTarget(target, `currentTargets[${index}]`))',
    '',
    'if (dedupedCurrentTargets.length === 0) {',
    '  writeFileSync(summaryPath, `## ${commentTitle}\\n\\n${noRowsMessage}\\n`)',
    "  writeFileSync(commentBodyPath, '')",
    "  writeFileSync(commentIdPath, '')",
    '  process.exit(0)',
    '}',
    '',
    "const comments = JSON.parse(readFileSync(commentsPath, 'utf8'))",
    'if (!Array.isArray(comments)) fail("comments response must be an array")',
    '',
    'const existingComment = comments',
    '  .filter(',
    '    (comment) =>',
    '      typeof comment?.body === "string" &&',
    '      (comment.body.includes(managedMarker) || comment.body.startsWith(`## ${commentTitle}`)),',
    '  )',
    '  .at(-1)',
    '',
    'const existingState = existingComment ? extractState(existingComment.body) : undefined',
    'const priorState = existingState ?? { _tag: stateTag, schemaVersion, timeZone, targetOrder: [], commits: [] }',
    '',
    'const commitSha = expectString(process.env.DEPLOY_COMMIT_SHA, "DEPLOY_COMMIT_SHA")',
    'const modeLabel = expectString(process.env.DEPLOY_LABEL, "DEPLOY_LABEL")',
    '',
    'const nextTargetOrder = [...new Set([...dedupedCurrentTargets.map((target) => target.target), ...priorState.targetOrder])]',
    'const nextState = {',
    '  _tag: stateTag,',
    '  schemaVersion,',
    '  timeZone,',
    '  targetOrder: nextTargetOrder,',
    '  commits: [',
    '    { commitSha, modeLabel, targets: dedupedCurrentTargets },',
    '    ...priorState.commits.filter((commit) => commit.commitSha !== commitSha),',
    '  ].slice(0, maxCommits),',
    '}',
    '',
    'const latestByTarget = new Map()',
    'for (const commit of nextState.commits) {',
    '  for (const target of commit.targets) {',
    '    if (!latestByTarget.has(target.target)) {',
    '      latestByTarget.set(target.target, target)',
    '    }',
    '  }',
    '}',
    '',
    'const renderCommitTimestamp = (commit) => {',
    '  const latestIso = commit.targets.reduce((currentLatest, target) =>',
    '    Date.parse(target.deployedAtUtc) > Date.parse(currentLatest) ? target.deployedAtUtc : currentLatest,',
    '  commit.targets[0]?.deployedAtUtc ?? new Date(0).toISOString())',
    '  return formatBerlin(latestIso)',
    '}',
    '',
    'const visibleLines = [',
    '  `## ${commentTitle}`,',
    "  '',",
    '  `| Target | Latest URL | Last Deploy (Europe/Berlin) |`,',
    '  `| --- | --- | --- |`,',
    '  ...nextState.targetOrder.flatMap((targetName) => {',
    '    const target = latestByTarget.get(targetName)',
    '    return target === undefined',
    '      ? []',
    '      : [`| ${target.displayName} | ${target.finalUrl} | ${formatBerlin(target.deployedAtUtc)} |`]',
    '  }),',
    ']',
    '',
    'if (nextState.commits.length > 0) {',
    "  visibleLines.push('', '<details>', '<summary>Per-Commit Deploy History</summary>', '')",
    '  for (const commit of nextState.commits) {',
    '    visibleLines.push(`### Commit \\`${commit.commitSha.slice(0, 7)}\\` · ${renderCommitTimestamp(commit)}`)',
    "    visibleLines.push('')",
    '    visibleLines.push(`| Target | URL |`)',
    '    visibleLines.push(`| --- | --- |`)',
    '    for (const targetName of nextState.targetOrder) {',
    '      const target = commit.targets.find((entry) => entry.target === targetName)',
    '      if (target !== undefined) {',
    '        visibleLines.push(`| ${target.displayName} | ${renderHistoryUrl(target)} |`)',
    '      }',
    '    }',
    "    visibleLines.push('')",
    '  }',
    "  visibleLines.push('</details>')",
    '}',
    '',
    'const visibleBody = `${visibleLines.join("\\n")}\\n`',
    'const hiddenState = `${managedMarker}\\n${statePrefix}${JSON.stringify(nextState, undefined, 2)}${stateSuffix}`',
    'const fullBody = `${visibleBody}\\n${hiddenState}\\n`',
    '',
    'writeFileSync(summaryPath, visibleBody)',
    'writeFileSync(commentBodyPath, fullBody)',
    "writeFileSync(commentIdPath, existingComment ? String(existingComment.id) : '')",
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
        ]),
      ),
    },
    run: [
      opts.deployModeScript,
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
        },
        env: {
          ...opts.env,
          [project.projectIdEnv]:
            opts.env[project.projectIdEnv] ?? `\${{ secrets.${project.projectIdEnv} }}`,
        },
        steps: [
          ...opts.baseSteps,
          ...(project.stepsBeforeDeploy ?? []),
          vercelDeployStep(project, opts.runDevenvTasksBefore),
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
