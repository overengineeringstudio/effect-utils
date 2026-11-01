import { rootNixSourceGlobs } from '../../genie/buck2/root-aggregate-projection.ts'
import {
  type RunnerProfile,
  type NamespacePrivilege,
  bashShellDefaults,
  buck2TrustedCacheWriterStep,
  buck2PublicCacheWriteSecret,
  cachixCliBuildStep,
  cachixStep,
  cachixPublisherStep,
  cachixPushStep,
  checkoutStep,
  ciOtelSpansArtifactStep,
  ciOtelSpansSummaryStep,
  prepareCiScriptsStep,
  notifyAlignmentJob,
  preparePinnedDevenvStep,
  prepareCiOtelSpoolStep,
  installNixStep,
  linuxSandboxPrerequisitesStep,
  runDevenvTasksBefore,
  ciWorkflow,
  type CiWorkflowArgs,
  ciMeasurementBaselineCheckoutStep,
  ciMeasurementBaselineWorkflowDispatchInputs,
  ciMeasurementNotBaselineBackfillPredicate,
  ciMeasurementSubjectEnv,
  ciMeasurementsArtifactStep,
  compareCiMeasurementsStep,
  defaultNixClosureMeasurementBuckets,
  devenvPerfJob,
  downloadPreviousGitHubArtifactStep,
  LEGACY_NAMESPACE_LINUX_X64_PAIRED_PERF_RUNNER,
  namespaceRunner,
  nixClosureMeasurementSteps,
  sourceShapeMeasurementSteps,
  nixDiagnosticsArtifactStep,
  workflowReportCommentBodyStep,
  workflowReportCollectorStep,
  workflowReportPublisherStep,
  deployPreviewWorkflowReportPathOutputName,
  netlifyDeployStep,
  validateNixStoreStep,
  withCiSourceRoot,
  withGcRaceRetry,
  defaultRefPolicyCheckJob,
  prReviewsResolvedJob,
  prReviewsResolvedJobId,
  githubTokenEnv,
  githubAppInstallationTokenStep,
  githubAccessTokenEnv,
  readBinaryCacheDescriptors,
  publisherWriteSecret,
  withNixRealisationTimeouts,
} from '../../genie/ci-workflow.ts'
import { withBuck2CacheEvidence } from '../../genie/ci-workflow/buck2-cache-evidence.ts'
import { withBuck2CachePostures } from '../../genie/ci-workflow/buck2-cache-posture.ts'
import { coreCachePostures } from '../../genie/ci-workflow/buck2-cache-proof-policy.ts'
import {
  withPipelineTelemetry,
  pipelineCloseJob,
} from '../../genie/ci-workflow/pipeline-telemetry.ts'
import { effectUtilsWorkflowPolicy } from '../../genie/ci-workflow/policy.ts'
import { publishedRefIf, publishedRefSteps } from '../../genie/ci-workflow/published-ref.ts'
import type { CoreCIJobName } from '../../genie/ci.ts'
import { pipelineJobIdentifierSet } from '../../packages/@overeng/ci-tools/src/pipeline-job-names.ts'
import { pinnedAction } from '../../packages/@overeng/genie/src/runtime/github-workflow/action-pins.ts'

const workflowReportFlakeRef =
  "github:${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name || github.repository }}/${{ github.event_name == 'pull_request' && github.head_ref || github.ref_name }}#ci-tools"

const trustedCachixStep = cachixStep({ name: 'overeng-effect-utils' })
const binaryCache = readBinaryCacheDescriptors(
  new URL('../../nix/binary-caches.json', import.meta.url),
)['overeng-effect-utils']!

// Successful CI runs: latest 30 merge groups, 10 PRs and 10 pushes, excluding
// incident 39609540541. Seconds, nearest-rank p95 and maximum; see the PR table.
// These bound bootstrap and explicit Nix builds, not ordinary test workloads.
const nixRealisationTimingsSeconds = {
  'Install Nix': { Linux: { p95: 34, max: 57 }, macOS: { p95: 86, max: 91 } },
  'Provide cachix CLI from nixpkgs': { Linux: { p95: 8, max: 75 }, macOS: { p95: 49, max: 59 } },
  'Resolve devenv': { Linux: { p95: 61, max: 161 }, macOS: { p95: 55, max: 56 } },
  'Prepare source generator dependency views': {
    Linux: { p95: 269, max: 755 },
    macOS: { p95: 466, max: 747 },
  },
  'Build every published from-source product': { p95: 321, max: 329 },
  'Build and smoke native and compiled products': {
    Linux: { p95: 179, max: 280 },
    macOS: { p95: 64, max: 74 },
  },
  'Publish products': { p95: 630, max: 630 },
  'Live Netlify ci-tools E2E': { p95: 1111, max: 1111 },
  'Live Vercel ci-tools E2E': { p95: 256, max: 256 },
  'Prepare Nix': { p95: 5, max: 8 },
  'Link started job roots': { p95: 109, max: 112 },
  'Publish Pipeline traces': { p95: 126, max: 126 },
  'Audit native dependency policy': { p95: 1, max: 1 },
  'Measure source shape: effect-utils': { p95: 10, max: 18 },
} as const

const prepareSourceGeneratorDependencyViewsStep = {
  name: 'Prepare source generator dependency views',
  env: githubTokenEnv(),
  run: runDevenvTasksBefore('buck2:editor:bootstrap'),
} as const

