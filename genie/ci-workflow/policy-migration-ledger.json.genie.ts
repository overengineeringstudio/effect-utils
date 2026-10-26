import autoReview from '../../.github/workflows/auto-review.yml.genie.ts'
import ci from '../../.github/workflows/ci.yml.genie.ts'
import compiledProducts from '../../.github/workflows/compiled-products.yml.genie.ts'
import empiricalProofs from '../../.github/workflows/empirical-proofs.yml.genie.ts'
import storybookPlays from '../../.github/workflows/storybook-plays.yml.genie.ts'
import storybookPreviewBuild from '../../.github/workflows/storybook-preview-build.yml.genie.ts'
import storybookPreviewDeploy from '../../.github/workflows/storybook-preview-deploy.yml.genie.ts'
import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { collectWorkflowPolicyViolations } from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'
import { fleetWorkflowPolicy, validateFleetPolicyExceptionRegistry } from './policy.ts'

const workflows = {
  'auto-review.yml': autoReview,
  'ci.yml': ci,
  'compiled-products.yml': compiledProducts,
  'empirical-proofs.yml': empiricalProofs,
  'storybook-plays.yml': storybookPlays,
  'storybook-preview-build.yml': storybookPreviewBuild,
  'storybook-preview-deploy.yml': storybookPreviewDeploy,
}

validateFleetPolicyExceptionRegistry({
  repository: 'overengineeringstudio/effect-utils',
  workflows: Object.fromEntries(
    Object.entries(workflows).map(([name, output]) => [name, output.data]),
  ),
})

const data = {
  source: 'policy-migration-ledger.json.genie.ts',
  violations: Object.entries(workflows).flatMap(([workflow, output]) =>
    collectWorkflowPolicyViolations({
      workflow: output.data,
      policy: fleetWorkflowPolicy({ repository: 'overengineeringstudio/effect-utils', workflow }),
    }),
  ),
}

/** Imports enforce exact ledger membership before regeneration: additions cannot self-admit. */
export default createGenieOutput({
  data,
  stringify: () => JSON.stringify(data, undefined, 2) + '\n',
})
