import { autoReviewWorkflow } from '../../genie/auto-review.ts'
import { namespaceRunner } from '../../genie/ci-workflow.ts'

export default autoReviewWorkflow({
  runner: namespaceRunner({
    profile: 'namespace-profile-linux-x86-64',
    runId: '${{ github.run_id }}',
  }),
})