const baseSteps = [
  checkoutStep(),
  installNixStep({ binaryCaches: [binaryCache] }),
  linuxSandboxPrerequisitesStep({ privileged: 'trusted' }),
  ciMeasurementBaselineCheckoutStep,
  cachixCliBuildStep,
  trustedCachixStep,
  prepareCiScriptsStep,
  preparePinnedDevenvStep,
  validateNixStoreStep,
  prepareSourceGeneratorDependencyViewsStep,
  /**
   * Temporary debug switch for #272 to validate failure-path diagnostics without waiting for a real flake.
   * Remove once #201/#272 are root-caused and diagnostics instrumentation is removed.
   */
  {
    name: 'Force diagnostics failure (debug)',
    if: "${{ github.event_name == 'workflow_dispatch' && (inputs.debug_force_nix_diagnostics_failure == true || inputs.debug_force_nix_diagnostics_failure == 'true') }}",
    shell: 'bash',
    run: [
      'diag_dir="${NIX_STORE_DIAGNOSTICS_DIR:-${RUNNER_TEMP:-/tmp}/composition-state/nix-store-diagnostics-missing}"',
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

const liveNetlifyCiToolsPreflightStep = {
  id: 'live-netlify-preflight',
  name: 'Check live Netlify ci-tools E2E secrets',
  shell: 'bash',
  env: {
    NETLIFY_AUTH_TOKEN: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
    NETLIFY_SITE_ID: '${{ secrets.NETLIFY_SITE_ID }}',
  },
  run: [
    'if [ -z "${NETLIFY_AUTH_TOKEN:-}" ] || [ -z "${NETLIFY_SITE_ID:-}" ]; then',
    '  echo "::notice::Skipping live Netlify ci-tools E2E because NETLIFY_AUTH_TOKEN or NETLIFY_SITE_ID is unavailable"',
    '  echo "run=false" >> "$GITHUB_OUTPUT"',
    '  exit 0',
    'fi',
    'echo "run=true" >> "$GITHUB_OUTPUT"',
  ].join('\n'),
} as const

const liveNetlifyCiToolsIf = "steps.live-netlify-preflight.outputs.run == 'true'"

const andLiveNetlifyCiToolsIf = (condition: string) => {
  const trimmed = condition.trim()
  const unwrapped =
    trimmed.startsWith('${{') === true && trimmed.endsWith('}}') === true
      ? trimmed.slice(3, -2).trim()
      : trimmed
  return `${unwrapped} && ${liveNetlifyCiToolsIf}`
}

const onlyWhenLiveNetlifyCiTools = <Step extends Record<string, unknown>>(step: Step) => ({
  ...step,
  if:
    typeof step.if === 'string' && step.if.length > 0
      ? andLiveNetlifyCiToolsIf(step.if)
      : liveNetlifyCiToolsIf,
})

const liveNetlifyCiToolsE2EStep = {
  name: 'Live Netlify ci-tools E2E',
  shell: 'bash',
  env: {
    ...githubTokenEnv(),
    CI_TOOLS_NETLIFY_LIVE: '1',
    NETLIFY_AUTH_TOKEN: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
    NETLIFY_SITE_ID: '${{ secrets.NETLIFY_SITE_ID }}',
  },
  run: withCiSourceRoot(
    [
      'netlify_pkg="$(nix build --no-link --print-out-paths .#netlify-cli)"',
      'export CI_TOOLS_LIVE_NETLIFY_BIN="$netlify_pkg/bin/netlify"',
      'EDITOR_VIEW_PACKAGES=\'["packages/@overeng/ci-tools"]\' DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false "${DEVENV_BIN:?DEVENV_BIN not set}" tasks run buck2:editor:publish',
      'DEVENV_TUI=false "${DEVENV_BIN:?DEVENV_BIN not set}" shell --no-reload -- bun test packages/@overeng/ci-tools/src/deploy-netlify.live.e2e.test.ts',
    ].join('\n'),
  ),
} as const

const liveVercelCiToolsPreflightStep = {
  id: 'live-vercel-preflight',
  name: 'Check live Vercel ci-tools E2E secrets',
  shell: 'bash',
  env: {
    VERCEL_TOKEN: '${{ secrets.VERCEL_TOKEN }}',
    VERCEL_PROJECT_ID: '${{ secrets.VERCEL_PROJECT_ID }}',
    VERCEL_ORG_ID: '${{ secrets.VERCEL_ORG_ID }}',
    VERCEL_SCOPE: '${{ secrets.VERCEL_SCOPE }}',
  },
  run: [
    'if [ -z "${VERCEL_TOKEN:-}" ] || [ -z "${VERCEL_PROJECT_ID:-}" ] || [ -z "${VERCEL_ORG_ID:-}" ] || [ -z "${VERCEL_SCOPE:-}" ]; then',
    '  echo "::notice::Skipping live Vercel ci-tools E2E because VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_ORG_ID, or VERCEL_SCOPE is unavailable"',
    '  echo "run=false" >> "$GITHUB_OUTPUT"',
    '  exit 0',
    'fi',
    'echo "run=true" >> "$GITHUB_OUTPUT"',
  ].join('\n'),
} as const

const liveVercelCiToolsIf = "steps.live-vercel-preflight.outputs.run == 'true'"

const andLiveVercelCiToolsIf = (condition: string) => {
  const trimmed = condition.trim()
  const unwrapped =
    trimmed.startsWith('${{') === true && trimmed.endsWith('}}') === true
      ? trimmed.slice(3, -2).trim()
      : trimmed
  return `${unwrapped} && ${liveVercelCiToolsIf}`
}

const onlyWhenLiveVercelCiTools = <Step extends Record<string, unknown>>(step: Step) => ({
  ...step,
  if:
    typeof step.if === 'string' && step.if.length > 0
      ? andLiveVercelCiToolsIf(step.if)
      : liveVercelCiToolsIf,
})

const liveVercelCiToolsE2EStep = {
  name: 'Live Vercel ci-tools E2E',
  shell: 'bash',
  env: {
    ...githubTokenEnv(),
    CI_TOOLS_VERCEL_LIVE: '1',
    VERCEL_TOKEN: '${{ secrets.VERCEL_TOKEN }}',
    VERCEL_PROJECT_ID: '${{ secrets.VERCEL_PROJECT_ID }}',
    VERCEL_ORG_ID: '${{ secrets.VERCEL_ORG_ID }}',
    VERCEL_TEAM_ID: '${{ secrets.VERCEL_TEAM_ID }}',
    VERCEL_SCOPE: '${{ secrets.VERCEL_SCOPE }}',
    VERCEL_AUTOMATION_BYPASS_SECRET: '${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}',
  },
  run: withCiSourceRoot(
    [
      'vercel_pkg="$(nix build --no-link --print-out-paths .#vercel-cli)"',
      'export CI_TOOLS_LIVE_VERCEL_BIN="$vercel_pkg/bin/vercel"',
      'EDITOR_VIEW_PACKAGES=\'["packages/@overeng/ci-tools"]\' DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false "${DEVENV_BIN:?DEVENV_BIN not set}" tasks run buck2:editor:publish',
      'DEVENV_TUI=false "${DEVENV_BIN:?DEVENV_BIN not set}" shell --no-reload -- bun test packages/@overeng/ci-tools/src/deploy-vercel.live.e2e.test.ts',
    ].join('\n'),
  ),
} as const

const storybookPreviewBundlePath =
  '${{ runner.temp }}/workflow-reports/storybook-preview-bundle.json'
const storybookPreviewCommentBodyPath =
  '${{ runner.temp }}/workflow-reports/storybook-preview-comment.md'
const storybookPreviewSummaryPath =
  '${{ runner.temp }}/workflow-reports/storybook-preview-summary.md'

/** Verify shell activation is mutation-free and exposes the native Buck command. */
const verifyOtelShellEntryStep = {
  name: 'Verify mutation-free shell entry',
  env: githubTokenEnv(),
  shell: 'bash' as const,
  run: withCiSourceRoot(
    [
      runDevenvTasksBefore('otel:test'),
      'command -v script >/dev/null 2>&1',
      'tmp_log="$(mktemp)"',
      'before="$(git status --porcelain=v1)"',
      `printf 'command -v buck2\nexit\n' | script -qefc '"${'${DEVENV_BIN:?DEVENV_BIN not set}'}" shell --no-reload' "$tmp_log"`,
      'grep -q \'/bin/buck2\' "$tmp_log"',
      '! grep -q \'\\[otel\\] Using\' "$tmp_log"',
      'test "$(git status --porcelain=v1)" = "$before"',
      'rm -f "$tmp_log"',
    ].join('\n'),
  ),
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

const jobTimeoutMinutes = 30
const longJobTimeoutMinutes = 45

const heavyCiIf = `\${{ !cancelled() && (${ciMeasurementNotBaselineBackfillPredicate}) && (github.event_name == 'merge_group' || (github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.tested-tree.outputs.tested != 'true')) }}`
const trustedSecretCiIf = `\${{ (${ciMeasurementNotBaselineBackfillPredicate}) && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}`
// Branch secrets are available only through a deliberate collaborator dispatch, never a PR event.
const notionIntegrationCiIf = `\${{ (${ciMeasurementNotBaselineBackfillPredicate}) && ((github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')) || (github.event_name == 'workflow_dispatch' && inputs.run_notion_integration_on_branch == true)) }}`
const empiricalProofLaneIf = `\${{ (${ciMeasurementNotBaselineBackfillPredicate}) && ((github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')) || (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'ci:heavy-proofs') && (github.event.action != 'labeled' || github.event.label.name == 'ci:heavy-proofs'))) }}`
const publishingCachixStep = cachixPublisherStep({
  name: 'overeng-effect-utils',
  authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}',
  jobIf: trustedSecretCiIf,
  triggers: ['push', 'workflow_dispatch'],
})

/**
 * The paired wall-clock lane runs only when explicitly requested by an operator.
 * It stays outside automatic PR, push, and scheduled cadence because its advisory
 * evidence does not affect those events' outcomes.
 */
const devenvPerfLaneIf = `\${{ github.event_name == 'workflow_dispatch' }}`

/**
 * The report aggregates whichever measurement lanes ran on `main`: the two
 * deterministic lanes on push/schedule, and all three lanes on dispatch. A
 * skipped `devenv-perf` must not skip the report, so the condition inspects
 * `needs` results instead of relying on implicit success.
 */
const measurementReportIf = [
  '${{ !cancelled()',
  `&& (${ciMeasurementNotBaselineBackfillPredicate})`,
  "&& github.ref == 'refs/heads/main'",
  "&& (github.event_name == 'push' || github.event_name == 'workflow_dispatch' || github.event_name == 'schedule')",
  "&& needs.devenv-perf.result != 'failure'",
  "&& needs.nix-closure-sizes.result != 'failure'",
  "&& needs.main-source-shape.result != 'failure' }}",
].join(' ')

/** Required checks, main verification and publication share the delivery tier. */
const deliveryJobPriority = 1
const backgroundJobPriority = 4

const job = ({
  step,
  privileged,
  priority = deliveryJobPriority,
  extraSteps = [],
  afterSteps = [],
  laneIf = heavyCiIf,
  timeoutMinutes = jobTimeoutMinutes,
}: {
  step: { name: string; run: string; env?: Record<string, string> }
  privileged: NamespacePrivilege
  priority?: number | string
  extraSteps?: readonly any[]
  afterSteps?: readonly any[]
  laneIf?: string
  timeoutMinutes?: number
}) => ({
  if: laneIf,
  ...(laneIf === heavyCiIf ? { needs: ['tested-tree'] } : {}),
  'runs-on': namespaceRunner({
    profile: 'namespace-profile-linux-x86-64',
    runId: '${{ github.run_id }}',
    privileged,
    priority,
  }),
  'timeout-minutes': timeoutMinutes,
  defaults: bashShellDefaults,
  steps: [
    ...baseSteps,
    ...extraSteps,
    laneIf === heavyCiIf ? buck2TrustedCacheWriterStep(step) : step,
    ...afterSteps,
    nixDiagnosticsSummaryStep,
    nixDiagnosticsArtifactStep(),
    failureReminderStep,
  ],
})

const playwrightTestRun = (packageName: 'utils' | 'tui-react') =>
  [
    `network_dir="packages/@overeng/${packageName}/test-results/network"`,
    'mkdir -p "$network_dir"',
    'date -u --iso-8601=ns > "$network_dir/runner-network.log"',
    'if command -v ip >/dev/null 2>&1; then',
    '  ip -details link show >> "$network_dir/runner-network.log"',
    '  ip address show >> "$network_dir/runner-network.log"',
    '  ip route show table all >> "$network_dir/runner-network.log"',
    '  TZ=UTC ip -ts monitor link address route >> "$network_dir/runner-network.log" 2>&1 &',
    '  network_monitor_pid=$!',
    '  stop_network_monitor() {',
    '    kill "$network_monitor_pid" 2>/dev/null || true',
    '    wait "$network_monitor_pid" 2>/dev/null || true',
    '    date -u --iso-8601=ns >> "$network_dir/runner-network.log"',
    '  }',
    '  trap stop_network_monitor EXIT',
    'else',
    '  echo "iproute2 unavailable; runner network changes were not captured" >> "$network_dir/runner-network.log"',
    '  echo "::warning::iproute2 unavailable for Playwright network evidence"',
    'fi',
    runDevenvTasksBefore(`test:pw:${packageName}`),
  ].join('\n')

/** Build and `--help`-smoke compiled-executable and native products. */
const compiledProductsSmokeStep = {
  name: 'Build and smoke native and compiled products',
  env: githubTokenEnv(),
  run: withCiSourceRoot('bash genie/ci-scripts/compiled-products.sh'),
} as const

/**
 * Cold macOS runners spent ~34 min substituting the test closure from cache.nixos.org
 * (q17/q18). The profile's cache volume holds a local binary cache that Nix tries before
 * the network caches. `/nix` itself cannot live on the volume: macOS mounts it as a
 * Determinate APFS volume on a read-only root.
 *
 * Merge-group runs execute queued PR code and can write the volume, so the cache relies
 * on Nix signature checks: only paths whose upstream signature (cache.nixos.org, Cachix)
 * verifies are substituted from it. Cache trouble never fails the lane.
 */
const macosNixSubstituterDir = '/Users/runner/.cache/nix-substituter'
const macosNixSubstituterUri = `file://${macosNixSubstituterDir}`

const macosNixSubstituterMountStep = {
  name: 'Mount local Nix substituter cache volume',
  ...pinnedAction({ name: 'namespaceCache' }),
  'continue-on-error': true,
  with: { path: macosNixSubstituterDir },
} as const

/**
 * `cachix use` rewrites the user nix.conf with a replacing `substituters =` line, so the
 * local cache is appended after it. The runner user is trusted, so the daemon honours it.
 */
const macosNixSubstituterEnableStep = {
  name: 'Enable local Nix substituter',
  'continue-on-error': true,
  run: [
    'set -euo pipefail',
    'conf="${XDG_CONFIG_HOME:-$HOME/.config}/nix/nix.conf"',
    'mkdir -p "$(dirname "$conf")"',
    `printf '\\nextra-substituters = %s\\n' '${macosNixSubstituterUri}?priority=10' >> "$conf"`,
    'nix config show substituters',
  ].join('\n'),
} as const

/**
 * Content-addressed paths (including fixed-output downloads) are self-verifying and do
 * not need signatures. Input-addressed paths still need an upstream signature; `ultimate`
 * alone is not sufficient. The daemon owns the cache files, so the copy runs as root.
 */
const macosNixSubstituterSaveStep = {
  name: 'Save signed and content-addressed store paths to local Nix substituter',
  if: '${{ !cancelled() }}',
  'continue-on-error': true,
  'timeout-minutes': 15,
  run: [
    'set -euo pipefail',
    'started=$SECONDS',
    'paths="$RUNNER_TEMP/substitutable-store-paths"',
    `nix path-info --all --json | jq -r 'to_entries[] | select(((.value.signatures // []) | length > 0) or ((.value.ca // "") | length > 0)) | .key' > "$paths"`,
    `sudo env "PATH=$PATH" nix copy --stdin --to '${macosNixSubstituterUri}?compression=zstd&parallel-compression=true' < "$paths"`,
    `echo "saved $(wc -l < "$paths") signed or content-addressed paths in $((SECONDS - started))s; cache size $(du -sh '${macosNixSubstituterDir}/' | cut -f1)"`,
  ].join('\n'),
} as const

const withMacosNixSubstituter = <TStep>(steps: readonly TStep[]) => {
  const [checkout, ...rest] = steps
  return [checkout!, macosNixSubstituterMountStep, ...rest].flatMap((step) =>
    step === trustedCachixStep
      ? [step, macosNixSubstituterEnableStep]
      : step === prepareSourceGeneratorDependencyViewsStep
        ? [
            step,
            {
              ...macosNixSubstituterSaveStep,
              name: 'Warm local Nix substituter after bootstrap',
              if: '${{ success() }}',
            },
          ]
        : [step],
  )
}

// Static names survive GitHub's job-level skip before matrix expansion. Both required
// runner-qualified contexts must exist on a PR before it can enter the native queue.
const unitTestJob = ({
  runner,
  privileged,
}: {
  runner: RunnerProfile
  privileged: NamespacePrivilege
}) => ({
  name: `test (${runner})`,
  if: heavyCiIf,
  needs: ['tested-tree'],
  'runs-on': namespaceRunner({
    profile: runner,
    runId: '${{ github.run_id }}',
    privileged,
    priority: deliveryJobPriority,
  }),
  'timeout-minutes': 90,
  defaults: bashShellDefaults,
  // Keep one shell configuration across telemetry, tests and product smoke.
  env: {
    EFFECT_UTILS_CI_TEST: '1',
    EFFECT_UTILS_TEST_PLATFORM: runner === 'namespace-profile-macos-arm64' ? 'darwin' : 'linux',
  },
  steps: [
    ...(runner === 'namespace-profile-macos-arm64'
      ? withMacosNixSubstituter(baseSteps)
      : baseSteps),
    buck2TrustedCacheWriterStep({
      name: 'Unit tests',
      env: githubTokenEnv(),
      run: [
        // Bash job control gives the sampler and its native children a private
        // process group on both runner platforms, without a setsid dependency.
        'set -m',
        'bash genie/ci-scripts/test-resource-sampler.sh tmp/ci-resources/test-resources.json &',
        'resource_sampler=$!',
        'set +m',
        // Diagnostics cannot gate completion, even if a native sampler command
        // stalls. Completed samples are persisted before the next command.
        'trap \'status=$?; trap - EXIT; kill -TERM -- "-$resource_sampler" 2>/dev/null || :; kill -KILL -- "-$resource_sampler" 2>/dev/null || :; exit "$status"\' EXIT',
        runDevenvTasksBefore('test:run'),
      ].join('\n'),
    }),
    ...(runner === 'namespace-profile-macos-arm64'
      ? [
          buck2TrustedCacheWriterStep({
            name: 'Buck daemon cache posture regressions',
            env: githubTokenEnv(),
            run: runDevenvTasksBefore('buck2:cache-posture:ci-test'),
          }),
          buck2TrustedCacheWriterStep(compiledProductsSmokeStep),
          {
            name: 'Build Darwin Nix TypeScript product',
            env: githubTokenEnv(),
            run: withCiSourceRoot(
              [
                'set -euo pipefail',
                'echo "Runner default Nix sandbox setting:"',
                'nix config show sandbox',
                // Exercise the derivation boundary even where the runner cannot
                // start Buck inside a second, fully enabled Nix sandbox.
                'nix build .#buck-product-overeng-content-address-from-source --no-link --print-build-logs --option sandbox false',
              ].join('\n'),
            ),
          },
          macosNixSubstituterSaveStep,
        ]
      : []),
    nixDiagnosticsSummaryStep,
    nixDiagnosticsArtifactStep(),
    failureReminderStep,
    {
      name: 'Upload retained Vitest collection reports',
      if: '${{ always() }}',
      'continue-on-error': true,
      ...pinnedAction({ name: 'uploadArtifact' }),
      with: {
        name: 'vitest-collection-${{ github.job }}-${{ github.run_id }}-${{ github.run_attempt }}',
        path: 'tmp/otel-scrape/summaries/*.vitest.json',
        'if-no-files-found': 'ignore',
        'retention-days': 14,
      },
    },
    {
      name: 'Upload test resource samples',
      if: '${{ always() }}',
      'continue-on-error': true,
      ...pinnedAction({ name: 'uploadArtifact' }),
      with: {
        name: 'test-resources-${{ github.job }}-${{ github.run_id }}-${{ github.run_attempt }}',
        path: 'tmp/ci-resources/test-resources.json',
        'if-no-files-found': 'ignore',
        'retention-days': 14,
      },
    },
  ],
})

/**
 * Audit the native npm dependency policy against the lockfile (issue #807).
 * Install-free: depends only on `pnpm-lock.yaml` and the genie policy source.
 */
const nativeDepPolicyAuditStep = {
  name: 'Audit native dependency policy',
  shell: 'bash',
  env: githubTokenEnv(),
  run: withCiSourceRoot(
    [
      'set -euo pipefail',
      'audit=genie/ci-scripts/native-dep-policy-audit.ts',
      'if command -v bun >/dev/null 2>&1; then',
      '  bun "$audit"',
      '  bun test ./genie/ci-scripts/tested-tree.unit.test.ts ./genie/ci-workflow/buck2-cache-posture.unit.test.ts ./genie/ci-workflow/buck2-cache-posture.integration.test.ts',
      'else',
      '  nix run nixpkgs#bun -- "$audit"',
      '  nix run nixpkgs#bun -- test ./genie/ci-scripts/tested-tree.unit.test.ts ./genie/ci-workflow/buck2-cache-posture.unit.test.ts ./genie/ci-workflow/buck2-cache-posture.integration.test.ts',
      'fi',
    ].join('\n'),
  ),
} as const

/**
 * Genie freshness does not prove that `pnpm-lock.yaml` still matches every
 * regenerated `package.json` specifier (#1409, #1427 both slipped a stale lock past
 * PR CI). A frozen, lockfile-only, offline install fails with
 * ERR_PNPM_OUTDATED_LOCKFILE on any drift, without resolving or fetching anything.
 * `minimum-release-age=0` skips only the release-age policy pass, which needs registry
 * metadata a cold runner cache lacks offline; real installs still enforce it.
 */
const frozenLockfileStep = {
  name: 'Check pnpm lockfile matches package specifiers',
  env: { ...githubTokenEnv(), DEVENV_TASK_PASSTHROUGH: '1' },
  run: withCiSourceRoot(
    '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- pnpm install --frozen-lockfile --lockfile-only --offline --ignore-scripts --config.minimum-release-age=0',
  ),
} as const

// Cheap deterministic queue proofs share the existing PR bootstrap and remain in
// the inert-Buck queue job. Keep their commands identical on both paths.
const cheapInertBuckSteps = [
  {
    name: 'Run focused normalized, projection, and runner tests',
    env: githubTokenEnv(),
    run: withCiSourceRoot(
      [
        'set -euo pipefail',
        'FINGERPRINT_BIN="$(nix build --no-link --print-out-paths .#buck2-fingerprint)/bin/buck2-fingerprint"',
        'export FINGERPRINT_BIN',
        'runner_modules="$("${DEVENV_BIN:?DEVENV_BIN not set}" shell -- buck2 build //packages/@overeng/buck2-tools:node_modules --show-simple-output)"',
        'package_modules=packages/@overeng/buck2-tools/node_modules',
        'if [ -e "$package_modules" ] || [ -L "$package_modules" ]; then mv "$package_modules" "${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-tools-original-node-modules"; fi',
        'ln -s "$PWD/$runner_modules" "$package_modules"',
        '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bun test \\',
        // Bare Bun arguments are suffix filters and discover staged buck-out copies.
        '  ./genie/buck2/typescript-package-projection.unit.test.ts \\',
        '  ./genie/buck2/javascript-candidates.unit.test.ts \\',
        '  ./packages/@overeng/buck2-tools/src/package-command-runner.unit.test.ts \\',
        '  ./packages/@overeng/buck2-tools/src/javascript-runner.unit.test.ts',
      ].join('\n'),
    ),
  },
  {
    name: 'Reject tracked product and editor payload bytes',
    // Derive Nix recipe admission from //:nix_sources ownership, then check
    // the remaining exact metadata/test allowlist.
    run: withCiSourceRoot(
      [
        'set -euo pipefail',
        "tracked_editor=$(git ls-files -- '**/.editor-view/**' '.editor-view/**')",
        `tracked_product=$(git ls-files -- 'nix/buck2-products/**' ${rootNixSourceGlobs.map((glob) => `':(glob,exclude)nix/buck2-products/${glob}'`).join(' ')} | grep -Ev '^nix/buck2-products/(cache-targets\\.json|cache-targets\\.json\\.genie\\.ts|capability-closure\\.test\\.sh|compiled-targets\\.json|compiled-targets\\.json\\.genie\\.ts|from-source-contract\\.test\\.sh|from-source-cores\\.test\\.sh|manifest\\.json|native-targets\\.json|native-targets\\.json\\.genie\\.ts|private-product-tarballs\\.test\\.sh|publish\\.sh|targets\\.json|targets\\.json\\.genie\\.ts)$' || true)`,
        'invalid_sources=()',
        "while IFS= read -r -d '' path; do",
        '  case "/$path/" in',
        '    */buck-out/*|*/.editor-view/*|*/result*/*|*/dist/*|*/node_modules/*|*/storybook-static/*|*/tmp/*|*/target/*|*/.devenv/*) ;;',
        '    *)',
        '      if [ "$(git --literal-pathspecs cat-file -s ":$path")" -le 262144 ] && git --literal-pathspecs grep --cached -I --name-only -e \'\' -- "$path" >/dev/null; then',
        '        continue',
        '      fi',
        '      ;;',
        '  esac',
        '  invalid_sources+=("$path")',
        `done < <(git ls-files -z -- ${rootNixSourceGlobs.map((glob) => `':(glob)nix/buck2-products/${glob}'`).join(' ')})`,
        'tracked_source=$(printf \'%s\\n\' "${invalid_sources[@]}")',
        'if [ -n "$tracked_editor$tracked_product$tracked_source" ]; then',
        '  printf \'Tracked inert payload bytes are forbidden:\\n%s\\n%s\\n%s\\n\' "$tracked_editor" "$tracked_product" "$tracked_source" >&2',
        '  exit 1',
        'fi',
      ].join('\n'),
    ),
  },
  {
    name: 'Query and build representative inert Buck targets',
    env: githubTokenEnv(),
    run: withCiSourceRoot(
      [
        'set -euo pipefail',
        '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bash -euo pipefail -c \'',
        '  cd "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE not set}"',
        '  buck="${BUCK2_BIN:?BUCK2_BIN not set}"',
        '  "$buck" query effect_utils//packages/@overeng/ci-tools:ci-tools-candidate',
        '  "$buck" query effect_utils//:editor_view_inputs',
        '  "$buck" build \\',
        '    effect_utils//packages/@overeng/ci-tools:ci-tools-candidate \\',
        '    effect_utils//:editor_view_inputs',
        "'",
      ].join('\n'),
    ),
  },
]

/** Prepare only each source suite's dependency views, restoring them even on failure. */
const sourceRegressionStep = ({
  name,
  packages,
  tasks,
}: {
  name: string
  packages: readonly string[]
  tasks: readonly string[]
}) => ({
  name,
  env: githubTokenEnv(),
  run: withCiSourceRoot(
    [
      'set -euo pipefail',
      '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bash -euo pipefail -c \'',
      '  prepared=()',
      '  restore_views() {',
      '    for package in "${prepared[@]}"; do',
      '      rm -f "$package/node_modules"',
      '      backup="$RUNNER_TEMP/genie-pr-${package##*/}-node-modules"',
      '      if [ -e "$backup" ] || [ -L "$backup" ]; then mv "$backup" "$package/node_modules"; fi',
      '    done',
      '  }',
      '  trap restore_views EXIT',
      `  for package in ${packages.join(' ')}; do`,
      '    if [ "$package" = . ]; then target=//:node_modules; else target=//$package:node_modules; fi',
      '    modules="$("${BUCK2_BIN:?BUCK2_BIN not set}" build "$target" --show-simple-output)"',
      '    backup="${RUNNER_TEMP:?RUNNER_TEMP not set}/genie-pr-${package##*/}-node-modules"',
      '    if [ -e "$package/node_modules" ] || [ -L "$package/node_modules" ]; then mv "$package/node_modules" "$backup"; fi',
      '    prepared+=("$package")',
      '    ln -s "$PWD/$modules" "$package/node_modules"',
      '  done',
      `  "$DEVENV_BIN" tasks run --mode single ${tasks.join(' ')}`,
      "'",
    ].join('\n'),
  ),
})

// Core product jobs keyed by the shared Genie CI source of truth.
const jobs: Record<CoreCIJobName, CiWorkflowArgs['jobs'][string]> = {
  // Share one Linux bootstrap across the four quality invariants.
  quality: {
    name: 'pr/quality',
    ...job({
      privileged: 'trusted',
      priority: deliveryJobPriority,
      laneIf: `\${{ !cancelled() && (${ciMeasurementNotBaselineBackfillPredicate}) && (github.event_name != 'push' || needs.tested-tree.outputs.tested != 'true') }}`,
      timeoutMinutes: 90,
      extraSteps: [
        {
          name: 'Check published product inventory against the gated diff',
          env: {
            ...githubTokenEnv(),
            MANIFEST_BASE_SHA:
              '${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}',
          },
          run: withCiSourceRoot('bash genie/ci-scripts/buck2-manifest-inventory.sh'),
        },
        {
          name: 'Cargo archive-tool regression tests',
          if: "${{ github.event_name == 'pull_request' }}",
          env: githubTokenEnv(),
          run: withCiSourceRoot(
            '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- cargo test --locked --manifest-path rust/Cargo.toml --package buck2-archive-tool',
          ),
        },
        {
          name: 'Check shared megarepo task flags against the published CLI',
          env: githubTokenEnv(),
          run: withCiSourceRoot(
            '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bash nix/devenv-modules/tasks/shared/tests/megarepo-product-flags.test.sh "$PWD"',
          ),
        },
        {
          name: 'Check published and source JavaScript import contracts',
          env: githubTokenEnv(),
          run: withCiSourceRoot(
            '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bash nix/workspace-tools/lib/tests/javascript-product-import.sh "$PWD"',
          ),
        },
        {
          name: 'Enforce root changelog retirement',
          run: withCiSourceRoot(
            [
              'set -euo pipefail',
              'tracked="$(git ls-files -- \':(top,literal)CHANGELOG.md\')"',
              'if [ -n "$tracked" ]; then',
              '  echo \'::error::Root CHANGELOG.md is retired. See AGENTS.md "Breaking Changes": record changes in commits and PRs; include ! and BREAKING CHANGE: migration notes for breaking changes.\'',
              '  exit 1',
              'fi',
            ].join('\n'),
          ),
        },
        buck2TrustedCacheWriterStep(verifyOtelShellEntryStep),
        buck2TrustedCacheWriterStep({
          name: 'Type check (Buck)',
          env: githubTokenEnv(),
          run: runDevenvTasksBefore('buck2:quick'),
        }),
        frozenLockfileStep,
        buck2TrustedCacheWriterStep({
          name: 'Format + lint',
          env: githubTokenEnv(),
          // Generated-file freshness stays authoritative, not just a local fast path.
          run: runDevenvTasksBefore('genie:check', 'lint:check'),
        }),
        // Keep these source-side contract suites on the PR path as well as test:run:
        // generator freshness and Buck type checking do not execute their assertions.
        buck2TrustedCacheWriterStep(
          sourceRegressionStep({
            name: 'Genie projection and CI workflow regression tests',
            // test:run publishes all views; these suites need only these exact closures.
            packages: ['.', 'packages/@overeng/megarepo'],
            tasks: [
              'genie:buck2:test',
              'genie:ci-workflow:test',
              'buck2:rust:generators:test',
              'buck2:cache-posture:ci-test',
            ],
          }),
        ),
        {
          name: 'CI policy action isolation smoke',
          env: githubTokenEnv(),
          run: withCiSourceRoot(
            'nix shell .#bun --command bun test ./genie/ci-workflow/check-policy-action.integration.test.ts',
          ),
          'timeout-minutes': 5,
        },
        // The aggregate unit jobs are queue/main-only; keep web highlighting and SSR
        // regressions in the required PR lane through the existing package task.
        buck2TrustedCacheWriterStep({
          name: 'Notion React unit tests',
          env: githubTokenEnv(),
          run: runDevenvTasksBefore('test:notion-react'),
        }),
        buck2TrustedCacheWriterStep({
          name: 'Bundle smoke tests',
          env: githubTokenEnv(),
          run: runDevenvTasksBefore('bundle:smoke'),
        }),
        {
          name: 'CI runtime and native dependency policy regression checks',
          env: githubTokenEnv(),
          run: withCiSourceRoot(
            [
              'bash genie/ci-scripts/nix-gc-race-retry.test.sh',
              'bash genie/ci-scripts/ci-measurement-comparison.test.sh',
              'bash genie/ci-scripts/native-dep-policy-audit.test.sh',
            ].join('\n'),
          ),
        },
        {
          name: 'Native cache evidence regressions',
          env: githubTokenEnv(),
          run: withCiSourceRoot(
            [
              'nix shell .#bun --command bun test',
              './genie/ci-scripts/buck2-cache-evidence.unit.test.ts',
              './genie/ci-scripts/buck2-cache-evidence.integration.test.ts',
              './genie/ci-scripts/buck2-action-evidence.integration.test.ts',
              './genie/ci-scripts/buck2-cache-warm99.unit.test.ts',
              './genie/ci-scripts/buck2-cache-warm99.integration.test.ts',
              './genie/ci-scripts/buck2-cache-proof-reports.integration.test.ts',
              './genie/ci-scripts/buck2-cache-proof-history.unit.test.ts',
              './genie/ci-scripts/buck2-cache-shards.integration.test.ts',
              './genie/ci-scripts/buck2-cache-join.unit.test.ts',
              './genie/ci-scripts/buck2-cache-join-discovery.unit.test.ts',
              './genie/ci-scripts/buck2-cache-join-download.unit.test.ts',
              './genie/ci-workflow/buck2-cache-evidence.unit.test.ts',
              './genie/ci-workflow/buck2-cache-posture.integration.test.ts',
            ].join(' '),
          ),
        },
        {
          name: 'Downstream flake-input regression',
          env: githubTokenEnv(),
          run: withCiSourceRoot(
            'bash nix/workspace-tools/lib/tests/downstream-flake-input.sh "$PWD"',
          ),
        },
        ...cheapInertBuckSteps,
      ],
      step: nativeDepPolicyAuditStep,
    }),
    needs: ['tested-tree'],
  },
  // Bounded unit-test execution is Buck-owned: `test:run` waits on the single `test:buck2:unit`
  // invocation, source-only packages, and each lane's exact unbounded complement. Explicit
  // live/e2e owners remain separate jobs. The baseline gate reads Buck collection artifacts and
  // retained source summaries, and also proves every lane's recorded census exactly matches its
  // actual collection. CI must not shard this lane: the gate needs both partitions in one job.
  test: unitTestJob({ runner: 'namespace-profile-linux-x86-64', privileged: 'always' }),
  'test-macos': unitTestJob({ runner: 'namespace-profile-macos-arm64', privileged: 'always' }),
  'test-playwright-utils': job({
    privileged: 'always',
    priority: deliveryJobPriority,
    timeoutMinutes: longJobTimeoutMinutes,
    step: {
      name: 'Utils Playwright tests',
      env: githubTokenEnv(),
      run: playwrightTestRun('utils'),
    },
    afterSteps: [
      {
        name: 'Upload Playwright failure evidence',
        if: 'failure()',
        ...pinnedAction({ name: 'uploadArtifact' }),
        with: {
          name: 'playwright-test-results-utils-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}',
          path: 'packages/@overeng/utils/test-results/',
          'if-no-files-found': 'ignore',
          'retention-days': 14,
        },
      },
    ],
  }),
  'test-playwright-tui-react': job({
    privileged: 'always',
    priority: deliveryJobPriority,
    timeoutMinutes: longJobTimeoutMinutes,
    step: {
      name: 'TUI React Playwright tests',
      env: githubTokenEnv(),
      run: playwrightTestRun('tui-react'),
    },
    afterSteps: [
      {
        name: 'Upload Playwright failure evidence',
        if: 'failure()',
        ...pinnedAction({ name: 'uploadArtifact' }),
        with: {
          name: 'playwright-test-results-tui-react-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}',
          path: 'packages/@overeng/tui-react/test-results/',
          'if-no-files-found': 'ignore',
          'retention-days': 14,
        },
      },
    ],
  }),
  'test-megarepo-store-gc': {
    ...job({
      privileged: 'always',
      priority: deliveryJobPriority,
      laneIf: `\${{ (${ciMeasurementNotBaselineBackfillPredicate}) && (github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch' || github.event_name == 'merge_group') }}`,
      timeoutMinutes: longJobTimeoutMinutes,
      step: {
        name: 'Complete native megarepo regression tests',
        env: githubTokenEnv(),
        run: runDevenvTasksBefore('test:megarepo-store-gc'),
      },
      afterSteps: [
        {
          name: 'Complete native megarepo test receipt',
          if: '${{ always() }}',
          run: `jq -e '{numTotalTests, numPassedTests, numFailedTests, numPendingTests, success, testResults: [.testResults[] | {name, status, assertionResults: [.assertionResults[] | {fullName, status}]}]} | select(.success and .numTotalTests > 0)' tmp/otel-scrape/summaries/test-megarepo-unbounded.vitest.json`,
        },
      ],
    }),
    env: {
      EFFECT_UTILS_CI_TEST: '1',
      EFFECT_UTILS_TEST_PLATFORM: 'linux',
    },
  },
  'test-megarepo-cold-gc': job({
    privileged: 'trusted',
    priority: backgroundJobPriority,
    laneIf: empiricalProofLaneIf,
    timeoutMinutes: longJobTimeoutMinutes,
    step: {
      name: 'Megarepo cold-GC tests',
      env: githubTokenEnv(),
      run: runDevenvTasksBefore('test:megarepo-cold-gc'),
    },
    afterSteps: [
      {
        name: 'Cold-GC per-test receipt',
        if: '${{ always() }}',
        run: `jq -e '{numTotalTests, numPassedTests, numFailedTests, numPendingTests, success, testResults: [.testResults[] | {name, status, assertionResults: [.assertionResults[] | {fullName, status}]}]} | select(.success and .numTotalTests > 0)' tmp/otel-scrape/summaries/test-megarepo-cold-gc.vitest.json`,
      },
    ],
  }),

  cargo: job({
    privileged: 'always',
    priority: deliveryJobPriority,
    step: {
      name: 'Cargo build + test + clippy + fmt',
      env: githubTokenEnv(),
      run: runDevenvTasksBefore('cargo:check'),
    },
  }),
  // Weaver checks that intentionally remain outside Buck:
  //   - weaver:diff       (SC-R11) compares the merge-base-relative compatibility baseline.
  //                        The fetch step below unshallows the checkout so the baseline exists.
  //   - weaver:live-check (SC-R12) exercises the subprocess/network OTLP path.
  // The bounded registry and version checks run through Buck's quick aggregate in the same lane.
  weaver: job({
    privileged: 'always',
    priority: deliveryJobPriority,
    timeoutMinutes: longJobTimeoutMinutes,
    extraSteps: [
      {
        name: 'Fetch baseline history for weaver:diff (SC-R11)',
        run: withCiSourceRoot(
          [
            'set -uo pipefail',
            '# weaver:diff needs the merge-base with origin/main; the default checkout is shallow.',
            'git fetch --no-tags --prune --unshallow origin 2>/dev/null \\',
            '  || git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main 2>/dev/null \\',
            '  || true',
          ].join('\n'),
        ),
      },
    ],
    step: {
      name: 'Weaver registry gates (Buck quick + diff + live-check)',
      env: githubTokenEnv(),
      run: runDevenvTasksBefore('buck2:quick', 'weaver:diff', 'weaver:live-check'),
    },
  }),
}

// Source-shape/report aggregation and every producer use actions-checkout paths.
const sourceShapeMeasurementsDir = 'tmp/source-shape-ci'
const checkoutTmpDir = '${{ github.workspace }}/tmp'
// Intentional actions-checkout artifact path: devenvPerfJob owns ARTIFACT_DIR at job scope.
const devenvPerfMeasurementsDir = '${{ github.workspace }}/tmp/devenv-perf-ci'
const nixClosureMeasurementsDir = `${checkoutTmpDir}/nix-closure-ci`
const ciMeasurementReportDir = 'tmp/ci-measurement-report'

/**
 * `actions/download-artifact` fails when the named artifact does not exist, so a producer
 * lane that did not run in this event needs `producedBy` — the report then aggregates the
 * lanes that did run instead of failing on the ones that did not.
 */
const downloadCurrentMeasurementArtifactStep = ({
  artifactName,
  outputDir,
  producedBy,
}: {
  artifactName: string
  outputDir: string
  producedBy?: string
}) =>
  ({
    name: `Download current measurement artifact: ${artifactName}`,
    ...(producedBy === undefined ? {} : { if: `\${{ needs.${producedBy}.result == 'success' }}` }),
    ...pinnedAction({ name: 'downloadArtifact' }),
    with: {
      name: artifactName,
      path: outputDir,
    },
  }) as const

const ciMeasurementReportToolStep = {
  name: 'Provide CI measurement report tools',
  shell: 'bash',
  env: githubTokenEnv(),
  run: [
    'set -euo pipefail',
    'for out in $(nix build --no-link --print-out-paths nixpkgs#jq nixpkgs#nodejs nixpkgs#gh nixpkgs#resvg); do',
    '  echo "$out/bin" >> "$GITHUB_PATH"',
    'done',
  ].join('\n'),
} as const

const nixClosureMeasurementTargets = [
  {
    installable: '.#genie',
    id: 'genie_package',
    name: 'genie',
    label: 'Genie package',
    group: 'packages',
    path: ['nix', 'closures', 'packages', 'genie'],
    description: 'the Genie CLI closure wrapped from the immutable Buck product manifest',
    system: 'x86_64-linux',
  },
  {
    installable: '.#megarepo',
    id: 'megarepo_package',
    name: 'megarepo',
    label: 'Megarepo package',
    group: 'packages',
    path: ['nix', 'closures', 'packages', 'megarepo'],
    description: 'the megarepo CLI closure wrapped from the immutable Buck product manifest',
    system: 'x86_64-linux',
  },
  {
    installable: '.#oxlint-npm',
    id: 'oxlint_npm_package',
    name: 'oxlint-npm',
    label: 'oxlint npm package',
    group: 'packages',
    path: ['nix', 'closures', 'packages', 'oxlint-npm'],
    description: 'the packaged oxlint npm compatibility wrapper closure',
    system: 'x86_64-linux',
  },
] as const

// Non-core jobs are kept outside the typed product-job block but still tracked
// in genie/ci.ts for required-check policy.
const extraJobs: Record<string, any> = {
  /**
   * Fresh-checkout merge-group PR-A proof. This deliberately uses only public caches,
   * read-only permissions, and inert commands: it can validate product and editor machinery
   * from an untrusted fork without publication authority. Its from-source Nix and Buck TS
   * builds need nested user namespaces, so it uses the privileged Namespace Linux runner.
   */
  'pr-a-inert-buck': {
    if: heavyCiIf,
    needs: ['tested-tree'],
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'always',
      priority: deliveryJobPriority,
    }),
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: { contents: 'read' },
    env: {
      FORCE_SETUP: '1',
      CI: 'true',
      BUCK2_NO_REMOTE_CACHE: '1',
    },
    steps: [
      checkoutStep(),
      installNixStep(),
      cachixCliBuildStep,
      cachixStep({ name: 'overeng-effect-utils' }),
      prepareCiScriptsStep,
      preparePinnedDevenvStep,
      validateNixStoreStep,
      {
        name: 'Prepare source generator dependency views',
        env: githubTokenEnv(),
        run: runDevenvTasksBefore('buck2:editor:bootstrap'),
      },
      {
        name: 'Check generated sources',
        env: githubTokenEnv(),
        run: runDevenvTasksBefore('genie:check'),
      },
      {
        name: 'Evaluate every flake output without building',
        env: githubTokenEnv(),
        run: runDevenvTasksBefore('nix:flake:eval'),
      },
      {
        name: 'Check published package runtime imports',
        env: githubTokenEnv(),
        run: withCiSourceRoot(
          '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bun test scripts/runtime-package-imports.integration.test.ts',
        ),
      },
      {
        // Workspace-tools and Nix contract suites bound the product boundary pre-merge: the
        // publisher (source of the manifest), the importer (its only consumer), and the
        // retained Megarepo from-source recovery recipe (`buck2:nix-bridge:check`'s contract,
        // run directly because the publisher refuses `pull_request` events by design).
        name: 'Check product publisher, manifest import, and from-source contracts',
        env: githubTokenEnv(),
        run: withGcRaceRetry({
          label: 'product publisher, manifest import, and from-source contracts',
          command: withCiSourceRoot(
            [
              'set -euo pipefail',
              '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- env -u GITHUB_EVENT_NAME bash nix/workspace-tools/lib/tests/buck2-release-products.sh "$PWD"',
              '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bash nix/workspace-tools/lib/tests/javascript-product-import.sh "$PWD"',
              '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bash nix/buck2-products/from-source-contract.test.sh "$PWD"',
              '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bash nix/buck2-products/private-product-tarballs.test.sh "$PWD"',
            ].join('\n'),
          ),
        }),
      },
      ...cheapInertBuckSteps,
    ],
  },
  /** Queue and fallback main build of every published from-source product. */
  'build-products': {
    if: heavyCiIf,
    needs: ['tested-tree'],
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'always',
      priority: deliveryJobPriority,
    }),
    'timeout-minutes': 120,
    permissions: { contents: 'read' },
    defaults: bashShellDefaults,
    env: githubTokenEnv(),
    steps: [
      checkoutStep(),
      installNixStep({ binaryCaches: [binaryCache] }),
      {
        name: 'Build every published from-source product',
        env: githubTokenEnv(),
        run: withCiSourceRoot(
          [
            'set -euo pipefail',
            "mapfile -t product_names < <(jq -r '.products[].name' nix/buck2-products/cache-targets.json)",
            'product_refs=()',
            'for name in "${product_names[@]}"; do',
            `  safe_name="$(sed 's|^@||; s|/|-|g' <<<"$name")"`,
            '  product_refs+=(".#buck-product-$safe_name-from-source")',
            'done',
            'nix build --no-link --print-build-logs "${product_refs[@]}"',
          ].join('\n'),
        ),
      },
      compiledProductsSmokeStep,
    ],
  },
  'consumer-smoke': {
    if: trustedSecretCiIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'trusted',
      priority: deliveryJobPriority,
    }),
    'timeout-minutes': 10,
    permissions: { contents: 'read' },
    defaults: bashShellDefaults,
    outputs: { 'current-sha': '${{ steps.consumer-smoke.outputs.current-sha }}' },
    steps: [
      checkoutStep(),
      installNixStep({ binaryCaches: [binaryCache] }),
      linuxSandboxPrerequisitesStep({ privileged: 'trusted' }),
      prepareCiScriptsStep,
      preparePinnedDevenvStep,
      validateNixStoreStep,
      {
        id: 'consumer-smoke',
        name: 'Install an isolated consumer from the candidate checkout',
        env: githubTokenEnv(),
        run: [
          // Use runner base tools, Nix and the resolved runtime, not the broad root shell.
          'bash nix/fixtures/consumer-smoke/run.sh "$PWD" "${DEVENV_BIN:?DEVENV_BIN not set}"',
          'echo "current-sha=$GITHUB_SHA" >> "$GITHUB_OUTPUT"',
        ].join('\n'),
      },
    ],
  },
  'promote-published': {
    needs: ['publish-products', 'consumer-smoke'],
    if: publishedRefIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'never',
      priority: deliveryJobPriority,
    }),
    'timeout-minutes': 5,
    permissions: { contents: 'read' },
    defaults: bashShellDefaults,
    steps: [checkoutStep(), ...publishedRefSteps],
  },
  'publish-products': {
    if: trustedSecretCiIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'always',
      priority: deliveryJobPriority,
    }),
    'timeout-minutes': 120,
    permissions: { contents: 'read', 'pull-requests': 'read', statuses: 'write' },
    defaults: bashShellDefaults,
    env: githubTokenEnv(),
    outputs: {
      'current-sha':
        '${{ steps.publication-scope.outputs.current-sha || steps.product-publication.outputs.current-sha }}',
    },
    steps: [
      {
        name: 'Mark product manifest publication pending',
        run: [
          'gh api --method POST "repos/$GITHUB_REPOSITORY/statuses/$GITHUB_SHA" \\',
          '  -f context=buck2-products/manifest-current -f state=pending \\',
          '  -f description="Checking published product manifest" \\',
          '  -f target_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"',
        ].join('\n'),
      },
      checkoutStep(),
      {
        id: 'publication-scope',
        name: 'Check publication scope',
        run: [
          'set -euo pipefail',
          'publish=true',
          'if [ "${GITHUB_EVENT_NAME:-}" = push ]; then',
          '  git fetch --no-tags --deepen=1 origin main',
          '  publish=false',
          '  while IFS= read -r changed; do',
          '    if [ "$changed" != nix/buck2-products/manifest.json ]; then',
          '      publish=true',
          '      break',
          '    fi',
          '  done < <(git diff --name-only HEAD^ HEAD)',
          // Only skip the bot's own merged manifest proposal when it was built on
          // this merge's immediate main parent and its manifest bytes are unchanged.
          // Otherwise an intervening main change or manual edit must be republished.
          '  if [ "$publish" = false ]; then',
          '    publish=true',
          '    published_sha="$(gh api "repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/pulls" --jq \'[.[] | select(.merged_at != null and .head.ref == "automation/buck2-products-manifest" and .user.login == "overeng-nix-publisher[bot]")] | .[0].head.sha // empty\')"',
          '    if [ -n "$published_sha" ]; then',
          '      git fetch --no-tags --depth=2 origin "$published_sha"',
          '      if [ "$(git rev-parse "$published_sha^")" = "$(git rev-parse HEAD^)" ] && git diff --quiet "$published_sha" HEAD -- nix/buck2-products/manifest.json; then',
          '        publish=false',
          '      fi',
          '    fi',
          '  fi',
          'fi',
          'echo "publish=$publish" >> "$GITHUB_OUTPUT"',
          'if [ "$publish" = false ]; then',
          '  gh api --method POST "repos/$GITHUB_REPOSITORY/statuses/$GITHUB_SHA" \\',
          '    -f context=buck2-products/manifest-current -f state=success \\',
          '    -f description="Publisher manifest-only merge is current" \\',
          '    -f target_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"',
          '  echo "current-sha=$GITHUB_SHA" >> "$GITHUB_OUTPUT"',
          'fi',
        ].join('\n'),
      },
      {
        ...installNixStep(),
        id: 'product-nix',
        if: "steps.publication-scope.outputs.publish == 'true'",
      },
      {
        ...cachixCliBuildStep,
        id: 'product-cachix-cli',
        if: "steps.publication-scope.outputs.publish == 'true'",
      },
      {
        ...trustedCachixStep,
        id: 'product-cachix-read',
        if: "steps.publication-scope.outputs.publish == 'true'",
      },
      {
        name: 'Realise publish-products build inputs',
        if: `${publishingCachixStep.if} && (steps.publication-scope.outputs.publish == 'true')`,
        env: githubTokenEnv(),
        run: withCiSourceRoot('nix/buck2-products/publish.sh --realise-inputs'),
      },
      {
        ...publishingCachixStep,
        id: 'product-cachix-auth',
        if: `${publishingCachixStep.if} && steps.publication-scope.outputs.publish == 'true'`,
      },
      cachixPushStep({
        jobIf: trustedSecretCiIf,
        triggers: ['push', 'workflow_dispatch'],
        authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}',
        step: {
          id: 'product-publication',
          name: 'Publish products',
          if: "steps.publication-scope.outputs.publish == 'true'",
          env: githubTokenEnv(),
          run: withCiSourceRoot(
            [
              'set -euo pipefail',
              'proposal="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-products-manifest.json"',
              'if nix/buck2-products/publish.sh --proposal "$proposal"; then',
              '  :',
              'else',
              '  result=$?',
              '  echo "cause=publish.sh failed (exit $result): build, network, or Cachix error; inspect run" >> "$GITHUB_OUTPUT"',
              '  exit "$result"',
              'fi',
              'if cmp -s nix/buck2-products/manifest.json "$proposal"; then',
              '  echo "::notice::The v2 product manifest is already current"',
              '  echo "changed=false" >> "$GITHUB_OUTPUT"',
              '  gh api --method POST "repos/$GITHUB_REPOSITORY/statuses/$GITHUB_SHA" \\',
              '    -f context=buck2-products/manifest-current -f state=success \\',
              '    -f description="Published product manifest is current" \\',
              '    -f target_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"',
              '  echo "current-sha=$GITHUB_SHA" >> "$GITHUB_OUTPUT"',
              'else',
              '  comparison=$?',
              '  if [ "$comparison" -ne 1 ]; then',
              '    echo "::error::Manifest comparison failed (cmp exit $comparison)"',
              '    echo "cause=Manifest comparison I/O error (cmp exit $comparison)" >> "$GITHUB_OUTPUT"',
              '    exit "$comparison"',
              '  fi',
              '  echo "changed=true" >> "$GITHUB_OUTPUT"',
              '  stale=$(jq -nr --slurpfile old nix/buck2-products/manifest.json --slurpfile new "$proposal" \'[$old[0].products[], $new[0].products[]] | group_by(.name) | map(select(length != 2 or .[0] != .[1]) | .[0].name) | join(", ")\')',
              // GitHub commit-status descriptions are limited to 140 characters.
              '  description="Stale products: $stale"',
              '  gh api --method POST "repos/$GITHUB_REPOSITORY/statuses/$GITHUB_SHA" \\',
              '    -f context=buck2-products/manifest-current -f state=failure \\',
              '    -f description="${description:0:140}" \\',
              '    -f target_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"',
              '  echo "stale-status=true" >> "$GITHUB_OUTPUT"',
              'fi',
            ].join('\n'),
          ),
        },
      }),
      {
        id: 'publisher-app-config',
        name: 'Check publisher GitHub App configuration',
        if: "steps.product-publication.outputs.changed == 'true'",
        env: {
          APP_ID: '${{ vars.NIX_PUBLISHER_GITHUB_APP_ID }}',
          // Presence only: the key itself stays confined to the token-minting step.
          APP_PRIVATE_KEY_PRESENT: "${{ secrets.NIX_PUBLISHER_GITHUB_APP_PRIVATE_KEY != '' }}",
        },
        run: [
          'if [ -n "$APP_ID" ] && [ "$APP_PRIVATE_KEY_PRESENT" = true ]; then',
          '  echo "enabled=true" >> "$GITHUB_OUTPUT"',
          'else',
          '  echo "::notice::Product cache published; manifest PR waits for the publisher GitHub App variable and secret"',
          '  echo "enabled=false" >> "$GITHUB_OUTPUT"',
          'fi',
        ].join('\n'),
      },
      {
        ...githubAppInstallationTokenStep({
          id: 'publisher-app-token',
          name: 'Mint publisher GitHub App token',
          appId: '${{ vars.NIX_PUBLISHER_GITHUB_APP_ID }}',
          privateKey: '${{ secrets.NIX_PUBLISHER_GITHUB_APP_PRIVATE_KEY }}',
          owner: 'overengineeringstudio',
          repositories: ['effect-utils'],
        }),
        if: "steps.publisher-app-config.outputs.enabled == 'true'",
      },
      {
        name: 'Propose published product manifest',
        if: "steps.publisher-app-config.outputs.enabled == 'true'",
        env: githubAccessTokenEnv('${{ steps.publisher-app-token.outputs.token }}'),
        run: withCiSourceRoot(
          [
            'set -euo pipefail',
            'proposal="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-products-manifest.json"',
            'branch=automation/buck2-products-manifest',
            'git fetch origin "+refs/heads/$branch:refs/remotes/origin/$branch" || true',
            'git switch -C "$branch"',
            'cp "$proposal" nix/buck2-products/manifest.json',
            'git add nix/buck2-products/manifest.json',
            `git config user.name 'overeng-nix-publisher[bot]'`,
            `git config user.email '\${{ vars.NIX_PUBLISHER_GITHUB_APP_ID }}+overeng-nix-publisher[bot]@users.noreply.github.com'`,
            `git commit -m 'chore(buck2): update product cache manifest'`,
            'gh auth setup-git',
            'git push --force-with-lease origin "HEAD:refs/heads/$branch"',
            'if ! gh pr list --base main --head "$branch" --state open --json number --jq \'.[0].number // empty\' | grep -q .; then',
            '  gh pr create --base main --head "$branch" \\',
            `    --title 'chore(buck2): update product cache manifest' \\`,
            `    --body 'Updates the generated v2 manifest after the trusted main-branch cache publication job.'`,
            'fi',
          ].join('\n'),
        ),
      },
      {
        name: 'Keep interrupted publication pending',
        if: "failure() && steps.product-publication.outputs.stale-status != 'true' && steps.publication-scope.outputs.current-sha != github.sha && steps.product-publication.outputs.current-sha != github.sha",
        env: {
          PUBLICATION_CAUSE:
            "${{ steps.product-publication.outputs.cause || (steps.product-nix.outcome == 'failure' && 'Nix setup failed') || (steps.product-cachix-cli.outcome == 'failure' && 'Cachix CLI setup failed') || (steps.product-cachix-auth.outcome == 'failure' && 'Cachix authentication failed') || 'Publication network/API or scope error; inspect run' }}",
        },
        run: [
          // Infrastructure/publisher errors are not proof of stale product bytes.
          // Preserve pending even if setup failed before publish.sh could run.
          'gh api --method POST "repos/$GITHUB_REPOSITORY/statuses/$GITHUB_SHA" \\',
          '  -f context=buck2-products/manifest-current -f state=pending \\',
          '  -f description="${PUBLICATION_CAUSE:0:140}" \\',
          '  -f target_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"',
        ].join('\n'),
      },
    ],
  },
  /**
   * Trusted-only proof that a second plain checkout can consume an action
   * uploaded by an independent standalone root through the public cache tier.
   * Protected main is the tier's only writer (decision 0033).
   */
  'trusted-buck2-remote-cache-proof': {
    if: trustedSecretCiIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'always',
      priority: deliveryJobPriority,
    }),
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: { contents: 'read' },
    env: {
      BUCK2_NO_REMOTE_CACHE: '0',
    },
    steps: [
      checkoutStep(),
      installNixStep(),
      cachixCliBuildStep,
      trustedCachixStep,
      prepareCiScriptsStep,
      preparePinnedDevenvStep,
      validateNixStoreStep,
      {
        [publisherWriteSecret]: buck2PublicCacheWriteSecret,
        name: 'Prove fresh-root remote action and test-cache hits',
        env: {
          ...githubTokenEnv(),
          BUCK2_PUBLIC_CACHE_WRITE_AUTH: '${{ secrets.BUCK2_PUBLIC_CACHE_WRITE_AUTH }}',
        },
        run: [
          'set -euo pipefail',
          'if [ -z "${BUCK2_PUBLIC_CACHE_WRITE_AUTH:-}" ]; then',
          '  echo "::error::BUCK2_PUBLIC_CACHE_WRITE_AUTH is required for the trusted remote-cache proof"',
          '  exit 1',
          'fi',
          '# Buck sends the header verbatim; only the Base64 form reaches the daemon.',
          'BUCK2_CACHE_WRITE_BASIC_AUTH="$(printf \'%s\' "$BUCK2_PUBLIC_CACHE_WRITE_AUTH" | base64 | tr -d \'\\n\')"',
          'echo "::add-mask::$BUCK2_CACHE_WRITE_BASIC_AUTH"',
          'export BUCK2_CACHE_WRITE_BASIC_AUTH',
          'unset BUCK2_PUBLIC_CACHE_WRITE_AUTH',
          '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bash scripts/buck2-remote-cache-proof.sh',
        ].join('\n'),
      },
    ],
  },
  // bootstrap:cold-proof (R32) — the empirical authority for the bootstrap-safe import-closure
  // contract (issue #884). In a fresh, no-node_modules tree of the committed source it runs the
  // `.#genie` CLI (after the cutover a wrapper around the immutable Buck product manifest rather
  // than a source build, so this lane no longer warms a source FOD) with `--phase bootstrap`,
  // then `pnpm install --frozen-lockfile` against the registry, asserting both
  // succeed. This exercises the exact pre-install path; `bootstrap-closure:check` (in `check:all`) is
  // the static fast-feedback pre-check. Separate lane because it is heavier than the product checks.
  'bootstrap-cold-proof': job({
    privileged: 'trusted',
    priority: backgroundJobPriority,
    laneIf: empiricalProofLaneIf,
    step: {
      name: 'Bootstrap cold-proof (R32)',
      env: githubTokenEnv(),
      run: runDevenvTasksBefore('bootstrap:cold-proof'),
    },
  }),
  'devenv-perf': {
    if: devenvPerfLaneIf,
    ...devenvPerfJob({
      runsOn: namespaceRunner({
        profile: LEGACY_NAMESPACE_LINUX_X64_PAIRED_PERF_RUNNER,
        runId: '${{ github.run_id }}',
        privileged: 'always',
        priority: backgroundJobPriority,
      }),
      artifactName: 'devenv-perf',
      artifactDir: devenvPerfMeasurementsDir,
      baselineSeedRuns: [
        [
          ['25959801150', '655', 'df0420cd0397ffc6928d3c6ccc9c23052d6bc255'],
          ['25959802067', '657', '62833cba5d83b1c13462728edeafa684e61c006f'],
          ['25959802958', '656', '21029998522a0e9435df151259611650fb948a20'],
          ['25959803805', '651', '95515f971b27ef279e39c982f52e46cf9e8270e9'],
          ['25959804678', '654', '58e96b9a2b87b3703de6920b6d9571f3805d0171'],
          ['25959805512', '653', 'd1cca16339f19d7e1a27b001edc4c2c7ecd13dc4'],
          ['25959806473', '652', 'acd6c63f5e235e7e5f2710fc62b2231e0ba904a6'],
          ['25959807303', '648', 'a5a07703ff951fb7396a40844e9491d88ed40edf'],
          ['25959808097', '649', '360ff47c59a206064711dfcb6c610afd0e6b0d53'],
          ['25959808775', '647', '8d1810b2c359ae95f245e56329018aab5020f8c0'],
          ['25959809449', '646', '89e1396766ccd2a813680acd440cb78f540ca6c1'],
          ['25959810069', '643', '239715520370436901a3f2218d162dc7b12f4b4c'],
          ['25959810666', '641', '6b3751b4684ba45f496f1a1bff8b86ef6ba8275b'],
          ['25959811321', '640', 'fed50ae2502ac0a65395bbef5af43fcf384d5d04'],
          ['25959811864', '639', '0e03df2c6f20e4d154f286fd69a4e2980d21a12d'],
          ['25959812634', '636', '7efdbee4b571f2c80f5b6173bc9a84b51fbef5eb'],
          ['25959813189', '638', '350d1b98baa943dcae63412eeffded7b5160bc8a'],
          ['25959813761', '637', 'f25336193b9f6b042eb027eca27acc4cc75a69d6'],
          ['25959814335', '634', '4ba441d4ad8b6c49e9ee03d9cdfd2f04a129b714'],
          ['25959814835', '632', '1ad5fd735c7f45ad5e07c8033e5b68a642ada69c'],
        ].map(([runId, pr, sha]) => ({
          runId,
          label: `PR #${pr}`,
          sha,
          source: 'manual-backfill',
          artifacts: ['devenv-perf'],
          notes:
            'Backfilled with the current measurement workflow for the effect-utils #658 rollout.',
        })),
      ],
      baselineMaxRuns: 20,
      // Wall-clock measurements are advisory until they have paired same-run
      // base/head evidence. Deterministic measurements such as closure sizes
      // can still use budget-style gates in consuming repos.
      regressionMode: 'warn',
      env: {
        ...ciMeasurementSubjectEnv,
      },
      setupSteps: baseSteps,
      taskProbes: [
        {
          task: 'buck2:editor:publish:generators',
          label: 'Editor dependency publication',
          group: 'workspace setup',
          description: 'Publishes the source-generator editor dependency views.',
          warmupRepetitions: 1,
          repetitions: 5,
        },
        {
          task: 'genie:run',
          label: 'Genie run task',
          group: 'genie',
          description: 'Runs the normal devenv genie:run task including its declared dependencies.',
          warmupRepetitions: 1,
          repetitions: 5,
        },
        {
          task: 'check:quick',
          id: 'task_check_quick_warm',
          label: 'Warm cached check:quick',
          group: 'quality gates',
          path: ['quality gates', 'check:quick'],
          description:
            'Runs the fast local quality gate through devenv after a warmup. This measures the cached no-op path and task/status orchestration overhead.',
          dimensions: {
            workload: 'cached-no-op',
            taskCacheMode: 'warm',
          },
          warmupRepetitions: 1,
          repetitions: 5,
        },
        {
          task: 'check:quick',
          id: 'task_check_quick_forced',
          label: 'Forced check:quick',
          group: 'quality gates',
          path: ['quality gates', 'check:quick'],
          description:
            'Runs the fast local quality gate through devenv with task-cache refresh. This measures the developer-facing quick-check workload rather than the cached no-op path.',
          dimensions: {
            workload: 'forced-task-cache',
            taskCacheMode: 'refresh',
          },
          extraArgs: ['--refresh-task-cache'],
          warmupRepetitions: 0,
          repetitions: 3,
        },
      ],
      probes: [
        {
          id: 'genie_check_task',
          label: 'Genie check task',
          group: 'genie',
          description: 'Runs the supported Genie check task without shell-entry overhead.',
          warmupRepetitions: 1,
          repetitions: 5,
          command: ['$DEVENV_BIN', 'tasks', 'run', 'genie:check'],
        },
      ],
      permissions: { actions: 'read', contents: 'read' },
      compare: false,
      prComment: {
        enabled: false,
        title: 'Devenv Performance',
        maxRows: 8,
        maxHistory: 20,
      },
    }),
    'timeout-minutes': 90,
  },
  /**
   * Review-thread resolution gate. Checkout-free: only calls `gh api`, so it runs on
   * GitHub-hosted capacity instead of scarce Nix runners. The native ruleset flag is
   * the live merge gate; this job is the early visible PR signal (thread resolution
   * does not retrigger workflows, so re-run after resolving threads to refresh).
   */
  [prReviewsResolvedJobId]: prReviewsResolvedJob({ runsOn: 'ubuntu-latest' }),
  'nix-closure-sizes': {
    if: empiricalProofLaneIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'trusted',
      priority: backgroundJobPriority,
    }),
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: { actions: 'read', contents: 'read' },
    env: ciMeasurementSubjectEnv,
    steps: [
      ...baseSteps,
      ...nixClosureMeasurementSteps({
        artifactName: 'nix-closure-measurements',
        artifactDir: nixClosureMeasurementsDir,
        baselineMaxRuns: 20,
        targets: nixClosureMeasurementTargets,
        buckets: defaultNixClosureMeasurementBuckets,
        compare: false,
        regressionMode: 'warn',
        prComment: {
          enabled: false,
          title: 'Nix Closure Measurements',
          maxRows: 8,
          maxHistory: 20,
        },
      }),
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
  // Checkout/native-proof exemption: measures checkout bytes only, with no devenv/Buck execution.
  'source-shape': {
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'trusted',
      priority: deliveryJobPriority,
    }),
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: { actions: 'read', contents: 'read' },
    env: ciMeasurementSubjectEnv,
    steps: [
      checkoutStep(),
      installNixStep(),
      linuxSandboxPrerequisitesStep({ privileged: 'trusted' }),
      ciMeasurementBaselineCheckoutStep,
      ...sourceShapeMeasurementSteps({
        artifactDir: `${sourceShapeMeasurementsDir}/current/effect-utils`,
        targetId: 'effect_utils',
        targetName: 'effect-utils',
        targetLabel: 'effect-utils repository',
        targetGroup: 'source',
        targetPath: ['source', 'effect-utils'],
        scopes: [
          {
            id: 'genie_ci_workflow',
            label: 'Genie CI workflow helpers',
            group: 'source / ci',
            path: ['source', 'effect-utils', 'genie', 'ci-workflow'],
            includePaths: [
              'genie/ci-workflow',
              '.github/workflows/ci.yml.genie.ts',
              '.github/workflows/empirical-proofs.yml.genie.ts',
            ],
            includeExtensions: ['.ts'],
          },
          {
            id: 'genie_runtime',
            label: 'Genie runtime',
            group: 'source / genie',
            path: ['source', 'effect-utils', 'packages', 'genie'],
            includePaths: ['packages/@overeng/genie/src'],
            includeExtensions: ['.ts', '.tsx'],
          },
          {
            id: 'nix_workspace_tools',
            label: 'Nix workspace tools',
            group: 'source / nix',
            path: ['source', 'effect-utils', 'nix', 'workspace-tools'],
            includePaths: ['nix/workspace-tools'],
            includeExtensions: ['.nix'],
          },
        ],
      }),
      ciMeasurementsArtifactStep({
        artifactName: 'source-shape',
        path: sourceShapeMeasurementsDir,
      }),
    ],
  },
  // Checkout exemption: report aggregation uses only Nix-provided tools and downloaded artifacts.
  'ci-measurements-report': {
    name: 'ci/measurements-report',
    if: measurementReportIf,
    needs: ['devenv-perf', 'nix-closure-sizes', 'main-source-shape'],
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'always',
      priority: backgroundJobPriority,
    }),
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: { actions: 'read', contents: 'read' },
    env: ciMeasurementSubjectEnv,
    steps: [
      checkoutStep(),
      installNixStep(),
      ciMeasurementReportToolStep,
      downloadCurrentMeasurementArtifactStep({
        artifactName: 'devenv-perf',
        outputDir: `${ciMeasurementReportDir}/current/devenv-perf`,
        producedBy: 'devenv-perf',
      }),
      downloadCurrentMeasurementArtifactStep({
        artifactName: 'nix-closure-measurements',
        outputDir: `${ciMeasurementReportDir}/current/nix-closure-measurements`,
      }),
      downloadCurrentMeasurementArtifactStep({
        artifactName: 'source-shape',
        outputDir: `${ciMeasurementReportDir}/current/source-shape`,
        producedBy: 'main-source-shape',
      }),
      downloadPreviousGitHubArtifactStep({
        artifactName: 'devenv-perf',
        outputDir: `${ciMeasurementReportDir}/baseline/devenv-perf`,
        // The paired lane's trend series now comes from explicit dispatches, so a
        // schedule scan would only consume candidates that cannot carry the artifact.
        candidateEvents: ['workflow_dispatch'],
        maxRuns: 20,
      }),
      downloadPreviousGitHubArtifactStep({
        artifactName: 'nix-closure-measurements',
        outputDir: `${ciMeasurementReportDir}/baseline/nix-closure-measurements`,
        maxRuns: 20,
      }),
      downloadPreviousGitHubArtifactStep({
        artifactName: 'source-shape',
        outputDir: `${ciMeasurementReportDir}/baseline/source-shape`,
        seedRuns: [
          {
            runId: '26085158592',
            label: 'main baseline',
            sha: 'ce7cf8f8ebfaa1da6c7e9122cd195a5f95ce2fca',
            source: 'manual-backfill',
            artifacts: ['source-shape'],
            notes:
              'Backfilled with the current measurement workflow for the effect-utils #658 rollout.',
          },
        ],
        maxRuns: 20,
      }),
      compareCiMeasurementsStep({
        currentDir: `${ciMeasurementReportDir}/current`,
        baselineDir: `${ciMeasurementReportDir}/baseline`,
        outputFile: `${ciMeasurementReportDir}/measurement-comparison.json`,
        regressionMode: 'warn',
        prComment: {
          enabled: true,
          title: 'CI Measurements',
          maxRows: 16,
          maxHistory: 20,
        },
      }),
      ciMeasurementsArtifactStep({
        artifactName: 'ci-measurements-report',
        path: ciMeasurementReportDir,
      }),
    ],
  },
  /** Integration tests for Notion API (requires package-specific Notion token secrets) */
  'test-integration-notion': {
    if: notionIntegrationCiIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'always',
      priority: deliveryJobPriority,
    }),
    'timeout-minutes': 90,
    defaults: bashShellDefaults,
    steps: [
      ...baseSteps,
      {
        name: 'Notion integration tests',
        env: {
          ...githubTokenEnv(),
          NOTION_API_TOKEN: '${{ secrets.NOTION_API_TOKEN }}',
          NOTION_TEST_PARENT_PAGE_ID: '${{ secrets.NOTION_TEST_PARENT_PAGE_ID }}',
          NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID:
            '${{ secrets.NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID || secrets.NOTION_TEST_PARENT_PAGE_ID }}',
          NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID:
            '${{ secrets.NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID }}',
          NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID:
            "${{ github.event_name == 'workflow_dispatch' && (inputs.run_datasource_sync_demo == true || inputs.run_datasource_sync_demo == 'true') && secrets.NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID || '' }}",
        },
        run: runDevenvTasksBefore('test:notion-integration'),
      },
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
  /**
   * Integration tests for restate-effect against a native restate-server.
   * The server is provisioned via nix/restate.nix and resolved through
   * RESTATE_SERVER_BIN inside the devenv shell — no secrets required. Runs as a
   * dedicated, serialized lane (its own job) because the suite boots a real
   * server child process; the package's ts/lint/unit are already covered by the
   * aggregate jobs above.
   */
  'test-integration-restate': {
    if: heavyCiIf,
    needs: ['tested-tree'],
    concurrency: {
      group:
        'test-integration-restate-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    },
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'always',
      priority: deliveryJobPriority,
    }),
    'timeout-minutes': 60,
    defaults: bashShellDefaults,
    steps: [
      ...baseSteps,
      buck2TrustedCacheWriterStep({
        name: 'Restate integration tests',
        env: githubTokenEnv(),
        run: runDevenvTasksBefore('test:restate-integration'),
      }),
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
  'test-live-deploy-ci-tools': {
    if: trustedSecretCiIf,
    concurrency: {
      group:
        'test-live-deploy-ci-tools-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    },
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'always',
      priority: deliveryJobPriority,
    }),
    'timeout-minutes': 30,
    defaults: bashShellDefaults,
    steps: [
      ...baseSteps,
      liveNetlifyCiToolsPreflightStep,
      liveVercelCiToolsPreflightStep,
      onlyWhenLiveNetlifyCiTools(liveNetlifyCiToolsE2EStep),
      onlyWhenLiveVercelCiTools(liveVercelCiToolsE2EStep),
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
}

const deployJobs: Record<string, any> = {
  'deploy-storybooks': {
    if: trustedSecretCiIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'always',
      priority: deliveryJobPriority,
    }),
    'timeout-minutes': jobTimeoutMinutes,
    // No `needs` — run in parallel with other jobs for faster feedback
    permissions: { contents: 'read' },
    defaults: bashShellDefaults,
    steps: [
      ...baseSteps,
      netlifyDeployStep({
        NETLIFY_AUTH_TOKEN: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
      }),
      workflowReportCollectorStep({
        workflowReportFlakeRef,
        bundleId: 'storybook-preview',
        inputPaths: [`\${{ steps.deploy.outputs.${deployPreviewWorkflowReportPathOutputName} }}`],
        outputPath: storybookPreviewBundlePath,
        allowMissingInput: true,
      }),
      workflowReportCommentBodyStep({
        workflowReportFlakeRef,
        bundlePath: storybookPreviewBundlePath,
        commentBodyPath: storybookPreviewCommentBodyPath,
        summaryPath: storybookPreviewSummaryPath,
        title: 'Storybook Previews',
        noRecordsMessage: 'No storybooks were deployed.',
        stateId: 'storybook-preview',
        entryId:
          "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
        entryLabel:
          "${{ github.event_name == 'pull_request' && format('PR {0}', github.event.pull_request.number) || 'prod' }}",
      }),
      workflowReportPublisherStep({
        workflowReportFlakeRef,
        commentBodyPath: storybookPreviewCommentBodyPath,
        summaryPath: storybookPreviewSummaryPath,
        stateId: 'storybook-preview',
      }),
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
} as const

const withCiOtelCapture = (jobMap: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(jobMap).map(([name, ciJob]) => {
      const steps = ciJob.steps as readonly any[] | undefined
      return [
        name,
        steps === undefined
          ? ciJob
          : {
              ...ciJob,
              steps: [
                prepareCiOtelSpoolStep,
                ...steps,
                ciOtelSpansSummaryStep,
                ciOtelSpansArtifactStep,
              ],
            },
      ]
    }),
  )

const pipelineTracesJob = {
  needs: ['pipeline-attempt-close'],
  if: "${{ always() && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && vars.CI_EVIDENCE_MODE == 'upload' }}",
  // ci-tools may build from source (nested TS Bubblewrap), so this needs the privileged runner.
  'runs-on': namespaceRunner({
    profile: 'namespace-profile-linux-x86-64',
    runId: '${{ github.run_id }}',
    privileged: 'trusted',
    priority: backgroundJobPriority,
  }),
  permissions: { contents: 'read', actions: 'read', 'pull-requests': 'write', 'id-token': 'write' },
  'continue-on-error': true,
  steps: [
    {
      ...pinnedAction({ name: 'checkout' }),
    },
    // Read-only substituter: the protected publisher pushes `ci-tools-compiled`, so the report
    // substitutes it instead of building ~1300 derivations after every PR run.
    installNixStep({ binaryCaches: [binaryCache] }),
    {
      name: 'Publish Pipeline traces',
      shell: 'bash',
      env: {
        GH_TOKEN: '${{ github.token }}',
        GH_REPO: '${{ github.repository }}',
        PR_NUMBER: '${{ github.event.pull_request.number }}',
        GRAFANA_BASE_URL: '${{ vars.GRAFANA_BASE_URL }}',
        PIPELINE_TRACES_PUBLIC_ASSET_COMMAND: '${{ vars.PIPELINE_TRACES_PUBLIC_ASSET_COMMAND }}',
      },
      run: 'bash genie/ci-scripts/pipeline-traces-report.sh',
    },
  ],
} as const
const allCiJobs: Record<string, any> = {
  // Source-policy is independent of product gates and has no devenv dependency.
  'default-ref-policy': {
    ...defaultRefPolicyCheckJob({
      runsOn: namespaceRunner({
        profile: 'namespace-profile-linux-x86-64',
        runId: '${{ github.run_id }}',
        privileged: 'trusted',
        priority: deliveryJobPriority,
      }),
      defaultRefs: { 'livestorejs/livestore': 'dev' },
      preSteps: [linuxSandboxPrerequisitesStep({ privileged: 'trusted' })],
    }),
  },
  'pr-buck2-tools': {
    name: 'pr/buck2-tools',
    ...job({
      privileged: 'trusted',
      priority: deliveryJobPriority,
      laneIf: "${{ github.event_name == 'pull_request' }}",
      step: sourceRegressionStep({
        name: 'Buck2 tools regression tests',
        packages: ['.', 'packages/@overeng/buck2-tools', 'packages/@overeng/genie'],
        tasks: [
          'test:buck2-tools',
          'devenv-modules:test',
          'buck2:capabilities:identity-proof',
          'buck2:capabilities:recovery-test',
        ],
      }),
    }),
  },
  ...withCiOtelCapture(jobs),
  ...extraJobs,
  ...deployJobs,
  'notify-alignment': {
    ...notifyAlignmentJob({
      targetRepo: 'schickling/megarepo-all',
      needs: ['tested-tree', 'quality', ...Object.keys(deployJobs)],
      runner: namespaceRunner({
        profile: 'namespace-profile-linux-x86-64',
        runId: '${{ github.run_id }}',
        privileged: 'never',
        priority: backgroundJobPriority,
      }),
    }),
    // Optional lookup failures permit authoritative quality fallback; publication must succeed.
    if: `\${{ !cancelled() && github.ref == 'refs/heads/main' && github.event_name == 'push' && (needs.quality.result == 'success' || needs.tested-tree.outputs.tested == 'true') && ${Object.keys(
      deployJobs,
    )
      .map((id) => `needs['${id}'].result == 'success'`)
      .join(' && ')} }}`,
  },
}
const declaredJobIds = new Set([
  ...Object.keys(allCiJobs),
  'pipeline-attempt-close',
  'main-source-shape',
  'pipeline-traces',
  'tested-tree',
])
for (const ciJobId of declaredJobIds) {
  if (pipelineJobIdentifierSet.has(ciJobId) === false)
    throw new Error(`CI job ${ciJobId} has no Jobs API name mapping`)
}
for (const ciJobId of pipelineJobIdentifierSet) {
  if (declaredJobIds.has(ciJobId) === false)
    throw new Error(`Jobs API name mapping contains undeclared CI job ${ciJobId}`)
}

// oxlint-disable-next-line overeng/exports-first -- workflow atoms are assembled after their dependencies
export const empiricalProofJobs: CiWorkflowArgs['jobs'] = {
  'test-megarepo-cold-gc': allCiJobs['test-megarepo-cold-gc'],
  'bootstrap-cold-proof': allCiJobs['bootstrap-cold-proof'],
  'devenv-perf': allCiJobs['devenv-perf'],
  'nix-closure-sizes': allCiJobs['nix-closure-sizes'],
  'main-source-shape': {
    ...allCiJobs['source-shape'],
    name: 'main/source-shape',
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
      privileged: 'always',
      priority: backgroundJobPriority,
    }),
    if: "${{ github.event_name == 'workflow_dispatch' || (github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'schedule')) }}",
  },
  'ci-measurements-report': allCiJobs['ci-measurements-report'],
}

