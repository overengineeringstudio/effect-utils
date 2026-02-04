/**
 * Type-safe GitHub Repository Ruleset generator.
 *
 * Generates JSON configuration files for GitHub Repository Rulesets that can be
 * applied via the GitHub REST API using the `gh` CLI.
 *
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
 * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
 *
 * @example Apply with gh CLI
 * ```bash
 * # Create new ruleset
 * gh api repos/{owner}/{repo}/rulesets --method POST --input .github/repo-settings.json
 *
 * # Update existing ruleset
 * gh api repos/{owner}/{repo}/rulesets/{ruleset_id} --method PUT --input .github/repo-settings.json
 * ```
 */

import type { GenieOutput, Strict } from '../mod.ts'

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Pattern matching operators for pattern-based rules.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#metadata-restrictions
 */
export type PatternOperator = 'starts_with' | 'ends_with' | 'contains' | 'regex'

// ============================================================================
// Parameter Interfaces (exported for JSDoc visibility)
// ============================================================================

/**
 * Parameters for the `update` rule.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#restrict-updates
 */
export interface UpdateParameters {
  /**
   * Allow fetch and merge updates (pull from upstream without pushing).
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#restrict-updates
   */
  update_allows_fetch_and_merge: boolean
}

/**
 * Required reviewer configuration for file-pattern based review requirements.
 * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
 * @note Beta feature
 */
export interface RequiredReviewer {
  /** File path patterns that trigger this review requirement (fnmatch syntax). */
  file_patterns: string[]
  /** Minimum number of approvals required from this reviewer. */
  minimum_approvals: number
  /** The reviewer (team) configuration. */
  reviewer: {
    /** Team ID. */
    id: number
    /** Must be "Team". */
    type: 'Team'
  }
}

/**
 * Parameters for the `pull_request` rule.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging
 */
export interface PullRequestParameters {
  /**
   * Number of required approving reviews (0-10).
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging
   */
  required_approving_review_count: number
  /**
   * Dismiss stale reviews when new commits are pushed.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging
   */
  dismiss_stale_reviews_on_push: boolean
  /**
   * Require review from code owners.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging
   */
  require_code_owner_review: boolean
  /**
   * Require approval from someone other than the last pusher.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging
   */
  require_last_push_approval: boolean
  /**
   * Require all review threads to be resolved.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging
   */
  required_review_thread_resolution: boolean
  /**
   * Allowed merge methods when merging pull requests.
   * At least one method must be specified if this field is present.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging
   */
  allowed_merge_methods?: Array<'merge' | 'squash' | 'rebase'>
  /**
   * File-pattern based required reviewers.
   * Maximum 15 entries.
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   * @note Beta feature
   */
  required_reviewers?: RequiredReviewer[]
}

/**
 * Status check configuration.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass
 */
export interface StatusCheck {
  /**
   * Status check context name (must match CI job name).
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass
   */
  context: string
  /**
   * Optional GitHub App integration ID that must provide the check.
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   */
  integration_id?: number
}

/**
 * Parameters for the `required_status_checks` rule.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass
 */
export interface RequiredStatusChecksParameters {
  /**
   * Status checks that must pass.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass
   */
  required_status_checks: StatusCheck[]
  /**
   * Require branch to be up-to-date with the base branch before merging.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass
   */
  strict_required_status_checks_policy: boolean
  /**
   * Skip enforcement when branch is first created (allows initial push).
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   */
  do_not_enforce_on_create?: boolean
}

/**
 * Parameters for the `required_deployments` rule.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-deployments-to-succeed
 */
export interface RequiredDeploymentsParameters {
  /**
   * Environment names that must have successful deployments.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-deployments-to-succeed
   */
  required_deployment_environments: string[]
}

/**
 * Parameters for the `merge_queue` rule.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-merge-queue
 */
