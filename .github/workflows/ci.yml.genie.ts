import {
  RUNNER_PROFILES,
  type RunnerProfile,
  bashShellDefaults,
  cachixCliBuildStep,
  cachixStep,
  checkoutStep,
  notifyAlignmentJob,
  evictCachedPnpmDepsStep,
  pnpmBuilderContractStep,
  preparePinnedDevenvStep,
  installNixStep,
  runDevenvTasksBefore,
  restorePnpmStateStep,
  savePnpmStateStep,
  standardCIEnv,
  ciWorkflow,
  ciMeasurementBaselineCheckoutStep,
  ciMeasurementBaselineWorkflowDispatchInputs,
  ciMeasurementNotBaselineBackfillPredicate,
  ciMeasurementSubjectEnv,
  ciMeasurementsCommentPermissions,
  ciMeasurementsArtifactStep,
  compareCiMeasurementsStep,
  defaultNixClosureMeasurementBuckets,
  devenvPerfJob,
  downloadPreviousGitHubArtifactStep,
  namespaceRunner,
  nixClosureMeasurementSteps,
  sourceShapeMeasurementStep,
  validateColdPnpmDepsStep,
  nixDiagnosticsArtifactStep,
  netlifyDeployStep,
  netlifyStorybookCommentStep,
  pnpmStateSetupStep,
  validateNixStoreStep,
} from '../../genie/ci-workflow.ts'
import { type CIJobName } from '../../genie/ci.ts'
import { type GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'

const baseSteps = [
  checkoutStep(),
  ciMeasurementBaselineCheckoutStep,
  installNixStep(),
  cachixCliBuildStep,
  cachixStep({ name: 'overeng-effect-utils', authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}' }),
  preparePinnedDevenvStep,
  pnpmStateSetupStep,
  restorePnpmStateStep(),
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
 * Verify the lock-pinned devenv rev emits OTEL shell-entry messages under a real PTY.
 * `--no-reload` keeps the probe on the post-init shell-output path we care about
 * without exercising the separate interactive reload loop, which currently
 * panics on the pinned upstream commit.
 */
const verifyOtelShellEntryStep = {
  name: 'Verify OTEL shell entry',
  shell: 'bash' as const,
  run: [
    runDevenvTasksBefore('otel:test'),
    'command -v script >/dev/null 2>&1',
    'tmp_log="$(mktemp)"',
    `printf 'printf "OTEL_MODE=%%s\\n" "$OTEL_MODE"\nprintf "OTEL_GRAFANA_LINK_URL=%%s\\n" "$OTEL_GRAFANA_LINK_URL"\nexit\n' | script -qefc '"${'${DEVENV_BIN:?DEVENV_BIN not set}'}" shell --no-reload' "$tmp_log"`,
    'grep -q \'\\[otel\\] Using .* OTEL stack\' "$tmp_log"',
    'grep -q \'\\[otel\\] Start with: devenv up\' "$tmp_log"',
    'grep -q \'^OTEL_MODE=\' "$tmp_log"',
    'grep -q \'^OTEL_GRAFANA_LINK_URL=http\' "$tmp_log"',
    'rm -f "$tmp_log"',
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

const jobTimeoutMinutes = 30
const normalCiIf = `\${{ ${ciMeasurementNotBaselineBackfillPredicate} }}`

const job = (step: { name: string; run: string }, extraSteps: readonly any[] = []) => ({
  if: normalCiIf,
  'runs-on': namespaceRunner({
    profile: 'namespace-profile-linux-x86-64',
    runId: '${{ github.run_id }}',
  }),
  'timeout-minutes': jobTimeoutMinutes,
  defaults: bashShellDefaults,
  env: standardCIEnv,
  steps: [
    ...baseSteps,
    ...extraSteps,
    step,
    savePnpmStateStep(),
    nixDiagnosticsSummaryStep,
    nixDiagnosticsArtifactStep(),
    failureReminderStep,
  ],
})

const multiPlatformJob = (step: { name: string; run: string }) => ({
  if: normalCiIf,
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
  'timeout-minutes': jobTimeoutMinutes,
  defaults: bashShellDefaults,
  env: standardCIEnv,
  steps: [
    ...baseSteps,
    step,
    savePnpmStateStep(),
    nixDiagnosticsSummaryStep,
    nixDiagnosticsArtifactStep(),
    failureReminderStep,
  ],
})

const strictNixJobBaseSteps = [
  checkoutStep(),
  ciMeasurementBaselineCheckoutStep,
  installNixStep(),
  cachixCliBuildStep,
  cachixStep({ name: 'overeng-effect-utils', authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}' }),
  validateNixStoreStep,
] as const

const multiPlatformStrictNixJob = (step: ReturnType<typeof validateColdPnpmDepsStep>) => ({
  if: normalCiIf,
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
  'timeout-minutes': jobTimeoutMinutes,
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
  typecheck: job(
    {
      name: 'Type check',
      run: runDevenvTasksBefore('ts:check:strict'),
    },
    [verifyOtelShellEntryStep],
  ),
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
      'bash genie/ci-scripts/ci-measurement-comparison.test.sh',
      'bash nix/workspace-tools/lib/mk-pnpm-cli/tests/run.sh --skip-genie --skip-megarepo --skip-devenv-shell --skip-downstream-megarepo',
    ].join('\n'),
  }),
}

const NETLIFY_SITE = 'overeng-utils'
const sourceShapeMeasurementsDir = 'tmp/source-shape-ci'
const nixClosureMeasurementsDir = 'tmp/nix-closure-ci'
const ciMeasurementReportDir = 'tmp/ci-measurement-report'

const downloadCurrentMeasurementArtifactStep = (artifactName: string, outputDir: string) =>
  ({
    name: `Download current measurement artifact: ${artifactName}`,
    uses: 'actions/download-artifact@v4',
    with: {
      name: artifactName,
      path: outputDir,
    },
  }) as const

const ciMeasurementReportToolStep = {
  name: 'Provide CI measurement report tools',
  shell: 'bash',
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
    description: 'the packaged Genie CLI closure',
    system: 'x86_64-linux',
  },
  {
    installable: '.#megarepo',
    id: 'megarepo_package',
    name: 'megarepo',
    label: 'Megarepo package',
    group: 'packages',
    path: ['nix', 'closures', 'packages', 'megarepo'],
    description: 'the packaged megarepo CLI closure',
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

// Non-required jobs (separate from CIJobName — not required status checks)
const extraJobs: Record<string, any> = {
  'devenv-perf': {
    ...devenvPerfJob({
      runsOn: namespaceRunner({
        profile: 'namespace-profile-linux-x86-64',
        runId: '${{ github.run_id }}',
      }),
      artifactName: 'devenv-perf',
      baselineSeedRuns: [
        ...[
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
      env: ciMeasurementSubjectEnv,
      setupSteps: baseSteps,
      taskProbes: [
        {
          task: 'pnpm:install',
          label: 'pnpm install task',
          group: 'workspace setup',
          description: 'Runs the cached pnpm install devenv task.',
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
          id: 'genie_check_direct',
          label: 'Genie check direct',
          group: 'genie',
          description:
            'Runs Genie directly in check mode to isolate generator runtime from devenv task dependency overhead.',
          warmupRepetitions: 1,
          repetitions: 5,
          command: [
            '$DEVENV_BIN',
            'shell',
            '--no-reload',
            '--',
            'bun',
            'packages/@overeng/genie/bin/genie.tsx',
            '--output',
            'ci-plain',
            '--check',
          ],
        },
      ],
      permissions: ciMeasurementsCommentPermissions,
      prComment: {
        enabled: false,
        title: 'Devenv Performance',
        maxRows: 8,
        maxHistory: 20,
      },
    }),
    'timeout-minutes': jobTimeoutMinutes,
  },
  'nix-closure-sizes': {
    if: normalCiIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: ciMeasurementsCommentPermissions,
    env: ciMeasurementSubjectEnv,
    steps: [
      ...baseSteps,
      ...nixClosureMeasurementSteps({
        artifactName: 'nix-closure-measurements',
        artifactDir: nixClosureMeasurementsDir,
        baselineMaxRuns: 20,
        targets: nixClosureMeasurementTargets,
        buckets: defaultNixClosureMeasurementBuckets,
        regressionMode: 'warn',
        prComment: {
          enabled: false,
          title: 'Nix Closure Measurements',
          maxRows: 8,
          maxHistory: 20,
        },
      }),
      savePnpmStateStep(),
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
  'source-shape': {
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: ciMeasurementsCommentPermissions,
    env: ciMeasurementSubjectEnv,
    steps: [
      checkoutStep(),
      ciMeasurementBaselineCheckoutStep,
      {
        ...downloadPreviousGitHubArtifactStep({
          artifactName: 'source-shape',
          outputDir: `${sourceShapeMeasurementsDir}/baseline`,
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
        if: normalCiIf,
      },
      sourceShapeMeasurementStep({
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
            includePaths: ['genie/ci-workflow', '.github/workflows/ci.yml.genie.ts'],
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
      {
        ...compareCiMeasurementsStep({
          currentDir: `${sourceShapeMeasurementsDir}/current`,
          baselineDir: `${sourceShapeMeasurementsDir}/baseline`,
          outputFile: `${sourceShapeMeasurementsDir}/measurement-comparison.json`,
          regressionMode: 'warn',
          prComment: {
            enabled: false,
            title: 'Source Shape Measurements',
            maxRows: 12,
            maxHistory: 20,
          },
        }),
        if: normalCiIf,
      },
      ciMeasurementsArtifactStep({
        artifactName: 'source-shape',
        path: sourceShapeMeasurementsDir,
      }),
    ],
  },
  'ci-measurements-report': {
    name: 'ci/measurements-report',
    if: normalCiIf,
    needs: ['devenv-perf', 'nix-closure-sizes', 'source-shape'],
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: ciMeasurementsCommentPermissions,
    env: ciMeasurementSubjectEnv,
    steps: [
      checkoutStep(),
      installNixStep(),
      ciMeasurementReportToolStep,
      downloadCurrentMeasurementArtifactStep(
        'devenv-perf',
        `${ciMeasurementReportDir}/current/devenv-perf`,
      ),
      downloadCurrentMeasurementArtifactStep(
        'nix-closure-measurements',
        `${ciMeasurementReportDir}/current/nix-closure-measurements`,
      ),
      downloadCurrentMeasurementArtifactStep(
        'source-shape',
        `${ciMeasurementReportDir}/current/source-shape`,
      ),
      downloadPreviousGitHubArtifactStep({
        artifactName: 'devenv-perf',
        outputDir: `${ciMeasurementReportDir}/baseline/devenv-perf`,
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
  /** Integration tests for Notion API (requires NOTION_TOKEN secret) */
  'test-integration-notion': {
    if: normalCiIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': jobTimeoutMinutes,
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
      savePnpmStateStep(),
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
}

const deployJobs: Record<string, any> = {
  'deploy-storybooks': {
    if: normalCiIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': jobTimeoutMinutes,
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
      savePnpmStateStep(),
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
        ...ciMeasurementBaselineWorkflowDispatchInputs,
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
    'notify-alignment': {
      ...notifyAlignmentJob({
        targetRepo: 'schickling/megarepo-all',
        needs: [...Object.keys(jobs), ...Object.keys(deployJobs)],
        runner: [
          'namespace-profile-linux-x86-64',
          'namespace-features:github.run-id=${{ github.run_id }}',
        ],
      }),
      if: normalCiIf,
    },
  },
} satisfies GitHubWorkflowArgs)
