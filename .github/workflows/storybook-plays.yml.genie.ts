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
  storybookPreviewRunner,
  storybookPreviewSetupSteps,
} from '../../genie/storybook-preview.ts'

// Storybook play and accessibility tests (#1392) for every package opted in
// with `playTests` in devenv.nix. A workflow of its own rather than a `ci.yml`
// job because `ci.yml` sits at the GitHub Actions workflow size limit. The job
// is a required check (STANDALONE_REQUIRED_CI_JOB_NAMES in genie/ci.ts), so it
// must run on every pull request: no path filter and no job-level `if`. With no
// opted-in package, `storybook:test` is an empty aggregate that succeeds. PR
// code runs here with no secrets.
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
    [playsJobName]: {
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
  },
} satisfies CiWorkflowArgs)