export interface MergeQueueParameters {
  /**
   * Merge method: MERGE, SQUASH, or REBASE.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-merge-queue
   */
  merge_method: 'MERGE' | 'SQUASH' | 'REBASE'
  /**
   * Minimum entries to reach before dequeuing (0-100).
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-merge-queue
   */
  min_entries_to_merge: number
  /**
   * Maximum entries to merge at once (0-100).
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-merge-queue
   */
  max_entries_to_merge: number
  /**
   * Minutes to wait for minimum entries before dequeuing (0-360).
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-merge-queue
   */
  min_entries_to_merge_wait_minutes: number
  /**
   * Maximum concurrent merge group builds (0-100).
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-merge-queue
   */
  max_entries_to_build: number
  /**
   * Grouping strategy: ALLGREEN or HEADGREEN.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-merge-queue
   */
  grouping_strategy: 'ALLGREEN' | 'HEADGREEN'
  /**
   * Minutes to wait for status checks (0-360).
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-merge-queue
   */
  check_response_timeout_minutes: number
}

/**
 * Parameters for pattern-based rules (commit_message_pattern, branch_name_pattern, etc.).
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#metadata-restrictions
 * @note Enterprise Cloud / Server only
 */
export interface PatternParameters {
  /**
   * The pattern to match.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#metadata-restrictions
   */
  pattern: string
  /**
   * How to match the pattern.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#metadata-restrictions
   */
  operator: PatternOperator
  /**
   * If true, the rule passes when the pattern does NOT match.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#metadata-restrictions
   */
  negate?: boolean
  /**
   * Human-readable name for the rule.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#metadata-restrictions
   */
  name?: string
}

/**
 * Parameters for the `file_path_restriction` rule.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#file-path-restrictions
 * @note Only valid for `push` target rulesets
 */
export interface FilePathRestrictionParameters {
  /**
   * File paths to restrict (fnmatch patterns).
   * Maximum 200 entries, 200 characters each.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#file-path-restrictions
   */
  restricted_file_paths: string[]
}

/**
 * Parameters for the `file_extension_restriction` rule.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#file-extension-restrictions
 * @note Only valid for `push` target rulesets
 */
export interface FileExtensionRestrictionParameters {
  /**
   * File extensions to restrict (no leading dot).
   * Maximum 200 entries, 200 characters each.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#file-extension-restrictions
   */
  restricted_file_extensions: string[]
}

/**
 * Parameters for the `max_file_path_length` rule.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#max-file-path-length
 * @note Only valid for `push` target rulesets
 */
export interface MaxFilePathLengthParameters {
  /**
   * Maximum file path length in characters (1-32767).
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#max-file-path-length
   */
  max_file_path_length: number
}

/**
 * Parameters for the `max_file_size` rule.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#max-file-size
 * @note Only valid for `push` target rulesets
 */
export interface MaxFileSizeParameters {
  /**
   * Maximum file size in MB (1-100). Excludes Git LFS files.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#max-file-size
   */
  max_file_size: number
}

/**
 * Workflow configuration for the `workflows` rule.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass
 */
export interface WorkflowConfig {
  /**
   * Path to the workflow file (e.g., '.github/workflows/ci.yml').
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass
   */
  path: string
  /**
   * Repository ID where the workflow is defined.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass
   */
  repository_id: number
  /**
   * Git ref (branch/tag) containing the workflow.
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   */
  ref?: string
  /**
   * Specific commit SHA of the workflow.
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   */
  sha?: string
}

/**
 * Parameters for the `workflows` rule.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass
 * @note Enterprise Cloud / Server only
 */
export interface WorkflowsParameters {
  /**
   * Workflows that must pass.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass
   */
  workflows: WorkflowConfig[]
  /**
   * Skip enforcement when branch is first created.
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   */
  do_not_enforce_on_create?: boolean
}

/**
 * Code scanning tool configuration.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-code-scanning-results
 */
