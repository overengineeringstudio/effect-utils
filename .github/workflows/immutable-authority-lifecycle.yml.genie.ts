import { pinnedAction } from '../../packages/@overeng/genie/src/runtime/github-workflow/action-pins.ts'
import {
  bashShellDefaults,
  checkoutStep,
  ciWorkflow,
  type CiWorkflowArgs,
} from '../../genie/ci-workflow.ts'
import { effectUtilsWorkflowPolicy } from '../../genie/ci-workflow/policy.ts'
import {
  publicNamespaceKvmConcurrency,
  publicNamespaceKvmIf,
  publicNamespaceKvmRunner,
} from '../../genie/ci-workflow/shared.ts'

// Public, credential-free real guest lifecycle proof; never deploys a host.
// oxlint-disable-next-line overeng/exports-first -- generated entrypoint
export default ciWorkflow({
  policy: effectUtilsWorkflowPolicy('immutable-authority-lifecycle.yml'),
  trustTier: 'public',
  name: 'Immutable Authority Lifecycle',
  on: {
    pull_request: {
      paths: [
        'nix/immutable-microvm/**',
        '.github/workflows/immutable-authority-lifecycle.yml*',
        'genie/ci-workflow/**',
        'packages/@overeng/genie/src/runtime/github-workflow/**',
      ],
    },
  },
  permissions: { contents: 'read' },
  jobs: {
    lifecycle: {
      if: publicNamespaceKvmIf,
      'runs-on': [publicNamespaceKvmRunner],
      concurrency: publicNamespaceKvmConcurrency,
      'timeout-minutes': 30,
      permissions: { contents: 'read' },
      defaults: bashShellDefaults,
      steps: [
        checkoutStep(),
        {
          name: 'Require real KVM access',
          run: 'test -r /dev/kvm && test -w /dev/kvm',
        },
        {
          name: 'Install Nix without provider credentials or cache publishing',
          ...pinnedAction({ name: 'determinateNix' }),
          with: {
            'extra-conf': [
              'experimental-features = nix-command flakes',
              'sandbox = true',
              'sandbox-fallback = false',
              'connect-timeout = 10',
              'stalled-download-timeout = 60',
              'download-attempts = 3',
            ].join('\n'),
          },
        },
        {
          name: 'Build fixture and both immutable runner closures',
          run: [
            'nix build ./nix/immutable-microvm#packages.x86_64-linux.a ./nix/immutable-microvm#packages.x86_64-linux.b',
            '  --no-write-lock-file --no-link --print-out-paths --show-trace -L',
            '  --option builders "" --max-jobs 1',
          ].join(' \\\n'),
        },
        {
          name: 'Prove cold boot, update, rollback and private state persistence',
          run: [
            'nix build ./nix/immutable-microvm#checks.x86_64-linux.lifecycle',
            '  --no-write-lock-file --no-link --print-out-paths --show-trace -L',
            '  --option builders "" --max-jobs 1',
          ].join(' \\\n'),
        },
      ],
    },
  },
} satisfies CiWorkflowArgs)
