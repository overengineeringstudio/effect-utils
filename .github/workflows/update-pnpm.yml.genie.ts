import {
  bashShellDefaults,
  checkoutStep,
  ciWorkflow,
  type CiWorkflowArgs,
  githubAppInstallationTokenStep,
  installNixStep,
  linuxX64Runner,
  pnpmStateSetupStep,
  prepareCiScriptsStep,
  runDevenvTasksBefore,
  validateNixStoreStep,
} from '../../genie/ci-workflow.ts'
import { effectUtilsWorkflowPolicy } from '../../genie/ci-workflow/policy.ts'

const tokenStep = githubAppInstallationTokenStep({
  id: 'pnpm-token',
  name: 'Mint repository-restricted updater App token',
  appId: '${{ vars.NIX_PUBLISHER_GITHUB_APP_ID }}',
  privateKey: '${{ secrets.NIX_PUBLISHER_GITHUB_APP_PRIVATE_KEY }}',
  owner: 'overengineeringstudio',
  repositories: ['effect-utils'],
})
const updaterEnv = { GH_TOKEN: '${{ steps.pnpm-token.outputs.token }}' }

// oxlint-disable-next-line overeng/exports-first -- generated entrypoint
export default ciWorkflow({
  policy: effectUtilsWorkflowPolicy('update-pnpm.yml'),
  trustTier: 'public',
  name: 'Update pnpm',
  on: { schedule: [{ cron: '23 6 * * 1' }], workflow_dispatch: {} },
  permissions: { contents: 'read' },
  concurrency: { group: 'update-pnpm', 'cancel-in-progress': false },
  jobs: {
    candidate: {
      if: "${{ github.repository == 'overengineeringstudio/effect-utils' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}",
      'runs-on': linuxX64Runner,
      'timeout-minutes': 45,
      defaults: bashShellDefaults,
      env: { DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}' },
      steps: [
        checkoutStep({ ref: '${{ github.sha }}' }),
        installNixStep(),
        prepareCiScriptsStep,
        validateNixStoreStep,
        pnpmStateSetupStep,
        {
          name: 'Test updater input contracts',
          run: 'python3 scripts/update-pnpm.test.py',
        },
        {
          ...tokenStep,
          with: {
            ...tokenStep.with,
            'permission-contents': 'write',
            'permission-pull-requests': 'write',
          },
        },
        {
          id: 'prepare',
          name: 'Measure latest stable payloads or adopt existing draft',
          env: updaterEnv,
          run: 'python3 scripts/update-pnpm.py prepare',
        },
        {
          if: "steps.prepare.outputs.changed == 'true'",
          name: 'Regenerate canonical projections once',
          run: [
            runDevenvTasksBefore('buck2:editor:bootstrap'),
            runDevenvTasksBefore('genie:run'),
          ].join('\n'),
        },
        {
          if: "steps.prepare.outputs.changed == 'true'",
          name: 'Publish GitHub-signed normal commit and draft PR',
          env: updaterEnv,
          run: 'python3 scripts/update-pnpm.py publish',
        },
      ],
    },
  },
} satisfies CiWorkflowArgs)
