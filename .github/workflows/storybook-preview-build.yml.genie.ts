import {
  bashShellDefaults,
  checkoutStep,
  ciWorkflow,
  type CiWorkflowArgs,
  netlifyPreviewBuildSteps,
} from '../../genie/ci-workflow.ts'
import {
  storybookPaths,
  storybookPreviewBuildWorkflowName,
  storybookPreviewRunner,
  storybookPreviewSetupSteps,
} from '../../genie/storybook-preview.ts'
import { withBuck2CacheEvidence } from '../../genie/ci-workflow/buck2-cache-evidence.ts'
import { buck2CachePostureEnv } from '../../genie/ci-workflow/buck2-cache-posture.ts'

// Untrusted half of the Storybook preview split: PR code builds the storybooks
// with no secrets and uploads the static output. `storybook-preview-deploy.yml`
// deploys it from the default branch.
// oxlint-disable-next-line overeng/exports-first -- generated entrypoint
export default ciWorkflow({
  trustTier: 'public',
  name: storybookPreviewBuildWorkflowName,
  on: {
    pull_request: { types: ['opened', 'reopened', 'synchronize'], paths: storybookPaths },
  },
  permissions: { contents: 'read' },
  jobs: withBuck2CacheEvidence({
    'build-storybooks': {
      'runs-on': storybookPreviewRunner,
      'timeout-minutes': 30,
      permissions: { contents: 'read' },
      defaults: bashShellDefaults,
      env: buck2CachePostureEnv('reader'),
      steps: [checkoutStep(), ...storybookPreviewSetupSteps, ...netlifyPreviewBuildSteps()],
    },
  }),
} satisfies CiWorkflowArgs)
