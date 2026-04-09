import {
  RUNNER_PROFILES,
  type RunnerProfile,
  bashShellDefaults,
  cachixStep,
  checkoutStep,
  notifyAlignmentJob,
  evictCachedPnpmDepsStep,
  pnpmBuilderContractStep,
  preparePinnedDevenvStep,
  installNixStep,
  runDevenvTasksBefore,
  restorePnpmStoreStep,
  savePnpmStoreStep,
  standardCIEnv,
  ciWorkflow,
  namespaceRunner,
  validateColdPnpmDepsStep,
  nixDiagnosticsArtifactStep,
  netlifyDeployStep,
  netlifyStorybookCommentStep,
  pnpmStoreSetupStep,
  validateNixStoreStep,
} from '../../genie/ci-workflow.ts'
import { type CIJobName } from '../../genie/ci.ts'
import { type GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'

const baseSteps = [
  checkoutStep(),
  installNixStep(),
  cachixStep({ name: 'overeng-effect-utils', authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}' }),
  preparePinnedDevenvStep,
  pnpmStoreSetupStep,
  restorePnpmStoreStep(),
  validateNixStoreStep,
  evictCachedPnpmDepsStep({
    flakeRef: '.#oxlint-npm',
    name: 'Evict cached pnpm deps for oxlint-npm',
  }),
  /**
   * Temporary debug switch for #272 to validate failure-path diagnostics without waiting for a real flake.
   * Remove once #201/#272 are root-caused and diagnostics instrumentation is removed.
   */
  {
    name: 'Force diagnostics failure (debug)',
    if: "${{ github.event_name == 'workflow_dispatch' && (inputs.debug_force_nix_diagnostics_failure == true || inputs.debug_force_nix_diagnostics_failure == 'true') }}",
    shell: 'bash',
    run: [
      'diag_dir="${NIX_STORE_DIAGNOSTICS_DIR:-${RUNNER_TEMP:-/tmp}/nix-store-diagnostics-missing}"',
      'mkdir -p "$diag_dir"',
      'cat > "$diag_dir/synthetic-signature.log" <<\'EOF\'',
      'Failed to convert config.cachix to JSON',
      '... while evaluating the option `cachix.package`',
      "error: path '/nix/store/synthetic-invalid-path' is not valid",
      'EOF',
      'echo "::warning::Intentional failure for diagnostics validation (#272)"',
      'exit 1',
    ].join('\n'),
  },
] as const

const failureReminderStep = {
  name: 'Failure note',
  if: 'failure()',
  shell: 'bash',
  run: [
    'echo "If this looks like Namespace runner Nix store corruption (e.g. \\"... is not valid\\", \\"config.cachix\\", \\"cachix.package\\"), add the run link + full nix-store output to:"',
    'echo "  https://github.com/overengineeringstudio/effect-utils/issues/201"',
  ].join('\n'),
} as const

/**
 * Temporary diagnostics summary for #272.
 * Remove once #201/#272 are root-caused and we can return to a minimal CI flow.
 */
const nixDiagnosticsSummaryStep = {
  name: 'Nix diagnostics summary',
  if: 'failure()',
  shell: 'bash',
  run: [
    'diag_dir="${NIX_STORE_DIAGNOSTICS_DIR:-}"',
    'if [ -z "$diag_dir" ] || [ ! -d "$diag_dir" ]; then',
    '  echo "## Nix Store Diagnostics" >> "$GITHUB_STEP_SUMMARY"',
    '  echo "" >> "$GITHUB_STEP_SUMMARY"',
    '  echo "No diagnostics directory found (validation may have failed before capture)." >> "$GITHUB_STEP_SUMMARY"',
    '  exit 0',
    'fi',
    '',
    '{',
    '  echo "## Nix Store Diagnostics"',
    '  echo ""',
    '  echo "Temporary instrumentation for #272; remove after root cause is confirmed and CI is stable."',
    '  echo ""',
    '  echo "- Diagnostics directory: \\`$diag_dir\\`"',
    '  echo "- Tracking issue: https://github.com/overengineeringstudio/effect-utils/issues/272"',
    '} >> "$GITHUB_STEP_SUMMARY"',
    '',
    'markers_file="${RUNNER_TEMP:-/tmp}/nix-store-signature-markers.txt"',
    'grep -R -n -E "config\\\\.cachix|cachix\\\\.package|error: path \'/nix/store/.+ is not valid" --exclude="$(basename "$markers_file")" "$diag_dir" > "$markers_file" || true',
    '',
    'if [ -s "$markers_file" ]; then',
    '  {',
    '    echo ""',
    '    echo "### Signature markers"',
    "    echo '```text'",
    '    head -n 120 "$markers_file"',
    "    echo '```'",
    '  } >> "$GITHUB_STEP_SUMMARY"',
    'else',
    '  echo "" >> "$GITHUB_STEP_SUMMARY"',
    '  echo "- No signature markers found in captured diagnostics." >> "$GITHUB_STEP_SUMMARY"',
    'fi',
  ].join('\n'),
} as const

const job = (step: { name: string; run: string; shell?: string }) => ({
  'runs-on': namespaceRunner({
    profile: 'namespace-profile-linux-x86-64',
    runId: '${{ github.run_id }}',
  }),
  defaults: bashShellDefaults,
  env: standardCIEnv,
  steps: [
    ...baseSteps,
    step,
    savePnpmStoreStep(),
    nixDiagnosticsSummaryStep,
    nixDiagnosticsArtifactStep(),
    failureReminderStep,
  ],
})

const multiPlatformJob = (step: { name: string; run: string }) => ({
  strategy: {
    'fail-fast': false,
    matrix: {
      runner: [...RUNNER_PROFILES],
    },
  },
  'runs-on': namespaceRunner({
    profile: '${{ matrix.runner }}' as RunnerProfile,
    runId: '${{ github.run_id }}',
  }),
  defaults: bashShellDefaults,
  env: standardCIEnv,
  steps: [
    ...baseSteps,
    step,
    savePnpmStoreStep(),
    nixDiagnosticsSummaryStep,
    nixDiagnosticsArtifactStep(),
    failureReminderStep,
  ],
})

const strictNixJobBaseSteps = [
  checkoutStep(),
  installNixStep(),
  cachixStep({ name: 'overeng-effect-utils', authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}' }),
  validateNixStoreStep,
] as const

const multiPlatformStrictNixJob = (step: ReturnType<typeof validateColdPnpmDepsStep>) => ({
  strategy: {
    'fail-fast': false,
    matrix: {
      runner: [...RUNNER_PROFILES],
    },
  },
  'runs-on': namespaceRunner({
    profile: '${{ matrix.runner }}' as RunnerProfile,
    runId: '${{ github.run_id }}',
  }),
  defaults: bashShellDefaults,
  env: standardCIEnv,
  steps: [
    ...strictNixJobBaseSteps,
    step,
    nixDiagnosticsSummaryStep,
    nixDiagnosticsArtifactStep(),
    failureReminderStep,
  ],
})

// Jobs keyed by CIJobName for type safety with required status checks
const jobs: Record<CIJobName, ReturnType<typeof job> | ReturnType<typeof multiPlatformJob>> = {
  typecheck: job({
    name: 'Type check',
    run: runDevenvTasksBefore('ts:check'),
  }),
  lint: job({
    name: 'Format + lint',
    run: runDevenvTasksBefore('lint:check'),
  }),
  test: multiPlatformJob({
    name: 'Unit tests',
    run: runDevenvTasksBefore('test:run'),
  }),
  // Verify Nix hashes are up-to-date (pnpmDepsHash + localDeps)
  // This catches stale hashes before they break downstream consumers
  'nix-check': multiPlatformJob({
    name: 'Nix hash check',
    run: runDevenvTasksBefore('nix:check'),
  }),
  // Force a fresh local rebuild of every exported pnpm FOD to catch stale
  // hashes that normal CI can otherwise mask via store/substituter reuse.
  'nix-fod-check': multiPlatformStrictNixJob(
    validateColdPnpmDepsStep({
      flakeRefs: ['.#genie-pnpm-deps', '.#megarepo-pnpm-deps', '.#oxc-config-plugin-pnpm-deps'],
      substituters: ['https://cache.nixos.org'],
    }),
  ),
  'pnpm-builder-contract': job(
    pnpmBuilderContractStep({
      builderFile: 'nix/workspace-tools/lib/mk-pnpm-deps.nix',
    }),
  ),
  'pnpm-regression': job({
    name: 'pnpm regression suite',
    run: [
      'bash genie/ci-scripts/nix-gc-race-retry.test.sh',
      'bash nix/workspace-tools/lib/mk-pnpm-cli/tests/run.sh --skip-genie --skip-megarepo --skip-devenv-shell --skip-downstream-megarepo',
    ].join('\n'),
  }),
}

const NETLIFY_SITE = 'overeng-utils'

// Non-required jobs (separate from CIJobName — not required status checks)
const extraJobs: Record<string, any> = {
  /** Integration tests for Notion API (requires NOTION_TOKEN secret) */
  'test-integration-notion': {
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    defaults: bashShellDefaults,
    env: {
      ...standardCIEnv,
      NOTION_TOKEN: '${{ secrets.NOTION_TOKEN }}',
    },
    steps: [
      ...baseSteps,
      {
        name: 'Notion integration tests',
        run: runDevenvTasksBefore('test:notion-integration'),
      },
      savePnpmStoreStep(),
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
}

const deployJobs: Record<string, any> = {
  'deploy-storybooks': {
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    // No `needs` — run in parallel with other jobs for faster feedback
    permissions: {
      contents: 'read',
      'pull-requests': 'write',
    },
    defaults: bashShellDefaults,
    env: {
      ...standardCIEnv,
      NETLIFY_AUTH_TOKEN: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
    },
    steps: [
      ...baseSteps,
      netlifyDeployStep(),
      netlifyStorybookCommentStep(NETLIFY_SITE),
      savePnpmStoreStep(),
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
} as const

export default ciWorkflow({
  name: 'CI',
  on: {
    push: { branches: ['main'] },
    pull_request: { branches: ['main'] },
    workflow_dispatch: {
      inputs: {
        debug_force_nix_diagnostics_failure: {
          description:
            'Temporary debug switch (#272): force post-validation failure to verify diagnostics artifact + summary',
          required: false,
          default: false,
          type: 'boolean',
        },
      },
    },
  },
  jobs: {
    ...jobs,
    ...extraJobs,
    ...deployJobs,
    'notify-alignment': notifyAlignmentJob({
      targetRepo: 'schickling/megarepo-all',
      needs: Object.keys(jobs),
    }),
  },
} satisfies GitHubWorkflowArgs)