const productCiJobs: CiWorkflowArgs['jobs'] = {
  ...Object.fromEntries(
    Object.entries(allCiJobs).filter(([jobId]) => !(jobId in empiricalProofJobs)),
  ),
  'source-shape': {
    ...allCiJobs['source-shape'],
    needs: ['default-ref-policy'],
    if: "${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}",
  },
}

// Consumer bootstrap must not inherit source-editor setup, and promotion needs no Nix.
const {
  'consumer-smoke': consumerSmokeJob,
  'promote-published': promotePublishedJob,
  ...instrumentedProductCiJobs
} = productCiJobs

// oxlint-disable-next-line overeng/exports-first -- generated entrypoint is assembled after its job atoms
export default ciWorkflow({
  policy: effectUtilsWorkflowPolicy('ci.yml'),
  trustTier: 'public',
  name: 'CI',
  on: {
    push: { branches: ['main'] },
    pull_request: { types: ['opened', 'reopened', 'synchronize'] },
    merge_group: { types: ['checks_requested'] },
    workflow_dispatch: {
      inputs: {
        ...ciMeasurementBaselineWorkflowDispatchInputs,
        run_notion_integration_on_branch: {
          description: 'Opt into credentialed Notion integration tests on this branch.',
          required: false,
          default: false,
          type: 'boolean',
        },
        run_datasource_sync_demo: {
          description:
            'Run the credentialed notion-datasource-sync demo showcase in the Notion integration lane. Requires NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID.',
          required: false,
          default: false,
          type: 'boolean',
        },
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
  permissions: { contents: 'read', 'id-token': 'write' },
  jobs: withBuck2CachePostures({
    jobs: {
      ...withNixRealisationTimeouts(
        {
          // API-only control job: no Nix bootstrap, cache evidence, or telemetry adapters.
          'tested-tree': {
            'runs-on': 'ubuntu-latest',
            'timeout-minutes': 3,
            permissions: { contents: 'read', actions: 'read' },
            outputs: { tested: '${{ steps.lookup.outputs.tested }}' },
            steps: [
              {
                ...checkoutStep(),
                if: "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
                with: { 'persist-credentials': false },
              },
              {
                ...pinnedAction({ name: 'setupNode' }),
                if: "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
                with: { 'node-version': '24' },
              },
              {
                id: 'lookup',
                name: 'Find successful queue evidence for pushed tree',
                if: "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
                'continue-on-error': true,
                env: { GH_TOKEN: '${{ github.token }}' },
                run: 'node genie/ci-scripts/tested-tree.ts',
              },
            ],
          },
          ...withPipelineTelemetry(withBuck2CacheEvidence(instrumentedProductCiJobs)),
          'promote-published': promotePublishedJob!,
          // API/OTel adapters and Nix's nested ci-tools build execute no checkout-native Buck.
          // Shared proof policy declares their `none` postures and disabled membership.
          'pipeline-attempt-close': pipelineCloseJob({
            jobs: productCiJobs,
            runsOn: 'ubuntu-latest',
          }),
          'pipeline-traces': pipelineTracesJob,
        },
        nixRealisationTimingsSeconds,
      ),
      // Isolated pnpm consumer: no checkout-native Buck or root-shell cache evidence.
      'consumer-smoke': consumerSmokeJob!,
    },
    // Protected queue heads and fallback main pushes warm the cache opportunistically.
    // PR jobs never receive writer credentials; the dedicated main proof remains strict.
    postures: coreCachePostures,
  }),
} satisfies CiWorkflowArgs)
