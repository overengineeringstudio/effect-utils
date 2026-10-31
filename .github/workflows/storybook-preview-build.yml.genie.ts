import {
  bashShellDefaults,
  checkoutStep,
  ciWorkflow,
  type CiWorkflowArgs,
  netlifyPreviewBuildSteps,
} from '../../genie/ci-workflow.ts'
import { withBuck2CacheEvidence } from '../../genie/ci-workflow/buck2-cache-evidence.ts'
import { buck2CachePostureEnv } from '../../genie/ci-workflow/buck2-cache-posture.ts'
import { effectUtilsWorkflowPolicy } from '../../genie/ci-workflow/policy.ts'
import { STORYBOOK_PREVIEW_BUILD_JOB_NAME } from '../../genie/ci.ts'
import {
  storybookPaths,
  storybookPreviewBuildWorkflowName,
  storybookPreviewRunner,
  storybookPreviewSetupSteps,
} from '../../genie/storybook-preview.ts'

// Untrusted half of the Storybook preview split: PR code builds the storybooks
// with no secrets and uploads the static output. `storybook-preview-deploy.yml`
// deploys it from the default branch.
// oxlint-disable-next-line overeng/exports-first -- generated entrypoint
export default ciWorkflow({
  policy: effectUtilsWorkflowPolicy('storybook-preview-build.yml'),
  trustTier: 'public',
  name: storybookPreviewBuildWorkflowName,
  on: {
    pull_request: { types: ['opened', 'reopened', 'synchronize'], paths: storybookPaths },
  },
  permissions: { contents: 'read' },
  jobs: withBuck2CacheEvidence({
    [STORYBOOK_PREVIEW_BUILD_JOB_NAME]: {
      'runs-on': storybookPreviewRunner('trusted'),
      'timeout-minutes': 30,
      permissions: { contents: 'read' },
      defaults: bashShellDefaults,
      env: buck2CachePostureEnv('reader'),
      steps: [
        checkoutStep(),
        ...storybookPreviewSetupSteps('trusted'),
        ...netlifyPreviewBuildSteps(),
      ],
    },
  }),
} satisfies CiWorkflowArgs)
