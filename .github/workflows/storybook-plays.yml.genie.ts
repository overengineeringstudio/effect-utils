import {
  bashShellDefaults,
  checkoutStep,
  ciWorkflow,
  type CiWorkflowArgs,
  githubTokenEnv,
  runDevenvTasksBefore,
} from '../../genie/ci-workflow.ts'
import { STANDALONE_REQUIRED_CI_JOB_NAMES } from '../../genie/ci.ts'
import {
  storybookChangesJob,
  storybookPreviewRunner,
  storybookPreviewSetupSteps,
} from '../../genie/storybook-preview.ts'

// Storybook play and accessibility tests (#1392) for every package opted in
// with `playTests` in devenv.nix. A workflow of its own rather than a `ci.yml`
// job because `ci.yml` sits at the GitHub Actions workflow size limit. The job
// keeps its required status name on a lightweight hosted gate. The expensive
// Namespace job runs only when Storybook inputs changed; the gate accepts that
// intentional skip but propagates admission errors and play-test failures.
// PR code runs here with no secrets.
const [playsJobName] = STANDALONE_REQUIRED_CI_JOB_NAMES

// oxlint-disable-next-line overeng/exports-first -- generated entrypoint
export default ciWorkflow({
  trustTier: 'public',
  name: 'Storybook Plays',
  on: {
    pull_request: { types: ['opened', 'reopened', 'synchronize'] },
    push: { branches: ['main'] },
  },
  permissions: { contents: 'read' },
  concurrency: {
    group: '${{ github.workflow }}-${{ github.ref }}',
    'cancel-in-progress': true,
  },
  jobs: {
    'storybook-changes': storybookChangesJob,
    'run-storybook-plays': {
      needs: ['storybook-changes'],
      if: "needs.storybook-changes.outputs.changed == 'true'",
      'runs-on': storybookPreviewRunner,
      'timeout-minutes': 45,
      permissions: { contents: 'read' },
      defaults: bashShellDefaults,
      env: { FORCE_SETUP: '1', CI: 'true' },
      steps: [
        checkoutStep(),
        ...storybookPreviewSetupSteps,
        {
          name: 'Storybook play tests',
          env: githubTokenEnv(),
          run: runDevenvTasksBefore('storybook:test'),
        },
      ],
    },
    [playsJobName]: {
      needs: ['storybook-changes', 'run-storybook-plays'],
      if: 'always()',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 5,
      permissions: {},
      defaults: bashShellDefaults,
      steps: [
        {
          name: 'Report Storybook play result',
          env: {
            ADMISSION_RESULT: '${{ needs.storybook-changes.result }}',
            CHANGED: '${{ needs.storybook-changes.outputs.changed }}',
            PLAY_RESULT: '${{ needs.run-storybook-plays.result }}',
          },
          run: `[[ "$ADMISSION_RESULT" == success ]]
if [[ "$CHANGED" == false ]]; then
  [[ "$PLAY_RESULT" == skipped ]]
  echo 'No Storybook inputs changed; play tests not needed.'
else
  [[ "$CHANGED" == true && "$PLAY_RESULT" == success ]]
fi`,
        },
      ],
    },
  },
} satisfies CiWorkflowArgs)
