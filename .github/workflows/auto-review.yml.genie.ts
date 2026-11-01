import { autoReviewWorkflow } from '../../genie/auto-review.ts'
import { effectUtilsWorkflowPolicy } from '../../genie/ci-workflow/policy.ts'
import { linuxX64Runner } from '../../genie/ci-workflow/runners.ts'
import { githubWorkflow } from '../../packages/@overeng/genie/src/runtime/mod.ts'

const workflow = autoReviewWorkflow({
  policy: effectUtilsWorkflowPolicy('auto-review.yml'),
  runner: linuxX64Runner,
}).data

export default githubWorkflow({
  ...workflow,
  jobs: {
    'request-review': {
      ...workflow.jobs['request-review'],
      steps: workflow.jobs['request-review'].steps.map((step) =>
        step.name.startsWith('Request review') === true
          ? {
              ...step,
              shell: 'nix shell nixpkgs#curl --command bash --noprofile --norc -e -o pipefail {0}',
            }
          : step,
      ),
    },
  },
})