export interface CodeScanningTool {
  /**
   * Tool name (e.g., 'CodeQL').
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-code-scanning-results
   */
  tool: string
  /**
   * Alert severity threshold for general alerts.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-code-scanning-results
   */
  alerts_threshold: 'none' | 'errors' | 'errors_and_warnings' | 'all'
  /**
   * Alert severity threshold for security alerts.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-code-scanning-results
   */
  security_alerts_threshold: 'none' | 'critical' | 'high_or_higher' | 'medium_or_higher' | 'all'
}

/**
 * Parameters for the `code_scanning` rule.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-code-scanning-results
 */
export interface CodeScanningParameters {
  /**
   * Code scanning tools and their alert thresholds.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-code-scanning-results
   */
  code_scanning_tools: CodeScanningTool[]
}

/**
 * Parameters for the `copilot_code_review` rule.
 * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
 * @note Beta feature
 */
export interface CopilotCodeReviewParameters {
  /**
   * Review draft pull requests.
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   */
  review_draft_pull_requests?: boolean
  /**
   * Review on each push.
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   */
  review_on_push?: boolean
}

// ============================================================================
// Rule Types - Discriminated Union
// ============================================================================

/**
 * All available ruleset rule types.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
 */
export type RulesetRule =
  // Ref Management
  | CreationRule
  | UpdateRule
  | DeletionRule
  | NonFastForwardRule
  | RequiredLinearHistoryRule
  // Pull Request & Review
  | PullRequestRule
  | MergeQueueRule
  // Status & Deployment
  | RequiredStatusChecksRule
  | RequiredDeploymentsRule
  // Commit & Signature
  | RequiredSignaturesRule
  | CommitMessagePatternRule
  | CommitAuthorEmailPatternRule
  | CommitterEmailPatternRule
  // Naming Patterns
  | BranchNamePatternRule
  | TagNamePatternRule
  // File Restrictions (push target only)
  | FilePathRestrictionRule
  | FileExtensionRestrictionRule
  | MaxFilePathLengthRule
  | MaxFileSizeRule
  // Code Quality & Security
  | CodeScanningRule
  | WorkflowsRule
  | CopilotCodeReviewRule

// ============================================================================
// Individual Rule Definitions
// ============================================================================

/**
 * Restrict who can create matching refs.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#restrict-creations
 */
type CreationRule = { type: 'creation' }

/**
 * Restrict who can update matching refs.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#restrict-updates
 */
type UpdateRule = {
  type: 'update'
  parameters?: UpdateParameters
}

/**
 * Restrict who can delete matching refs.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#restrict-deletions
 */
type DeletionRule = { type: 'deletion' }

/**
 * Prevent non-fast-forward pushes (force pushes).
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#block-force-pushes
 */
type NonFastForwardRule = { type: 'non_fast_forward' }

/**
 * Require linear history (no merge commits).
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-linear-history
 */
type RequiredLinearHistoryRule = { type: 'required_linear_history' }

/**
 * Require pull request before merging.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging
 */
type PullRequestRule = {
  type: 'pull_request'
  parameters?: PullRequestParameters
}

/**
 * Require status checks to pass before merging.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass
 */
type RequiredStatusChecksRule = {
  type: 'required_status_checks'
  parameters: RequiredStatusChecksParameters
}

/**
 * Require signed commits.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-signed-commits
 */
type RequiredSignaturesRule = { type: 'required_signatures' }

/**
 * Require successful deployment to environments before merging.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-deployments-to-succeed
 */
type RequiredDeploymentsRule = {
  type: 'required_deployments'
  parameters: RequiredDeploymentsParameters
}

/**
 * Require merge queue for all pull request merges.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-merge-queue
 */
type MergeQueueRule = {
  type: 'merge_queue'
  parameters?: MergeQueueParameters
}

/**
 * Require commit messages to match a pattern.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#metadata-restrictions
 * @note Enterprise Cloud / Server only
 */
type CommitMessagePatternRule = {
  type: 'commit_message_pattern'
  parameters: PatternParameters
}

/**
 * Require commit author email addresses to match a pattern.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#metadata-restrictions
 * @note Enterprise Cloud / Server only
 */
