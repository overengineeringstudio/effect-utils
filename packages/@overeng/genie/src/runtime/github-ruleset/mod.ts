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
  parameters?: {
    /** Allow fetch and merge updates (pull from upstream without pushing). */
    update_allows_fetch_and_merge?: boolean
  }
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
  parameters?: {
    /** Number of required approving reviews (0-10). */
    required_approving_review_count?: number
    /** Dismiss stale reviews when new commits are pushed. */
    dismiss_stale_reviews_on_push?: boolean
    /** Require review from code owners. */
    require_code_owner_review?: boolean
    /** Require approval from someone other than the last pusher. */
    require_last_push_approval?: boolean
    /** Require all review threads to be resolved. */
    required_review_thread_resolution?: boolean
    /**
     * Allowed merge methods when merging pull requests.
     * @since GitHub Enterprise Server 3.13+
     */
    allowed_merge_methods?: Array<'merge' | 'squash' | 'rebase'>
    /**
     * Users or teams required to review.
     * Required by API even if empty.
     */
    required_reviewers?: Array<{ reviewer_id: number; reviewer_type: 'User' | 'Team' }>
  }
}

/**
 * Require status checks to pass before merging.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass
 */
type RequiredStatusChecksRule = {
  type: 'required_status_checks'
  parameters: {
    /** Status checks that must pass. */
    required_status_checks: Array<{
      /** Status check context name (must match CI job name). */
      context: string
      /** Optional GitHub App integration ID that must provide the check. */
      integration_id?: number
    }>
    /** Require branch to be up-to-date with the base branch before merging. */
    strict_required_status_checks_policy?: boolean
    /** Skip enforcement when branch is first created (allows initial push). */
    do_not_enforce_on_create?: boolean
  }
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
  parameters: {
    /** Environment names that must have successful deployments. */
    required_deployment_environments: string[]
  }
}

/**
 * Require merge queue for all pull request merges.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-merge-queue
 */
type MergeQueueRule = {
  type: 'merge_queue'
  parameters?: {
    /** Merge method: MERGE, SQUASH, or REBASE. */
    merge_method?: 'MERGE' | 'SQUASH' | 'REBASE'
    /** Minimum entries to reach before dequeuing (1-100). */
    min_entries_to_merge?: number
    /** Maximum entries to merge at once (1-100). */
    max_entries_to_merge?: number
    /** Minutes to wait for minimum entries before dequeuing (1-360). */
    min_entries_to_merge_wait_minutes?: number
    /** Maximum concurrent merge group builds (1-100). */
    max_entries_to_build?: number
    /** Grouping strategy: ALLGREEN or HEADGREEN. */
    grouping_strategy?: 'ALLGREEN' | 'HEADGREEN'
    /** Minutes to wait for status checks (1-360). */
    check_response_timeout_minutes?: number
  }
}

// ============================================================================
// Pattern Rules (some Enterprise-only)
// ============================================================================

/** Pattern matching operators for pattern-based rules. */
type PatternOperator = 'starts_with' | 'ends_with' | 'contains' | 'regex'

