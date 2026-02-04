import { githubRuleset } from '../packages/@overeng/genie/src/runtime/mod.ts'

/**
 * GitHub Repository Ruleset for protecting the main branch.
 *
 * Apply with:
 * ```bash
 * gh api repos/overengineeringstudio/effect-utils/rulesets --method POST --input .github/repo-settings.json
 * ```
 *
 * Update existing (get ruleset_id from `gh api repos/overengineeringstudio/effect-utils/rulesets`):
 * ```bash
 * gh api repos/overengineeringstudio/effect-utils/rulesets/{ruleset_id} --method PUT --input .github/repo-settings.json
 * ```
 */
export default githubRuleset({
  name: 'protect-main',
  enforcement: 'active',
  target: 'branch',
  conditions: {
    ref_name: {
      include: ['~DEFAULT_BRANCH'],
      exclude: [],
    },
  },
  rules: [
    // Require PRs (no direct pushes)
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: true,
      },
    },
    // Require CI to pass
    {
      type: 'required_status_checks',
      parameters: {
        do_not_enforce_on_create: true, // Allow first push
        strict_required_status_checks_policy: true,
        required_status_checks: [
          { context: 'typecheck' },
          { context: 'lint' },
          { context: 'test' },
          { context: 'nix-check' },
        ],
      },
    },
    // Prevent force push
    { type: 'non_fast_forward' },
    // Prevent branch deletion
    { type: 'deletion' },
  ],
})