type CommitAuthorEmailPatternRule = {
  type: 'commit_author_email_pattern'
  parameters: PatternParameters
}

/**
 * Require committer email addresses to match a pattern.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#metadata-restrictions
 * @note Enterprise Cloud / Server only
 */
type CommitterEmailPatternRule = {
  type: 'committer_email_pattern'
  parameters: PatternParameters
}

/**
 * Require branch names to match a pattern.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#metadata-restrictions
 * @note Enterprise Cloud / Server only
 */
type BranchNamePatternRule = {
  type: 'branch_name_pattern'
  parameters: PatternParameters
}

/**
 * Require tag names to match a pattern.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#metadata-restrictions
 * @note Enterprise Cloud / Server only
 */
type TagNamePatternRule = {
  type: 'tag_name_pattern'
  parameters: PatternParameters
}

/**
 * Restrict pushes that modify specified file paths.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#file-path-restrictions
 * @note Only valid for `push` target rulesets
 */
type FilePathRestrictionRule = {
  type: 'file_path_restriction'
  parameters: FilePathRestrictionParameters
}

/**
 * Restrict pushes that add files with specified extensions.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#file-extension-restrictions
 * @note Only valid for `push` target rulesets
 */
type FileExtensionRestrictionRule = {
  type: 'file_extension_restriction'
  parameters: FileExtensionRestrictionParameters
}

/**
 * Restrict pushes that add files with paths exceeding a length.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#max-file-path-length
 * @note Only valid for `push` target rulesets
 */
type MaxFilePathLengthRule = {
  type: 'max_file_path_length'
  parameters: MaxFilePathLengthParameters
}

/**
 * Restrict pushes that add files exceeding a size limit.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#max-file-size
 * @note Only valid for `push` target rulesets
 */
type MaxFileSizeRule = {
  type: 'max_file_size'
  parameters: MaxFileSizeParameters
}

/**
 * Require code scanning results to pass.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-code-scanning-results
 */
type CodeScanningRule = {
  type: 'code_scanning'
  parameters: CodeScanningParameters
}

/**
 * Require specific workflows to pass.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass
 * @note Enterprise Cloud / Server only
 */
type WorkflowsRule = {
  type: 'workflows'
  parameters: WorkflowsParameters
}

/**
 * Require Copilot code review.
 * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
 * @note Beta feature
 */
type CopilotCodeReviewRule = {
  type: 'copilot_code_review'
  parameters?: CopilotCodeReviewParameters
}

// ============================================================================
// Bypass Actors
// ============================================================================

/**
 * Actor types that can bypass ruleset restrictions.
 * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
 */
export type BypassActorType =
  | 'Integration' // GitHub App
  | 'OrganizationAdmin'
  | 'RepositoryRole' // Repository role (Admin, Write, etc.)
  | 'Team'
  | 'DeployKey'

/**
 * Bypass mode determines when an actor can bypass rules.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#granting-bypass-permissions-for-your-ruleset
 */
export type BypassMode =
  | 'always' // Can always bypass rules
  | 'pull_request' // Can bypass rules via pull request only
  | 'exempt' // Actor cannot bypass rules

/**
 * Configuration for an actor that can bypass ruleset restrictions.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#granting-bypass-permissions-for-your-ruleset
 */
export interface BypassActor {
  /**
   * Actor ID (GitHub App ID, Team ID, or Repository Role ID).
   * Set to `null` for DeployKey type.
   *
   * Repository Role IDs:
   * - 4: Write
   * - 5: Maintain
   * - 6: Admin
   *
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   */
  actor_id: number | null
  /**
   * Type of actor.
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   */
  actor_type: BypassActorType
  /**
   * When the actor can bypass rules.
   * @default 'always'
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#granting-bypass-permissions-for-your-ruleset
   */
  bypass_mode?: BypassMode
}

// ============================================================================
// Conditions
// ============================================================================

/**
 * Ref name condition for targeting branches/tags.
 * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
 */
