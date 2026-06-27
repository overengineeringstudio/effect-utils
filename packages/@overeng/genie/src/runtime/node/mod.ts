/**
 * `@overeng/genie/node` — the node-resident genie entry.
 *
 * Re-exports the entire isomorphic `.` surface plus the node-only members that cannot live there because they
 * touch `node:*`/Bun/spawn: the {@link nodeGenieIO} capability the engine injects, the actionlint runner, the
 * github-ruleset reconcile operations, the fs-discovery `tsconfigJsonFromPackages`, and the repo-context API.
 *
 * Importing this entry pulls node into the program, so a typechecking consumer that only needs genie's types
 * (or pure builders) should import `@overeng/genie` (`.`) instead.
 */

export * from '../mod.ts'

export { nodeGenieIO } from './io.ts'
export { tsconfigJsonFromPackages } from './tsconfig-from-packages.ts'

export { runActionlint } from '../github-workflow/actionlint.ts'

export {
  diffGithubRuleset,
  formatGithubRulesetReport,
  normalizeGithubRulesetForComparison,
  reconcileGithubRuleset,
  type GithubRulesetOptions,
  type GithubRulesetReport,
  type RulesetDiff,
  type RulesetMode,
} from '../github-ruleset/reconcile.ts'

export * from '../repo-context/mod.ts'
