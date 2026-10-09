import {
  RUNNER_PROFILES,
  type RunnerProfile,
  bashShellDefaults,
  cachixCliBuildStep,
  cachixPushStep,
  cachixStep,
  checkoutStep,
  ciWorkflow,
  type CiWorkflowArgs,
  githubTokenEnv,
  installNixStep,
  namespaceRunner,
  readBinaryCacheDescriptors,
  withCiSourceRoot,
} from '../../genie/ci-workflow.ts'
import { withBuck2CacheEvidence } from '../../genie/ci-workflow/buck2-cache-evidence.ts'
import { buck2CachePostureEnv } from '../../genie/ci-workflow/buck2-cache-posture.ts'

const binaryCache = readBinaryCacheDescriptors(
  new URL('../../nix/binary-caches.json', import.meta.url),
)['overeng-effect-utils']!

const protectedMainIf =
  "${{ github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}"

// Protected-main publisher for compiled-executable and native products, and for
// the Buck capability closure the `test` lanes consume.
// Products are platform-specific imported store paths, not cache-manifest rows:
// each matching runner builds and smokes the product before publishing it.
// There is no aarch64 Linux publisher, so its consumers build from source.
// Merge-group proof uses the same script in ci.yml (`build-products` on Linux x86_64,
// `test` on Darwin). A separate workflow avoids ci.yml's Actions size limit.
// oxlint-disable-next-line overeng/exports-first -- generated entrypoint
export default ciWorkflow({
  trustTier: 'public',
  name: 'Native and Compiled Products',
  on: {
    push: { branches: ['main'] },
    workflow_dispatch: {},
  },
  permissions: { contents: 'read' },
  concurrency: {
    group: '${{ github.workflow }}-${{ github.ref }}',
    'cancel-in-progress': false,
  },
  jobs: withBuck2CacheEvidence({
    'publish-compiled-products': {
      if: protectedMainIf,
      strategy: {
        'fail-fast': false,
        matrix: { runner: [...RUNNER_PROFILES] },
      },
      'runs-on': namespaceRunner({
        profile: '${{ matrix.runner }}' as RunnerProfile,
        runId: '${{ github.run_id }}',
      }),
      'timeout-minutes': 120,
      permissions: { contents: 'read' },
      defaults: bashShellDefaults,
      env: { CI: 'true', ...githubTokenEnv(), ...buck2CachePostureEnv('reader') },
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
            name: 'Publish retained shell, native and compiled products',
            env: githubTokenEnv(),
            run: withCiSourceRoot('bash genie/ci-scripts/compiled-products.sh --push'),
          },
        }),
      ],
    },
  }),
} satisfies CiWorkflowArgs)
