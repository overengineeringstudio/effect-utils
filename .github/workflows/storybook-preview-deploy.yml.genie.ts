import {
  ciWorkflow,
  type CiWorkflowArgs,
  netlifyPreviewDeployConcurrency,
  netlifyPreviewDeployJobs,
  netlifyPreviewDeployTrigger,
} from '../../genie/ci-workflow.ts'
import { effectUtilsWorkflowPolicy } from '../../genie/ci-workflow/policy.ts'
import {
  storybookPreviewBuildWorkflowName,
  storybookPreviewRunner,
  storybookPreviewSetupSteps,
} from '../../genie/storybook-preview.ts'

// Trusted half of the Storybook preview split. Runs from the default branch on
// `workflow_run`, so it only takes effect once merged to `main`.
// oxlint-disable-next-line overeng/exports-first -- generated entrypoint
export default ciWorkflow({
  policy: effectUtilsWorkflowPolicy('storybook-preview-deploy.yml'),
  trustTier: 'public',
  name: 'Storybook Preview Deploy',
  on: netlifyPreviewDeployTrigger(storybookPreviewBuildWorkflowName),
  concurrency: netlifyPreviewDeployConcurrency,
  permissions: {},
  jobs: netlifyPreviewDeployJobs({
    runsOn: {
      resolvePreview: storybookPreviewRunner('never'),
      // Both jobs run storybookPreviewSetupSteps, including the Cachix Nix build.
      deployPreview: storybookPreviewRunner('always'),
      publishPreviewComment: storybookPreviewRunner('always'),
    },
    setupSteps: storybookPreviewSetupSteps('always'),
    netlifyAuthToken: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
    title: 'Storybook Previews',
    noRecordsMessage: 'No storybooks were deployed.',
    stateId: 'storybook-preview',
  }),
} satisfies CiWorkflowArgs)
