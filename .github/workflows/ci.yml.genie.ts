import { githubWorkflow, type GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { RUNNER_PROFILES, type CIJobName, type RunnerProfile } from '../../genie/ci.ts'

/**
 * Namespace runner configuration.
 * Uses run ID-based labels for runner affinity to prevent queue jumping.
 */
const namespaceRunner = (profile: RunnerProfile, runId: string) =>
  [profile, `namespace-features:github.run-id=${runId}`] as const

const jobDefaults = {
  run: {
    shell: 'devenv shell bash -- -e {0}',
  },
} as const

// For jobs that invoke `devenv` directly (without entering a devenv shell).
const bashDefaults = {
  run: {
    shell: 'bash',
  },
} as const

const baseSteps = [
  { uses: 'actions/checkout@v4' },
  {
    name: 'Install Nix',
    uses: 'cachix/install-nix-action@v31',
    with: {
      // Ensure cache.nixos.org is available as a fallback substituter.
      // Without this, macOS ARM64 runners can fail with "path is not valid"
      // during Darwin stdenv bootstrap when low-level store paths get GC'd
      // and aren't in our Cachix cache.
      // See: https://github.com/NixOS/nix/issues/9052
      //      https://github.com/cachix/cachix-action/issues/44
      extra_nix_config: 'extra-substituters = https://cache.nixos.org\nextra-trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=',
    },
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
    name: 'Verify devenv shell',
    // Pre-evaluate devenv shell and repair nix store if needed.
    // Namespace runners can have stale store paths ("path is not valid")
    // due to garbage collection between jobs.
    run: [
      'if ! devenv shell -- true; then',
      '  echo "::warning::Nix store has invalid paths, repairing..."',
      '  nix-store --verify --check-contents --repair 2>/dev/null || true',
      '  devenv shell -- true',
      'fi',
    ].join('\n'),
    shell: 'bash',
  },
] as const

const job = (step: { name: string; run: string }) => ({
  'runs-on': namespaceRunner('namespace-profile-linux-x86-64', '${{ github.run_id }}'),
  defaults: jobDefaults,
  env: {
    FORCE_SETUP: '1',
    CI: 'true',
  },
  steps: [...baseSteps, step],
})

const multiPlatformJob = (step: { name: string; run: string }) => ({
  strategy: {
    'fail-fast': false,
    matrix: {
      runner: [...RUNNER_PROFILES],
    },
  },
  'runs-on': namespaceRunner('${{ matrix.runner }}' as RunnerProfile, '${{ github.run_id }}'),
  defaults: jobDefaults,
  env: {
    FORCE_SETUP: '1',
    CI: 'true',
  },
  steps: [...baseSteps, step],
})

// Jobs keyed by CIJobName for type safety with required status checks
const jobs: Record<CIJobName, ReturnType<typeof job> | ReturnType<typeof multiPlatformJob>> = {
  typecheck: job({
    name: 'Type check',
    run: 'dt ts:check',
  }),
  lint: job({
    name: 'Format + lint',
    run: 'dt lint:check',
  }),
  test: multiPlatformJob({
    name: 'Unit tests',
    run: 'dt test:run',
  }),
  // Verify Nix hashes are up-to-date (pnpmDepsHash + localDeps)
  // This catches stale hashes before they break downstream consumers
  'nix-check': multiPlatformJob({
    name: 'Nix hash check',
    run: 'dt nix:check',
  }),
}

// Deploy job — NOT a required status check (separate from CIJobName)
const deployJobs = {
  'deploy-storybooks': {
    'runs-on': namespaceRunner('namespace-profile-linux-x86-64', '${{ github.run_id }}'),
    needs: ['typecheck', 'lint', 'test'],
    // Avoid `devenv shell ...` here: it can fail due to invalid cached store paths on CI runners.
    // Running tasks via `devenv tasks run` is sufficient.
    defaults: bashDefaults,
    env: {
      FORCE_SETUP: '1',
      CI: 'true',
      NETLIFY_AUTH_TOKEN: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
    },
    steps: [
      ...baseSteps,
      {
        name: 'Build storybooks',
        // Build all storybooks, allowing individual failures.
        // Storybooks that fail to build will be skipped during deploy.
        run: 'devenv tasks run storybook:build --mode before || true',
      },
      {
        name: 'Install netlify-cli',
        // Pre-install to avoid bunx cache contention when
        // multiple deploy tasks run in parallel.
        run: 'bunx netlify-cli --version',
      },
      {
        name: 'Deploy storybooks to Netlify',
        run: [
          'if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then',
          '  devenv tasks run netlify:deploy --mode before --input type=prod',
          'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
          '  devenv tasks run netlify:deploy --mode before --input type=pr --input pr=${{ github.event.pull_request.number }}',
          'fi',
        ].join('\n'),
      },
    ],
  },
} as const

export default githubWorkflow({
  name: 'CI',
  on: {
    push: { branches: ['main'] },
    pull_request: { branches: ['main'] },
  },
  jobs: { ...jobs, ...deployJobs },
} satisfies GitHubWorkflowArgs)
