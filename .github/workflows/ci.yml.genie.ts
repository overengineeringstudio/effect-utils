import { githubWorkflow } from '../../packages/@overeng/genie/src/lib/mod.ts'

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
  {
    id: 'bun-install',
    name: 'Install dependencies',
    run: [
      'set -euo pipefail',
      'bun install --frozen-lockfile 2>&1 | tee bun-install.log',
    ].join('\n'),
    'continue-on-error': true,
  },
  {
    name: 'Debug bun install failure',
    if: "steps.bun-install.outcome == 'failure'",
    run: [
      'set -euo pipefail',
      'echo "::group::bun install log (tail)"',
      'tail -n 200 bun-install.log || true',
      'echo "::endgroup::"',
      'drv=$(grep -o "/nix/store/[^ ]*genie-bun-deps\\.drv" bun-install.log | head -n 1 || true)',
      'if [ -n "$drv" ]; then',
      '  echo "::group::nix log $drv"',
      '  nix log "$drv" || true',
      '  echo "::endgroup::"',
      'else',
      '  echo "No genie-bun-deps drv found in bun-install.log"',
      'fi',
      'echo "::group::bun install retry (verbose)"',
      'bun install --frozen-lockfile --verbose --no-progress --no-summary || true',
      'echo "::endgroup::"',
    ].join('\n'),
  },
  {
    name: 'Fail if bun install failed',
    if: "steps.bun-install.outcome == 'failure'",
    run: 'exit 1',
  },
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
