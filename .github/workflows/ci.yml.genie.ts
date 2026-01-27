import { githubWorkflow } from '../../packages/@overeng/genie/src/runtime/mod.ts'

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
    name: 'Enable devenv Cachix cache',
    uses: 'cachix/cachix-action@v16',
    with: {
      name: 'devenv',
    },
  },
  {
    name: 'Install devenv',
    // Install devenv from the commit pinned in devenv.lock to ensure version consistency
    run: 'nix profile install github:cachix/devenv/$(jq -r ".nodes.devenv.locked.rev" devenv.lock)',
    shell: 'bash',
  },
  { run: 'bun install --frozen-lockfile' },
] as const

const job = (step: { name: string; run: string }) => ({
  'runs-on': 'ubuntu-latest',
  defaults: jobDefaults,
  steps: [...baseSteps, step],
})

export default githubWorkflow({
  name: 'CI',
  on: {
    push: { branches: ['main'] },
    pull_request: { branches: ['main'] },
  },
  jobs: {
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
  },
})
