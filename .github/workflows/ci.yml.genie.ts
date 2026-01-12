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
    run: 'nix profile install nixpkgs#devenv',
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
      run: 'mono ts',
    }),
    lint: job({
      name: 'Format + lint',
      run: 'mono lint',
    }),
    test: job({
      name: 'Unit tests',
      run: 'mono test --unit',
    }),
  },
})
