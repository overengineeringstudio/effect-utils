import {
  ciWorkflow,
  type CiWorkflowArgs,
  netlifyPreviewDeployConcurrency,
  netlifyPreviewDeployJobs,
  netlifyPreviewDeployTrigger,
} from '../../genie/ci-workflow.ts'
import {
  storybookPreviewBuildWorkflowName,
  storybookPreviewRunner,
  storybookPreviewSetupSteps,
} from '../../genie/storybook-preview.ts'

// Trusted half of the Storybook preview split. Runs from the default branch on
// `workflow_run`, so it only takes effect once merged to `main`.
// oxlint-disable-next-line overeng/exports-first -- generated entrypoint
export default ciWorkflow({
  trustTier: 'public',
  name: 'Storybook Preview Deploy',
  on: netlifyPreviewDeployTrigger(storybookPreviewBuildWorkflowName),
  concurrency: netlifyPreviewDeployConcurrency,
  permissions: {},
  jobs: netlifyPreviewDeployJobs({
    runsOn: storybookPreviewRunner,
    setupSteps: storybookPreviewSetupSteps,
    netlifyAuthToken: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
    title: 'Storybook Previews',
    noRecordsMessage: 'No storybooks were deployed.',
    stateId: 'storybook-preview',
  }),
} satisfies CiWorkflowArgs)
