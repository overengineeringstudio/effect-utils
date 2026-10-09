// Temporary #1743 branch only: use the registered dispatch-capable workflow,
// never merge this experiment workflow or its test-only overrides into main.
import {
  bashShellDefaults,
  checkoutStep,
  ciWorkflow,
  type CiWorkflowArgs,
  githubTokenEnv,
} from '../../genie/ci-workflow.ts'
import { buck2CachePostureEnv } from '../../genie/ci-workflow/buck2-cache-posture.ts'
import { storybookPreviewRunner, storybookPreviewSetupSteps } from '../../genie/storybook-preview.ts'

export default ciWorkflow({
  trustTier: 'public',
  name: 'Editor Hash Race Experiment',
  on: {
    workflow_dispatch: {
      inputs: {
        editor_hash_iterations: {
          description: 'Cold-view publication iterations (1–15), stopping on first failure',
          type: 'number',
          required: true,
          default: 15,
        },
      },
    },
  },
  permissions: { contents: 'read' },
  jobs: {
    'editor-hash-race-experiment': {
      'runs-on': storybookPreviewRunner,
      'continue-on-error': true,
      permissions: { contents: 'read' },
      defaults: bashShellDefaults,
      env: {
        FORCE_SETUP: '1',
        CI: 'true',
        EDITOR_VIEW_TEST_PUBLICATION_WORKERS: '4',
        EDITOR_HASH_ITERATIONS: '${{ inputs.editor_hash_iterations }}',
        ...buck2CachePostureEnv('reader'),
      },
      steps: [
        checkoutStep(),
        ...storybookPreviewSetupSteps,
        {
          name: 'Run bounded four-worker publication from cold editor stores',
          env: githubTokenEnv(),
          run: 'set -euo pipefail\nnode scripts/editor-view-hash-experiment.mjs',
        },
        {
          name: 'Upload publication diagnostics and store lifecycle evidence',
          if: 'always()',
          uses: 'actions/upload-artifact@v4',
          with: {
            name: 'editor-hash-race-${{ github.run_id }}',
            path: '${{ runner.temp }}/editor-view-hash-experiment',
            'if-no-files-found': 'error',
            'retention-days': 3,
          },
        },
      ],
    },
  },
} satisfies CiWorkflowArgs)
