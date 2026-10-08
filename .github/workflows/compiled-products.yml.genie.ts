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

/**
 * Flake packages whose runtime closures the `test` lanes substitute instead of
 * compiling. `buck2-capabilities` references every Buck execution capability
 * (Weaver, the stage-zero Rust tools, the Rust toolchain wrappers);
 * `buck2-events` is the stage-zero tool the dev shell adds outside that
 * projection. The `test` jobs only read the cache, so these outputs reach it
 * through this protected publisher on each platform.
 */
const capabilityClosureAttrs = ['buck2-capabilities', 'buck2-events'] as const

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
            name: 'Publish Buck capability closure',
            env: githubTokenEnv(),
            run: withCiSourceRoot(
              [
                'set -euo pipefail',
                `paths=$(nix build --no-link --print-out-paths ${capabilityClosureAttrs.map((attr) => `.#${attr}`).join(' ')})`,
                '# Store paths contain no whitespace; word splitting yields one argument per output.',
                'cachix push overeng-effect-utils $paths',
              ].join('\n'),
            ),
          },
        }),
        cachixPushStep({
          jobIf: protectedMainIf,
          triggers: ['push', 'workflow_dispatch'],
          authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}',
          step: {
            name: 'Publish native and compiled products',
            env: githubTokenEnv(),
            run: withCiSourceRoot('bash genie/ci-scripts/compiled-products.sh --push'),
          },
        }),
      ],
    },
  }),
} satisfies CiWorkflowArgs)
