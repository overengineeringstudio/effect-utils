import {
  bashShellDefaults,
  buck2TrustedCacheWriterStep,
  checkoutStep,
  ciWorkflow,
  type CiWorkflowArgs,
  githubTokenEnv,
  runDevenvTasksBefore,
} from '../../genie/ci-workflow.ts'
import { withBuck2CacheEvidence } from '../../genie/ci-workflow/buck2-cache-evidence.ts'
import { buck2CachePostureEnv } from '../../genie/ci-workflow/buck2-cache-posture.ts'
import { STANDALONE_REQUIRED_CI_JOB_NAMES } from '../../genie/ci.ts'
import {
  storybookPreviewRunner,
  storybookPreviewSetupSteps,
} from '../../genie/storybook-preview.ts'

// Storybook play and accessibility tests (#1392) for every package opted in
// with `playTests` in devenv.nix. A workflow of its own rather than a `ci.yml`
// job because `ci.yml` sits at the GitHub Actions workflow size limit. The job
// is a required check (STANDALONE_REQUIRED_CI_JOB_NAMES in genie/ci.ts). PRs
// publish a skipped check without paying for the heavy lane; the mandatory native
// merge queue runs the real tests on its combined head before merging. Only the
// protected main queue receives the cache credential; PRs stay read-only.
const [playsJobName] = STANDALONE_REQUIRED_CI_JOB_NAMES

// oxlint-disable-next-line overeng/exports-first -- generated entrypoint
export default ciWorkflow({
  trustTier: 'public',
  name: 'Storybook Plays',
  on: {
    pull_request: { types: ['opened', 'reopened', 'synchronize'] },
    merge_group: { types: ['checks_requested'] },
  },
  permissions: { contents: 'read' },
  concurrency: {
    group: '${{ github.workflow }}-${{ github.ref }}',
    'cancel-in-progress': true,
  },
  jobs: withBuck2CacheEvidence({
    [playsJobName]: {
      if: "${{ github.event_name == 'merge_group' }}",
      'runs-on': storybookPreviewRunner,
      'timeout-minutes': 45,
      permissions: { contents: 'read' },
      defaults: bashShellDefaults,
      env: { FORCE_SETUP: '1', CI: 'true', ...buck2CachePostureEnv('trusted-writer') },
      steps: [
        checkoutStep(),
        ...storybookPreviewSetupSteps,
        buck2TrustedCacheWriterStep({
          name: 'Storybook play tests',
          env: githubTokenEnv(),
          run: runDevenvTasksBefore('storybook:test'),
        }),
      ],
    },
  }),
} satisfies CiWorkflowArgs)
