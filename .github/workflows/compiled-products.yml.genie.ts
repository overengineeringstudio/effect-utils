import {
  RUNNER_PROFILES,
  bashShellDefaults,
  cachixCliBuildStep,
  cachixPushStep,
  checkoutStep,
  ciWorkflow,
  type CiWorkflowArgs,
  githubTokenEnv,
  installNixStep,
  namespaceRunner,
  prepareCiScriptsStep,
  preparePinnedDevenvStep,
  readBinaryCacheDescriptors,
  runDevenvTasksBefore,
  validateNixStoreStep,
  withCiSourceRoot,
} from '../../genie/ci-workflow.ts'
import { withBuck2CacheEvidence } from '../../genie/ci-workflow/buck2-cache-evidence.ts'
import { buck2CachePostureEnv } from '../../genie/ci-workflow/buck2-cache-posture.ts'
import { effectUtilsWorkflowPolicy } from '../../genie/ci-workflow/policy.ts'

const binaryCache = readBinaryCacheDescriptors(
  new URL('../../nix/binary-caches.json', import.meta.url),
)['overeng-effect-utils']!

const protectedMainIf =
  "${{ github.repository == 'overengineeringstudio/effect-utils' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}"

// Protected-main publisher for compiled-executable and native products, the
// exported Buck rules cell, and the Buck capability closure `test` lanes consume.
// Products are platform-specific imported store paths, not cache-manifest rows:
// each matching runner builds and smokes the product before publishing it.
// The same publisher warms unstamped compile outputs for all three inventories.
// There is no aarch64 Linux publisher, so its consumers build from source.
// Merge-group proof uses the same script in ci.yml (`build-products` on Linux x86_64,
// `test` on Darwin). A separate workflow avoids ci.yml's Actions size limit.
// oxlint-disable-next-line overeng/exports-first -- generated entrypoint
export default ciWorkflow({
  policy: effectUtilsWorkflowPolicy('compiled-products.yml'),
  trustTier: 'public',
  // The matrix below gives every Linux profile privileged: 'always'.
  linuxNixSandboxCapabilities: { 'publish-compiled-products': 'supported' },
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
        matrix: {
          include: RUNNER_PROFILES.map((runner) => ({
            runner,
            runnerLabel: namespaceRunner({
              profile: runner,
              runId: '{0}',
              privileged: 'always',
              priority: 1,
            })[0],
          })),
        },
      },
      'runs-on': ['${{ format(matrix.runnerLabel, github.run_id) }}'],
      'timeout-minutes': 120,
      permissions: { contents: 'read' },
      defaults: bashShellDefaults,
      env: { CI: 'true', ...githubTokenEnv(), ...buck2CachePostureEnv('reader') },
      steps: [
        checkoutStep(),
        installNixStep({ binaryCaches: [binaryCache] }),
        cachixCliBuildStep,
        prepareCiScriptsStep,
        preparePinnedDevenvStep,
        validateNixStoreStep,
        {
          name: 'Realize source generator bootstrap shell',
          if: "github.event_name == 'push'",
          run: runDevenvTasksBefore('buck2:editor:bootstrap'),
        },
        cachixPushStep({
          jobIf: protectedMainIf,
          triggers: ['push'],
          authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}',
          step: {
            name: 'Publish realized bootstrap shell closure',
            if: "github.event_name == 'push'",
            run: withCiSourceRoot(
              [
                'set -euo pipefail',
                'shell=$(readlink .devenv/gc/shell)',
                'case "$shell" in',
                '  /nix/store/*-devenv-shell) ;;',
                '  *) echo "::error::Missing realized bootstrap shell GC root" >&2; exit 1 ;;',
                'esac',
                'nix-store --check-validity "$shell"',
                'cachix push overeng-effect-utils "$shell"',
              ].join('\n'),
            ),
          },
        }),
        cachixPushStep({
          jobIf: protectedMainIf,
          triggers: ['push', 'workflow_dispatch'],
          authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}',
          step: {
            name: 'Publish Buck rules, retained shell, native and compiled products',
            env: {
              ...githubTokenEnv(),
              XDG_CONFIG_HOME:
                '${{ runner.temp }}/compile-cachix-${{ github.run_id }}-${{ github.run_attempt }}',
            },
            run: withCiSourceRoot(
              'mkdir -p "$XDG_CONFIG_HOME"\nbash genie/ci-scripts/compiled-products.sh --push',
            ),
          },
        }),
        {
          name: 'Remove isolated compile Cachix configuration',
          if: 'always()',
          run: [
            'config="${RUNNER_TEMP:?}/compile-cachix-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"',
            'if [ -d "$config" ]; then rm -r -- "$config"; fi',
          ].join('\n'),
        },
      ],
    },
  }),
} satisfies CiWorkflowArgs)
