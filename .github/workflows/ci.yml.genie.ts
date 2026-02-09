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
    name: 'Repair Nix store',
    // Namespace runners may have stale/invalid paths in their bundled nix store cache.
    // This removes invalid DB entries so nix re-fetches them from substituters on demand.
    run: 'nix-store --verify --repair 2>&1 | tail -5 || true',
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

const NETLIFY_SITE = 'overeng-utils'

// Deploy job — NOT a required status check (separate from CIJobName)
const deployJobs = {
  'deploy-storybooks': {
    // Namespace runners occasionally have a stale/corrupt /nix/store which can break devenv evaluation.
    // This job is non-blocking, so keep it reliable by using GitHub-hosted runners.
    'runs-on': 'ubuntu-latest',
    // No `needs` — run in parallel with other jobs for faster feedback
    permissions: {
      contents: 'read',
      'pull-requests': 'write',
    },
    defaults: jobDefaults,
    env: {
      FORCE_SETUP: '1',
      CI: 'true',
      NETLIFY_AUTH_TOKEN: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
    },
    steps: [
      ...baseSteps,
      {
        name: 'Deploy storybooks to Netlify',
        run: [
          'if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then',
          '  dt netlify:deploy --input type=prod',
          'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
          '  dt netlify:deploy --input type=pr --input pr=${{ github.event.pull_request.number }}',
          'fi',
        ].join('\n'),
      },
      {
        name: 'Post deploy URLs',
        if: "always() && !cancelled()",
        shell: 'bash',
        env: {
          GH_TOKEN: '${{ github.token }}',
        },
        run: [
          `site="${NETLIFY_SITE}"`,
          'if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then',
          '  suffix=""',
          '  label="prod"',
          'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
          '  suffix="-pr-${{ github.event.pull_request.number }}"',
          '  label="PR #${{ github.event.pull_request.number }}"',
          'else',
          '  exit 0',
          'fi',
          '',
          '# Collect deployed storybooks by checking for build output',
          'rows=""',
          'for dir in packages/@overeng/*/storybook-static; do',
          '  [ -d "$dir" ] || continue',
          '  name="${dir#packages/@overeng/}"',
          '  name="${name%/storybook-static}"',
          '  url="https://${name}${suffix}--${site}.netlify.app"',
          '  rows="${rows}| ${name} | ${url} |\\n"',
          'done',
          '',
          'if [ -z "$rows" ]; then',
          '  echo "No storybooks were deployed." >> "$GITHUB_STEP_SUMMARY"',
          '  exit 0',
          'fi',
          '',
          '# Write job summary',
          '{',
          '  echo "## Storybook Previews (${label})"',
          '  echo ""',
          '  echo "| Package | URL |"',
          '  echo "| --- | --- |"',
          '  echo -e "$rows"',
          '} >> "$GITHUB_STEP_SUMMARY"',
          '',
          '# Post/update PR comment',
          'if [ "${{ github.event_name }}" = "pull_request" ]; then',
          '  {',
          '    echo "## Storybook Previews"',
          '    echo ""',
          '    echo "| Package | URL |"',
          '    echo "| --- | --- |"',
          '    echo -e "$rows"',
          '  } > /tmp/comment.md',
          '  gh pr comment "${{ github.event.pull_request.number }}" --body-file /tmp/comment.md --edit-last 2>/dev/null \\',
          '    || gh pr comment "${{ github.event.pull_request.number }}" --body-file /tmp/comment.md',
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
