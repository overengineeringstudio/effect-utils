import autoReview from '../../.github/workflows/auto-review.yml.genie.ts'
import ci from '../../.github/workflows/ci.yml.genie.ts'
import compiledProducts from '../../.github/workflows/compiled-products.yml.genie.ts'
import empiricalProofs from '../../.github/workflows/empirical-proofs.yml.genie.ts'
import storybookPlays from '../../.github/workflows/storybook-plays.yml.genie.ts'
import storybookPreviewBuild from '../../.github/workflows/storybook-preview-build.yml.genie.ts'
import storybookPreviewDeploy from '../../.github/workflows/storybook-preview-deploy.yml.genie.ts'
import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { validateWorkflowPolicy } from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'
import {
  collectFleetPolicyMigrationLedger,
  validateFleetPolicyExceptionRegistry,
} from './policy.ts'

const workflows = {
  'auto-review.yml': autoReview,
  'ci.yml': ci,
  'compiled-products.yml': compiledProducts,
  'empirical-proofs.yml': empiricalProofs,
  'storybook-plays.yml': storybookPlays,
  'storybook-preview-build.yml': storybookPreviewBuild,
  'storybook-preview-deploy.yml': storybookPreviewDeploy,
}

const workflowData = Object.fromEntries(
  Object.entries(workflows).map(([name, output]) => [name, output.data]),
)

validateFleetPolicyExceptionRegistry({
  repository: 'overengineeringstudio/effect-utils',
  workflows: workflowData,
})

const data = {
  source: 'policy-migration-ledger.json.genie.ts',
  violations: collectFleetPolicyMigrationLedger({
    repository: 'overengineeringstudio/effect-utils',
    workflows: workflowData,
  }),
}

/** Eager imports reject new/security debt; serialization admits content-only
 * re-keys only during genie:run. genie:check remains exact and detects stale rows.
 */
export default createGenieOutput({
  data,
  stringify: (ctx) => {
    for (const value of Object.values(workflowData))
      if (value.policy !== undefined)
        validateWorkflowPolicy({
          workflow: value,
          policy: value.policy,
          refreshLedger: ctx.mode === 'generate',
        })
    return JSON.stringify(data, undefined, 2) + '\n'
  },
})
