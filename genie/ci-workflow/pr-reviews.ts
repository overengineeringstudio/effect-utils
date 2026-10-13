/**
 * Reusable "all PR review threads resolved" enforcement.
 *
 * Two halves that compose:
 * - {@link prReviewsPullRequestRule} flips the native ruleset flag
 *   (`required_review_thread_resolution`), which GitHub evaluates live at merge
 *   time. This half covers the retrigger gap: resolving a thread in the UI does
 *   not retrigger workflows (GitHub exposes thread resolution only as a webhook,
 *   not an Actions trigger), so a pure status check would stay red until a
 *   re-run or push.
 * - {@link prReviewsResolvedJob} emits a cheap, checkout-free status check that
 *   fails while any review thread is unresolved, giving early visible signal on
 *   the PR. Re-run it after resolving threads to refresh the signal.
 *
 * Peer repos reuse both halves from `genie/external.ts`: add the job to the
 * workflow and spread the rule into `repo-settings.json.genie.ts`.
 */

import type {
  GitHubWorkflowArgs,
  PullRequestParameters,
} from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { bashShellDefaults } from './shared.ts'

type WorkflowJob = GitHubWorkflowArgs['jobs'][string]
type WorkflowStep = WorkflowJob['steps'][number]

/** Job id (and therefore check context) of the review-thread resolution gate. */
export const prReviewsResolvedJobId = 'pr-reviews-resolved' as const

/** GraphQL shape paginating review threads and their resolution state. */
const reviewThreadsQuery =
  'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{isResolved}}}}}'

/** Upper bound on paginated review-thread pages (100 threads each). */
const maxReviewThreadPages = 5

const maxReviewThreads = maxReviewThreadPages * 100

/** Options for the review-thread resolution check step. */
export type PrReviewsResolvedStepOptions = {
  /** Token expression the `gh` CLI authenticates with. */
  readonly tokenExpression?: string
}

/**
 * Checkout-free step that fails while any review thread on the PR is unresolved.
 * Non-PR events succeed with a notice: there is no PR to gate.
 */
export const prReviewsResolvedStep = (
  opts: PrReviewsResolvedStepOptions = {},
): WorkflowStep => ({
  name: 'Check unresolved review threads',
  shell: 'bash',
  env: {
    GH_TOKEN: opts.tokenExpression ?? '${{ secrets.GITHUB_TOKEN }}',
  },
  run: [
    'set -euo pipefail',
    'if [ "${{ github.event_name }}" != "pull_request" ]; then',
    "  printf '%s\\n' '::notice::pr-reviews-resolved only gates pull requests; nothing to enforce.'",
    '  exit 0',
    'fi',
    'pr_number="${{ github.event.pull_request.number }}"',
    'if [[ ! "$pr_number" =~ ^[1-9][0-9]*$ ]]; then',
    "  printf '%s\\n' '::error::pr-reviews-resolved could not determine the pull request number.'",
    '  exit 1',
    'fi',
    'owner="${GITHUB_REPOSITORY%%/*}"',
    'name="${GITHUB_REPOSITORY#*/}"',
    `query='${reviewThreadsQuery}'`,
    'unresolved=0',
    'cursor=""',
    'page=0',
    'while :; do',
    '  page=$((page + 1))',
    `  if [ "$page" -gt ${maxReviewThreadPages} ]; then`,
    `    printf '%s\\n' '::error::pr-reviews-resolved found more than ${maxReviewThreads} review threads; refusing to paginate further.'`,
    '    exit 1',
    '  fi',
    '  if [ -z "$cursor" ]; then',
    '    page_json=$(gh api graphql -f query="$query" -f owner="$owner" -f name="$name" -F number="$pr_number")',
    '  else',
    '    page_json=$(gh api graphql -f query="$query" -f owner="$owner" -f name="$name" -F number="$pr_number" -f cursor="$cursor")',
    '  fi',
    '  page_unresolved=$(printf \'%s\\n\' "$page_json" | jq \'[.data.repository.pullRequest.reviewThreads.nodes[]? | select(.isResolved == false)] | length\')',
    '  unresolved=$((unresolved + page_unresolved))',
    '  if [ "$(printf \'%s\\n\' "$page_json" | jq -r \'.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage\')" != "true" ]; then',
    '    break',
    '  fi',
    '  cursor=$(printf \'%s\\n\' "$page_json" | jq -r \'.data.repository.pullRequest.reviewThreads.pageInfo.endCursor\')',
    'done',
    'if [ "$unresolved" -gt 0 ]; then',
    '  printf \'%s\\n\' "::error::pr-reviews-resolved found $unresolved unresolved review thread(s); resolve them before merge, then re-run this check (thread resolution does not retrigger workflows)."',
    '  exit 1',
    'fi',
    'printf \'%s\\n\' "All review threads resolved on PR #$pr_number."',
  ].join('\n'),
})

/** Options for the review-thread resolution gate job. */
export type PrReviewsResolvedJobOptions = {
  /**
   * `runs-on` for the job. Defaults to GitHub-hosted Ubuntu: the check only
   * calls `gh api`, so it needs no Nix, no checkout, and no scarce-runner capacity.
   */
  readonly runsOn?: string | readonly string[]
  /** Job-level `if`; defaults to running on every non-schedule event. */
  readonly condition?: string
  readonly timeoutMinutes?: number
  readonly tokenExpression?: string
}

/**
 * Review-thread resolution gate job. Wire it into the workflow jobs map under
 * {@link prReviewsResolvedJobId} and list that id as a required status check.
 */
export const prReviewsResolvedJob = (
  opts: PrReviewsResolvedJobOptions = {},
): WorkflowJob => ({
  if: opts.condition ?? "${{ github.event_name != 'schedule' }}",
  'runs-on': opts.runsOn ?? 'ubuntu-latest',
  'timeout-minutes': opts.timeoutMinutes ?? 5,
  permissions: { 'pull-requests': 'read' },
  defaults: bashShellDefaults,
  steps: [prReviewsResolvedStep({ tokenExpression: opts.tokenExpression })],
})

/** Options overriding the shared pull-request rule that requires thread resolution. */
export type PrReviewsPullRequestRuleOptions = {
  readonly requiredApprovingReviewCount?: number
  readonly dismissStaleReviewsOnPush?: boolean
  readonly requireCodeOwnerReview?: boolean
  readonly requireLastPushApproval?: boolean
}

/**
 * `pull_request` ruleset rule with review-thread resolution required.
 * Defaults mirror this repo's protect-main rule; only the resolution flag differs.
 */
export const prReviewsPullRequestRule = (
  opts: PrReviewsPullRequestRuleOptions = {},
): { type: 'pull_request'; parameters: PullRequestParameters } => ({
  type: 'pull_request',
  parameters: {
    required_approving_review_count: opts.requiredApprovingReviewCount ?? 0,
    dismiss_stale_reviews_on_push: opts.dismissStaleReviewsOnPush ?? true,
    require_code_owner_review: opts.requireCodeOwnerReview ?? false,
    require_last_push_approval: opts.requireLastPushApproval ?? false,
    required_review_thread_resolution: true,
    required_reviewers: [],
  },
})
