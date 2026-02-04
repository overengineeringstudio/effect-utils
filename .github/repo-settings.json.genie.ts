import { githubRuleset } from '../packages/@overeng/genie/src/runtime/mod.ts'
import { requiredCIJobs } from '../genie/ci.ts'

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
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        required_reviewers: [],
      },
    },
    // Require CI to pass
    {
      type: 'required_status_checks',
      parameters: {
        do_not_enforce_on_create: true, // Allow first push
        strict_required_status_checks_policy: false, // Don't require branch to be up-to-date
        required_status_checks: requiredCIJobs.map((context) => ({ context })),
      },
    },
    // Prevent force push
    { type: 'non_fast_forward' },
    // Prevent branch deletion
    { type: 'deletion' },
  ],
  bypass_actors: [],
})