export interface RefNameCondition {
  /**
   * Patterns to include. Special patterns:
   * - `~DEFAULT_BRANCH`: Matches the repository's default branch
   * - `~ALL`: Matches all refs
   * - `refs/heads/*`: All branches
   * - `refs/tags/*`: All tags
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
   */
  include: string[]
  /**
   * Patterns to exclude from the ruleset.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
   */
  exclude: string[]
}

/**
 * Conditions that determine when the ruleset applies (repository-level).
 * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
 */
export interface RulesetConditions {
  /**
   * Ref name patterns for matching branches/tags.
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   */
  ref_name: RefNameCondition
}

// ============================================================================
// Main Args Type
// ============================================================================

/**
 * Target type for the ruleset.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
 */
export type RulesetTarget =
  | 'branch' // Target specific branches (default)
  | 'tag' // Target specific tags
  | 'push' // Target all pushes (enables file restriction rules)

/**
 * Enforcement level for the ruleset.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#about-rule-enforcement-statuses
 */
export type RulesetEnforcement =
  | 'active' // Rules are enforced
  | 'disabled' // Rules exist but are not enforced (useful for testing)
  | 'evaluate' // (Enterprise only) Rules are evaluated but violations don't block

/**
 * Arguments for creating a GitHub Repository Ruleset configuration.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
 * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
 */
export interface GithubRulesetArgs {
  /**
   * Ruleset name (must be unique within repository).
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   */
  name: string

  /**
   * Enforcement level for the ruleset.
   * - `active`: Rules are enforced
   * - `disabled`: Rules exist but are not enforced (useful for testing)
   * - `evaluate`: (Enterprise only) Rules are evaluated but violations don't block
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#about-rule-enforcement-statuses
   */
  enforcement: RulesetEnforcement

  /**
   * Target type for the ruleset.
   * - `branch`: Rules apply to branch refs (default)
   * - `tag`: Rules apply to tag refs
   * - `push`: Rules apply to push operations (enables file restriction rules)
   * @default 'branch'
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
   */
  target?: RulesetTarget

  /**
   * Conditions for when rules apply.
   * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
   */
  conditions?: RulesetConditions

  /**
   * Rules to enforce.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
   */
  rules: RulesetRule[]

  /**
   * Actors who can bypass the ruleset.
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#granting-bypass-permissions-for-your-ruleset
   */
  bypass_actors?: BypassActor[]
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a GitHub Repository Ruleset JSON configuration.
 *
 * Returns a `GenieOutput` with the structured data accessible via `.data`
 * for composition with other genie files.
 *
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
 *
 * @example
 * ```ts
 * import { githubRuleset } from '@overeng/genie'
 *
 * export default githubRuleset({
 *   name: 'protect-main',
 *   enforcement: 'active',
 *   target: 'branch',
 *   conditions: {
 *     ref_name: {
 *       include: ['~DEFAULT_BRANCH'],
 *       exclude: [],
 *     },
 *   },
 *   rules: [
 *     { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
 *     {
 *       type: 'required_status_checks',
 *       parameters: {
 *         required_status_checks: [{ context: 'ci' }],
 *         strict_required_status_checks_policy: true,
 *       },
 *     },
 *     { type: 'non_fast_forward' },
 *     { type: 'deletion' },
 *   ],
 * })
 * ```
 *
 * @example Apply with gh CLI
 * ```bash
 * # Create new ruleset
 * gh api repos/{owner}/{repo}/rulesets --method POST --input .github/repo-settings.json
 *
 * # Update existing ruleset (get ID from: gh api repos/{owner}/{repo}/rulesets)
 * gh api repos/{owner}/{repo}/rulesets/{ruleset_id} --method PUT --input .github/repo-settings.json
 * ```
 */
export const githubRuleset = <const T extends GithubRulesetArgs>(
  args: Strict<T, GithubRulesetArgs>,
): GenieOutput<T> => ({
  data: args,
  stringify: (_ctx) => JSON.stringify(args, null, 2) + '\n',
})
