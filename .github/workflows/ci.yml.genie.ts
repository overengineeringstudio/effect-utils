import { githubWorkflow } from '../../packages/@overeng/genie/src/lib/mod.ts'

export default githubWorkflow({
  name: 'CI',
  on: {
    push: { branches: ['main'] },
    pull_request: { branches: ['main'] },
  },
  jobs: {
    check: {
      'runs-on': 'ubuntu-latest',
      defaults: {
        run: {
          shell: 'devenv shell bash -- -e {0}',
        },
      },
      steps: [
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
        {
          name: 'Type check',
          run: 'mono ts',
        },
        {
          name: 'Format + lint',
          run: 'mono lint',
        },
        {
          name: 'Unit tests',
          run: 'mono test --unit',
        },
      ],
    },
  },
})
