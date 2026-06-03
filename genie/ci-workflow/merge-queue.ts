import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { shellSingleQuote } from './shared.ts'

type WorkflowJob = GitHubWorkflowArgs['jobs'][string]
type WorkflowStep = WorkflowJob['steps'][number]
type WorkflowPermissions = WorkflowJob['permissions']

export const mergeQueueAdmissionLabel = 'mq:ci-admitted' as const

export const mergeQueueRequiredCIJobs = [
  'mq/admission',
  'pr/quality',
  'pr/topology',
  'pr/freshness',
  'pr/contract',
] as const

export const mergeQueueAdmissionLabelEvent =
  "github.event.action == 'labeled' && github.event.label.name == 'mq:ci-admitted'" as const

export const mergeQueueAdmissionEvidence =
  `contains(github.event.pull_request.labels.*.name, 'mq:ci-admitted') || (${mergeQueueAdmissionLabelEvent})` as const

export const fullPullRequestCiEvent =
  `github.event_name != 'pull_request' || (github.event.action != 'labeled' && github.event.action != 'unlabeled') || (${mergeQueueAdmissionLabelEvent})` as const

export const requiredCiMaterializingEvent =
  `(${fullPullRequestCiEvent}) && (github.event_name != 'pull_request' || (${mergeQueueAdmissionEvidence}))` as const

export const nonScheduleRequiredGateIf =
  "${{ always() && github.event_name != 'schedule' }}" as const

export const mergeQueueWorkflowConcurrency = {
  group:
    "${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}-${{ github.event_name == 'pull_request' && (github.event.action == 'labeled' || github.event.action == 'unlabeled') && format('label-{0}', github.event.label.name) || 'code' }}",
  'cancel-in-progress':
    "${{ github.event_name != 'pull_request' || (github.event.action != 'labeled' && github.event.action != 'unlabeled') }}",
} as const

export const mergeQueuePullRequestTrigger = {
  branches: ['main'],
  types: ['opened', 'reopened', 'synchronize', 'ready_for_review', 'labeled', 'unlabeled'],
} as const

export const mergeQueueWorkflowOn = (opts: { readonly branches?: readonly string[] } = {}) => ({
  push: { branches: [...(opts.branches ?? ['main'])] },
  pull_request: { ...mergeQueuePullRequestTrigger, branches: [...(opts.branches ?? ['main'])] },
  merge_group: null,
})

const githubExpressionStringLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`

const annotationLine = (kind: 'error' | 'notice' | 'warning', message: string) =>
  `printf '%s\\n' ${shellSingleQuote(`::${kind}::${message}`)}`

const defaultMergeQueuePermissions = {
  contents: 'read',
  issues: 'read',
  'pull-requests': 'read',
} as const

const mergeRequiredAdmissionPermissions = (
  permissions: WorkflowPermissions | undefined,
): WorkflowPermissions => {
  if (permissions === undefined) return defaultMergeQueuePermissions
  if (typeof permissions === 'string') return permissions
  return {
    ...permissions,
    contents: permissions.contents ?? defaultMergeQueuePermissions.contents,
    issues: permissions.issues ?? defaultMergeQueuePermissions.issues,
    'pull-requests': permissions['pull-requests'] ?? defaultMergeQueuePermissions['pull-requests'],
  }
}

export const requiredGateCheckName = (name: string) =>
  `\${{ (${requiredCiMaterializingEvent}) && ${githubExpressionStringLiteral(name)} || ${githubExpressionStringLiteral(`${name} (control event)`)} }}`

export const skipNonMaterializingPrControlEventLines = (name: string) => [
  `if [ "\${{ ${requiredCiMaterializingEvent} }}" != "true" ]; then`,
  `  ${annotationLine('notice', `${name} does not publish required evidence for non-materializing PR events.`)}`,
  '  exit 0',
  'fi',
]

export const githubApiGetFunctionLines = [
  'github_api_get() {',
  '  local attempt=1',
  '  local max_attempts=5',
  '  local delay=2',
  '  local status',
  '  while :; do',
  '    curl -fsSL "$@"',
  '    status=$?',
  '    if [ "$status" -eq 0 ]; then',
  '      return 0',
  '    fi',
  '    if [ "$attempt" -ge "$max_attempts" ]; then',
  '      return "$status"',
  '    fi',
  '    echo "::warning::GitHub API request failed (attempt $attempt/$max_attempts); retrying in ${delay}s." >&2',
  '    sleep "$delay"',
  '    attempt=$((attempt + 1))',
  '    delay=$((delay * 2))',
  '  done',
  '}',
] as const

export type MergeQueueAdmissionCheckOptions = {
  readonly failureMessage: string
  readonly notice: string
  readonly trustNeedsAdmission?: boolean
}

export const mergeQueueAdmissionCheckLines = ({
  failureMessage,
  notice,
  trustNeedsAdmission = false,
}: MergeQueueAdmissionCheckOptions) => [
  ...githubApiGetFunctionLines,
  'if [ "${{ github.event_name }}" = "pull_request" ]; then',
  '  if jq -e \'.pull_request.merged == true\' "$GITHUB_EVENT_PATH" >/dev/null; then',
  `    ${annotationLine('notice', 'Pull request is already merged; treating post-merge label cleanup as non-blocking.')}`,
  '    exit 0',
  '  fi',
  '  mq_ci_admitted=false',
  ...(trustNeedsAdmission
    ? [
        '  if [ -n "${NEEDS_JSON:-}" ] && printf \'%s\\n\' "$NEEDS_JSON" | jq -e \'.["mq-admission"].result == "success"\' >/dev/null; then',
        '    mq_ci_admitted=true',
        '  fi',
      ]
    : []),
  '  token="${GITHUB_TOKEN:-}"',
  '  if [ "$mq_ci_admitted" != true ] && [ -n "$token" ]; then',
  '    labels_json=$(github_api_get -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "${{ github.api_url }}/repos/${{ github.repository }}/issues/${{ github.event.pull_request.number }}/labels?per_page=100")',
  `    if printf '%s\\n' "$labels_json" | jq -e --arg label ${shellSingleQuote(mergeQueueAdmissionLabel)} 'any(.[]?; .name == $label)' >/dev/null; then`,
  '      mq_ci_admitted=true',
  '    fi',
  `  elif [ "$mq_ci_admitted" != true ] && jq -e '.pull_request.labels[]?.name == "${mergeQueueAdmissionLabel}"' "$GITHUB_EVENT_PATH" >/dev/null; then`,
  '    mq_ci_admitted=true',
  '  fi',
  '  if [ "$mq_ci_admitted" != true ]; then',
  `    ${annotationLine('error', failureMessage)}`,
  `    ${annotationLine('notice', notice)}`,
  '    exit 1',
  '  fi',
  'fi',
]

export type MergeQueueAdmissionStepOptions = {
  readonly failureMessage?: string
  readonly notice?: string
  readonly tokenExpression?: string
}

export const mergeQueueAdmissionStep = (opts: MergeQueueAdmissionStepOptions = {}) => ({
  name: 'Check Hypermerge admission',
  shell: 'bash',
  env: {
    GITHUB_TOKEN: opts.tokenExpression ?? '${{ secrets.GITHUB_TOKEN }}',
  },
  run: [
    'set -euo pipefail',
    ...mergeQueueAdmissionCheckLines({
      failureMessage: opts.failureMessage ?? 'waiting for Hypermerge admission (mq:ci-admitted).',
      notice: opts.notice ?? 'Semantic gates fail closed until Hypermerge admits the queue head.',
    }),
  ].join('\n'),
})

export type MergeQueueAdmittedJobOptions = Omit<
  WorkflowJob,
  'if' | 'permissions' | 'runs-on' | 'steps'
> & {
  readonly runsOn?: string | readonly string[]
  readonly permissions?: WorkflowJob['permissions']
  readonly steps: readonly WorkflowStep[]
  readonly admission?: MergeQueueAdmissionStepOptions
}

export const mergeQueueAdmittedJob = ({
  runsOn = ['nix'],
  permissions = {
    contents: 'read',
    issues: 'read',
    'pull-requests': 'read',
  },
  steps,
  admission,
  ...jobOptions
}: MergeQueueAdmittedJobOptions): WorkflowJob => ({
  if: nonScheduleRequiredGateIf,
  'runs-on': Array.isArray(runsOn) === true ? [...runsOn] : runsOn,
  permissions: mergeRequiredAdmissionPermissions(permissions),
  steps: [
    mergeQueueAdmissionStep({
      failureMessage: 'legacy required check is waiting for Hypermerge admission (mq:ci-admitted).',
      notice:
        'The full CI lane is intentionally gated so non-admitted PRs do not consume scarce Nix runners ahead of the queue head.',
      ...admission,
    }),
    ...steps,
  ],
  ...jobOptions,
})

export type MergeQueueAdmissionGateJobOptions = MergeQueueAdmissionStepOptions & {
  readonly runsOn?: string | readonly string[]
  readonly timeoutMinutes?: number
}

export const mergeQueueAdmissionGateJob = ({
  runsOn = ['nix'],
  timeoutMinutes = 5,
  ...stepOptions
}: MergeQueueAdmissionGateJobOptions = {}): WorkflowJob => ({
  name: 'mq/admission',
  if: nonScheduleRequiredGateIf,
  'runs-on': Array.isArray(runsOn) === true ? [...runsOn] : runsOn,
  'timeout-minutes': timeoutMinutes,
  permissions: defaultMergeQueuePermissions,
  steps: [mergeQueueAdmissionStep(stepOptions)],
})

export type MergeQueueSemanticGateJobOptions = {
  readonly name: string
  readonly needs: readonly string[]
  readonly runsOn?: string | readonly string[]
  readonly timeoutMinutes?: number
  readonly tokenExpression?: string
}

export type MergeQueueSemanticGateSpec = MergeQueueSemanticGateJobOptions & {
  readonly id: string
}

export const mergeQueueAdmissionDeferredLines = (name: string) =>
  mergeQueueAdmissionCheckLines({
    failureMessage: `${name} is waiting for Hypermerge admission (mq:ci-admitted).`,
    notice:
      'The full CI lane is intentionally gated so non-admitted PRs do not consume scarce Nix runners ahead of the queue head.',
    trustNeedsAdmission: true,
  })

export const mergeQueueSemanticGateJob = ({
  name,
  needs,
  runsOn = ['nix'],
  timeoutMinutes = 20,
  tokenExpression = '${{ secrets.GITHUB_TOKEN }}',
}: MergeQueueSemanticGateJobOptions): WorkflowJob => ({
  name: requiredGateCheckName(name),
  if: nonScheduleRequiredGateIf,
  'runs-on': Array.isArray(runsOn) === true ? [...runsOn] : runsOn,
  'timeout-minutes': timeoutMinutes,
  permissions: defaultMergeQueuePermissions,
  needs: [...needs],
  steps: [
    {
      name: `Check ${name} gate`,
      shell: 'bash',
      env: {
        NEEDS_JSON: '${{ toJSON(needs) }}',
        GITHUB_TOKEN: tokenExpression,
      },
      run: [
        'set -euo pipefail',
        ...skipNonMaterializingPrControlEventLines(name),
        ...mergeQueueAdmissionDeferredLines(name),
        'printf \'%s\\n\' "$NEEDS_JSON" | jq .',
        'failed=$(printf \'%s\\n\' "$NEEDS_JSON" | jq -r \'[to_entries[] | select(.value.result != "success") | "\\(.key)=\\(.value.result)"] | join(", ")\')',
        'if [ -n "$failed" ]; then',
        `  printf '%s\\n' ${shellSingleQuote(`::error::${name} gate blocked by: `)}"$failed"`,
        '  exit 1',
        'fi',
      ].join('\n'),
    },
  ],
})

export const mergeQueueSemanticGateJobs = (gates: readonly MergeQueueSemanticGateSpec[]) =>
  Object.fromEntries(gates.map(({ id, ...gate }) => [id, mergeQueueSemanticGateJob(gate)]))
