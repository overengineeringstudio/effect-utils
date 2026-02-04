import { githubWorkflow } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import type { CIJobName } from '../../genie/ci.ts'

/**
 * Namespace runner configuration.
 * Uses run ID-based labels for runner affinity to prevent queue jumping.
 */
const namespaceRunner = (runId: string) =>
  [
    'namespace-profile-linux-x86-64',
    `namespace-features:github.run-id=${runId}`,
  ] as const

const jobDefaults = {
  run: {
    shell: 'devenv shell bash -- -e {0}',
  },
} as const

const baseSteps = [
  { uses: 'actions/checkout@v4' },
  {
    name: 'Install Nix',
    uses: 'cachix/install-nix-action@v31',
  },
  {
    name: 'Enable Cachix cache',
    uses: 'cachix/cachix-action@v16',
    with: {
      name: 'overeng-effect-utils',
      authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}',
    },
  },
  {
    name: 'Install devenv',
    // Install devenv from the commit pinned in devenv.lock to ensure version consistency
    run: 'nix profile install github:cachix/devenv/$(jq -r ".nodes.devenv.locked.rev" devenv.lock)',
    shell: 'bash',
  },
  {
    name: 'Cache pnpm store',
    uses: 'actions/cache@v4',
    with: {
      path: '~/.local/share/pnpm/store',
      key: "pnpm-store-${{ runner.os }}-${{ hashFiles('**/pnpm-lock.yaml') }}",
      'restore-keys': 'pnpm-store-${{ runner.os }}-',
    },
  },
] as const

const job = (step: { name: string; run: string }) => ({
  'runs-on': namespaceRunner('${{ github.run_id }}'),
  defaults: jobDefaults,
  env: {
    FORCE_SETUP: '1',
    CI: 'true',
  },
  steps: [...baseSteps, step],
})

// Jobs keyed by CIJobName for type safety with required status checks
const jobs: Record<CIJobName, ReturnType<typeof job>> = {
  typecheck: job({
    name: 'Type check',
    run: 'dt ts:check',
  }),
  lint: job({
    name: 'Format + lint',
    run: 'dt lint:check',
  }),
  test: job({
    name: 'Unit tests',
    run: 'dt test:run',
  }),
  // Verify Nix hashes are up-to-date (pnpmDepsHash + localDeps)
  // This catches stale hashes before they break downstream consumers
  'nix-check': job({
    name: 'Nix hash check',
    run: 'dt nix:check',
  }),
}

export default githubWorkflow({
  name: 'CI',
  on: {
    push: { branches: ['main'] },
    pull_request: { branches: ['main'] },
  },
  jobs,
})
