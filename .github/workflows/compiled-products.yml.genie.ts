import {
  RUNNER_PROFILES,
  bashShellDefaults,
  cachixCliBuildStep,
  cachixPushStep,
  cachixStep,
  checkoutStep,
  ciWorkflow,
  type CiWorkflowArgs,
  githubTokenEnv,
  installNixStep,
  linuxArm64Runner,
  namespaceRunner,
  readBinaryCacheDescriptors,
  withCiSourceRoot,
} from '../../genie/ci-workflow.ts'

const binaryCache = readBinaryCacheDescriptors(
  new URL('../../nix/binary-caches.json', import.meta.url),
)['overeng-effect-utils']!

const protectedMainIf =
  "${{ github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}"

// Protected-main publisher for compiled-executable products
// (nix/buck2-products/compiled-targets.json). Compiled products are
// platform-specific store paths, not cache-manifest rows: each lane builds the
// `.#<name>-compiled` native import on the matching native runner, smokes
// `--help`, and pushes it to Cachix. The macOS lane publishes ad-hoc signed,
// unmodified Mach-O bytes; aarch64 Linux runs on dev4's fleet runner because
// Namespace's standard product matrix exposes only Linux x86_64 and Darwin arm64.
// PR proof is in ci.yml (`build-products` for Linux x86_64, the macOS `test`
// leg for Darwin). A workflow of its own because ci.yml sits at the GitHub
// Actions workflow size limit.
// oxlint-disable-next-line overeng/exports-first -- generated entrypoint
export default ciWorkflow({
  trustTier: 'public',
  name: 'Compiled Products',
  on: {
    push: { branches: ['main'] },
    workflow_dispatch: {},
  },
  permissions: { contents: 'read' },
  concurrency: {
    group: '${{ github.workflow }}-${{ github.ref }}',
    'cancel-in-progress': false,
  },
  jobs: {
    'publish-compiled-products': {
      if: protectedMainIf,
      strategy: {
        'fail-fast': false,
        matrix: {
          include: [
            ...RUNNER_PROFILES.map((runner) => ({
              runner,
              'runs-on': namespaceRunner({ profile: runner, runId: '${{ github.run_id }}' }),
            })),
            { runner: linuxArm64Runner[0], 'runs-on': [...linuxArm64Runner] },
          ],
        },
      },
      'runs-on': '${{ matrix.runs-on }}',
      'timeout-minutes': 120,
      permissions: { contents: 'read' },
      defaults: bashShellDefaults,
      env: { CI: 'true', ...githubTokenEnv() },
      steps: [
        checkoutStep(),
        installNixStep({ binaryCaches: [binaryCache] }),
        cachixCliBuildStep,
        cachixStep({ name: 'overeng-effect-utils' }),
        cachixPushStep({
          jobIf: protectedMainIf,
          triggers: ['push', 'workflow_dispatch'],
          authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}',
          step: {
            name: 'Publish compiled products',
            env: githubTokenEnv(),
            run: withCiSourceRoot('bash genie/ci-scripts/compiled-products.sh --push'),
          },
        }),
      ],
    },
  },
} satisfies CiWorkflowArgs)