/** Common parameters for pattern-based rules. */
type PatternParameters = {
  /** The pattern to match. */
  pattern: string
  /** How to match the pattern. @default 'contains' */
  operator?: PatternOperator
  /** If true, the rule passes when the pattern does NOT match. */
  negate?: boolean
  /** Human-readable name for the rule. */
  name?: string
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

// ============================================================================
// File Restrictions (push target only)
// ============================================================================

/**
 * Restrict pushes that modify specified file paths.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#file-path-restrictions
 * @note Only valid for `push` target rulesets
 */
type FilePathRestrictionRule = {
  type: 'file_path_restriction'
  parameters: {
    /** File paths to restrict (fnmatch patterns, max 200). */
    restricted_file_paths: string[]
  }
}

/**
 * Restrict pushes that add files with specified extensions.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#file-extension-restrictions
 * @note Only valid for `push` target rulesets
 */
type FileExtensionRestrictionRule = {
  type: 'file_extension_restriction'
  parameters: {
    /** File extensions to restrict (no leading dot, max 200). */
    restricted_file_extensions: string[]
  }
}

/**
 * Restrict pushes that add files with paths exceeding a length.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#max-file-path-length
 * @note Only valid for `push` target rulesets
 */
type MaxFilePathLengthRule = {
  type: 'max_file_path_length'
  parameters: {
    /** Maximum file path length (1-256). */
    max_file_path_length: number
  }
}

/**
 * Restrict pushes that add files exceeding a size limit.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#max-file-size
 * @note Only valid for `push` target rulesets
 */
type MaxFileSizeRule = {
  type: 'max_file_size'
  parameters: {
    /** Maximum file size in MB (1-100). */
    max_file_size: number
  }
}

// ============================================================================
// Code Quality & Security
// ============================================================================

/**
 * Require code scanning results to pass.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-code-scanning-results
 */
type CodeScanningRule = {
  type: 'code_scanning'
  parameters: {
    /** Code scanning tools and their alert thresholds. */
    code_scanning_tools: Array<{
      /** Tool name (e.g., 'CodeQL'). */
      tool: string
      /** Alert severity threshold for general alerts. */
      alerts_threshold: 'none' | 'errors' | 'errors_and_warnings' | 'all'
      /** Alert severity threshold for security alerts. */
      security_alerts_threshold: 'none' | 'critical' | 'high_or_higher' | 'medium_or_higher' | 'all'
    }>
  }
}

/**
 * Require specific workflows to pass.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass
 * @note Enterprise Cloud / Server only
 */
type WorkflowsRule = {
  type: 'workflows'
  parameters: {
    /** Skip enforcement when branch is first created. */
    do_not_enforce_on_create?: boolean
    /** Workflows that must pass. */
    workflows: Array<{
      /** Path to the workflow file (e.g., '.github/workflows/ci.yml'). */
      path: string
      /** Repository ID where the workflow is defined. */
      repository_id: number
      /** Git ref (branch/tag) containing the workflow. */
      ref?: string
      /** Specific commit SHA of the workflow. */
      sha?: string
    }>
  }
}

// ============================================================================
// Bypass Actors
// ============================================================================

/**
 * Actor types that can bypass ruleset restrictions.
 * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
 */
type BypassActorType =
  | 'Integration' // GitHub App
  | 'OrganizationAdmin'
  | 'RepositoryRole' // Repository role (Admin, Write, etc.)
  | 'Team'
  | 'DeployKey'

/**
 * Configuration for an actor that can bypass ruleset restrictions.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#granting-bypass-permissions-for-your-ruleset
 */
export type BypassActor = {
  /** Actor ID (GitHub App ID, Team ID, or Repository Role ID). */
  actor_id: number
  /** Type of actor. */
  actor_type: BypassActorType
  /** When the actor can bypass: always, or only via pull requests. */
  bypass_mode: 'always' | 'pull_request'
}

// ============================================================================
// Conditions
// ============================================================================

/**
 * Conditions that determine when the ruleset applies.
 * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
 */
export type RulesetConditions = {
  /** Ref name patterns for matching branches/tags. */
  ref_name: {
    /**
     * Patterns to include. Special patterns:
     * - `~DEFAULT_BRANCH`: Matches the default branch
     * - `~ALL`: Matches all refs
     * - Glob patterns: `refs/heads/feature/*`, `release/**`
     */
    include: string[]
    /** Patterns to exclude from the ruleset. */
    exclude?: string[]
  }
}

// ============================================================================
// Main Args Type
// ============================================================================

/**
 * Arguments for creating a GitHub Repository Ruleset configuration.
 * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
 * @see https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
 */
export type GithubRulesetArgs = {
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
  enforcement: 'active' | 'disabled' | 'evaluate'

  /**
   * Target type for the ruleset.
   * - `branch`: Rules apply to branch refs
   * - `tag`: Rules apply to tag refs
   * - `push`: Rules apply to push operations (enables file restriction rules)
   * @default 'branch'
   * @see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
   */
  target?: 'branch' | 'tag' | 'push'

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
