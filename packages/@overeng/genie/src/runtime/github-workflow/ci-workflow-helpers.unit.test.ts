import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const ciWorkflowSource = [
  'ci-workflow.ts',
  'ci-workflow/shared.ts',
  'ci-workflow/setup.ts',
  'ci-workflow/measurements.ts',
  'ci-workflow/megarepo.ts',
  'ci-workflow/merge-queue.ts',
  'ci-workflow/deploy.ts',
]
  .map((file) =>
    readFileSync(new URL(['../../../../../../genie', file].join('/'), import.meta.url), 'utf8'),
  )
  .join('\n')
const generatedWorkflowSource = readFileSync(
  new URL(['../../../../../../.github/workflows', 'ci.yml.genie.ts'].join('/'), import.meta.url),
  'utf8',
)
const generatedCiWorkflowYamlSource = readFileSync(
  new URL(['../../../../../../.github/workflows', 'ci.yml'].join('/'), import.meta.url),
  'utf8',
)
const vercelDeploySource = readFileSync(
  new URL(['../../../../../../genie/deploy-preview', 'vercel.ts'].join('/'), import.meta.url),
  'utf8',
)
const nixGcRaceRetryScriptSource = readFileSync(
  new URL(
    ['../../../../../../genie/ci-scripts', 'nix-gc-race-retry.sh'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const netlifyTaskModuleSource = readFileSync(
  new URL(
    ['../../../../../../nix/devenv-modules/tasks/shared', 'netlify.nix'].join('/'),
    import.meta.url,
  ),
  'utf8',
)

const extractSourceBlock = (source: string, startMarker: string, endMarker: string) => {
  const start = source.indexOf(startMarker)
  if (start < 0) {
    throw new Error(`missing source block start: ${startMarker}`)
  }

  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) {
    throw new Error(`missing source block end: ${endMarker}`)
  }

  return source.slice(start, end)
}

const pnpmDepsScanSource = extractSourceBlock(
  ciWorkflowSource,
  'const withEachPnpmDepsDrvShellLines = ({',
  '/** Evict cached pnpm-deps fixed-output outputs so CI re-derives them fresh. */',
)

const coldFreshBuildSource = extractSourceBlock(
  ciWorkflowSource,
  '/** Evict any cached pnpm-deps outputs below a flake target and rebuild it against cache.nixos.org only. */',
  '/**\n * Guard the pnpm dependency-prep contract against regressions that would',
)

const restorePnpmStateStepSource = extractSourceBlock(
  ciWorkflowSource,
  'export const restorePnpmStateStep = (opts?: {',
  '/**\n * Save the job-local pnpm state after the main task graph runs.',
)

const validateNixStoreStepSource = extractSourceBlock(
  ciWorkflowSource,
  'export const validateNixStoreStep = {',
  '/**\n * Upload diagnostics captured by `validateNixStoreStep` as a CI artifact.',
)

const applyMegarepoLockStepSource = extractSourceBlock(
  ciWorkflowSource,
  'export const applyMegarepoLockStep = (opts?: { skip?: string[] }) => {',
  'export type DefaultRefPolicyCheckStepOptions = {',
)
const defaultRefPolicyCheckStepSource = extractSourceBlock(
  ciWorkflowSource,
  'export type DefaultRefPolicyCheckStepOptions = {',
  '/** Fail when first-party megarepo/flake/devenv inputs target non-default refs. */',
)
const mergeQueueSource = extractSourceBlock(
  ciWorkflowSource,
  "export const mergeQueueAdmissionLabel = 'mq:ci-admitted' as const",
  'export const mergeQueueSemanticGateJob = ({',
)
const installMegarepoStepSource = extractSourceBlock(
  ciWorkflowSource,
  'export const installMegarepoStep = {',
  '/** Fetch latest refs and apply megarepo workspace. */',
)
const megarepoTaskModuleSource = readFileSync(
  new URL(
    ['../../../../../../nix/devenv-modules/tasks/shared', 'megarepo.nix'].join('/'),
    import.meta.url,
  ),
  'utf8',
)

describe('ci workflow retry helpers', () => {
  it('inlines the retry helper for bootstrap-safe downstream imports', () => {
    expect(ciWorkflowSource).toContain('const nixGcRaceRetryScript = String.raw')
    expect(ciWorkflowSource).toContain('Keep helper script bodies inline')
    expect(ciWorkflowSource).toContain('__nix_gc_retry_helper=$(mktemp)')
    expect(ciWorkflowSource).toContain('run_nix_gc_race_retry')
    expect(nixGcRaceRetryScriptSource).toContain("tr '\\r\\n' '  ' < \"$log\"")
    expect(nixGcRaceRetryScriptSource).not.toContain("awk 'BEGIN { ORS=")
  })
})

describe('ci workflow pnpm cache defaults', () => {
  it('keeps the shared pnpm home workspace-relative', () => {
    expect(ciWorkflowSource).toContain(
      "export const jobLocalPnpmHome = '${{ github.workspace }}/.pnpm-home'",
    )
  })

  it('defaults the pnpm state helpers to restoring both home and auxiliary store state', () => {
    expect(ciWorkflowSource).toContain(
      "export const jobLocalPnpmStatePaths = [jobLocalPnpmHome, jobLocalPnpmStore].join('\\n')",
    )
    expect(ciWorkflowSource).toContain('const path = opts?.path ?? jobLocalPnpmStatePaths')
  })

  it('uses exact-key pnpm state restore semantics with an explicit versioned prefix', () => {
    expect(restorePnpmStateStepSource).toContain(
      "const keyPrefix = opts?.keyPrefix ?? 'pnpm-state-v1'",
    )
    expect(restorePnpmStateStepSource).toContain("name: 'Restore pnpm state'")
    expect(restorePnpmStateStepSource).not.toContain("'restore-keys':")
  })

  it('only saves pnpm state after prior steps succeed', () => {
    expect(ciWorkflowSource).toContain("name: 'Save pnpm state'")
    expect(ciWorkflowSource).toContain(
      "if: `\\${{ success() && steps.${restoreStepId}.outputs.cache-hit != 'true' }}`",
    )
  })

  it('cold-builds pnpm deps artifacts by evicting cached outputs before the second build', () => {
    expect(coldFreshBuildSource).toContain('installable="${drv}^*"')
    expect(coldFreshBuildSource).toContain('while IFS= read -r outPath; do')
    expect(coldFreshBuildSource).toContain(
      'done < <(nix path-info "$installable" 2>/dev/null || true)',
    )
    expect(coldFreshBuildSource).toContain('...evictOutPathShellLines')
    expect(ciWorkflowSource).toContain('nix store delete --ignore-liveness "$outPath"')
    expect(ciWorkflowSource).toContain(
      'echo "::error::cached pnpm-deps output still present after eviction: $outPath"',
    )
    expect(coldFreshBuildSource).toContain(
      'nix build --no-link "$installable" --option substituters "https://cache.nixos.org"',
    )
  })

  it('prefers explicit depsBuildEntries metadata before falling back to closure scanning', () => {
    expect(pnpmDepsScanSource).toContain('$targetRef.passthru.depsBuildEntries')
    expect(pnpmDepsScanSource).toContain('(.drvPath // "")')
    expect(pnpmDepsScanSource).toContain('grep "pnpm-deps-[a-z0-9-]*-v[0-9]')
  })

  it('keeps the diagnostics summary portable', () => {
    expect(generatedWorkflowSource).toContain('head -n 120 "$markers_file"')
    expect(generatedWorkflowSource).not.toContain('sed -n "1,120p" "$markers_file"')
  })

  it('captures process snapshots without leaking full argv', () => {
    expect(ciWorkflowSource).toContain('stat,comm --sort=-%cpu')
    expect(ciWorkflowSource).toContain('stat,comm -r | head -15')
    expect(ciWorkflowSource).not.toContain('stat,command --sort=-%cpu')
    expect(ciWorkflowSource).not.toContain('stat,command -r | head -15')
  })

  it('purges nix eval cache from the active XDG cache root during repair', () => {
    expect(validateNixStoreStepSource).toContain(
      'rm -rf "${\'${XDG_CACHE_HOME:-$HOME/.cache}\'}"/nix/eval-cache-* ~/.cache/nix/eval-cache-*',
    )
  })

  it('resolves the locked megarepo CLI through a git flake URL', () => {
    expect(applyMegarepoLockStepSource).toContain(
      'nix run "github:overengineeringstudio/effect-utils/$EU_REV#megarepo"',
    )
    expect(applyMegarepoLockStepSource).not.toContain(
      'nix run "github:overengineeringstudio/effect-utils?ref=$EU_REF&rev=$EU_REV#megarepo"',
    )
  })

  it('installs setup-time megarepo from the locked effect-utils commit without mutating nix profiles', () => {
    expect(installMegarepoStepSource).toContain(
      'MR_REF="github:overengineeringstudio/effect-utils/$EU_REV#megarepo"',
    )
    expect(installMegarepoStepSource).toContain(
      'MR_OUT=$(nix build --no-link --print-out-paths "$MR_REF")',
    )
    expect(installMegarepoStepSource).toContain('printf \'%s\\n\' "$MR_BIN_DIR" >> "$GITHUB_PATH"')
    expect(installMegarepoStepSource).not.toContain('nix profile install')
  })

  it('only exports skipped megarepo members when the CI lane actually skips members', () => {
    expect(applyMegarepoLockStepSource).toContain('MEGAREPO_SKIP_MEMBERS')
    expect(applyMegarepoLockStepSource).toContain("skipCsv === ''")
    expect(applyMegarepoLockStepSource).toContain(`printf 'MEGAREPO_SKIP_MEMBERS=%s\\n'`)
  })

  it('passes skipped megarepo members as one comma-separated CLI option', () => {
    expect(megarepoTaskModuleSource).toContain('MR_SKIP_ARGS+=(--skip "$_mr_skip_csv")')
    expect(megarepoTaskModuleSource).not.toContain('MR_SKIP_ARGS+=(--skip "$member")')
  })

  it('accepts current, historical, and nested mr ls success payloads', () => {
    expect(megarepoTaskModuleSource).toContain(
      '(.members // .value.members // .value.value.members // [])',
    )
    expect(megarepoTaskModuleSource).not.toContain('.value.members[].name')
  })

  it('normalizes GitHub branch refs through an explicit default-ref policy option', () => {
    expect(defaultRefPolicyCheckStepSource).toContain('normalizeGitBranchRefs?: boolean')
    expect(defaultRefPolicyCheckStepSource).toContain('NORMALIZE_GIT_BRANCH_REFS')
    expect(defaultRefPolicyCheckStepSource).toContain("ref.startsWith('refs/heads/')")
  })
})

describe('ci workflow merge queue helpers', () => {
  it('centralizes the Hypermerge semantic required checks and admission label expressions', () => {
    expect(mergeQueueSource).toContain('mergeQueueRequiredCIJobs')
    expect(mergeQueueSource).toContain('mq/admission')
    expect(mergeQueueSource).toContain('pr/quality')
    expect(mergeQueueSource).toContain('pr/topology')
    expect(mergeQueueSource).toContain('pr/freshness')
    expect(mergeQueueSource).toContain('pr/contract')
    expect(mergeQueueSource).toContain('mq:ci-admitted')
  })

  it('preserves label control-event concurrency for scarce self-hosted runners', () => {
    expect(mergeQueueSource).toContain('mergeQueueWorkflowConcurrency')
    expect(mergeQueueSource).toContain('mergeQueueWorkflowOn')
    expect(mergeQueueSource).toContain('merge_group: null')
    expect(mergeQueueSource).toContain("format('label-{0}', github.event.label.name)")
    expect(mergeQueueSource).toContain(
      "github.event.action != 'labeled' && github.event.action != 'unlabeled'",
    )
  })

  it('exports reusable admission and semantic gate jobs', () => {
    expect(ciWorkflowSource).toContain('export const mergeQueueAdmissionGateJob')
    expect(ciWorkflowSource).toContain('export const mergeQueueAdmittedJob')
    expect(ciWorkflowSource).toContain('export const mergeQueueSemanticGateJob')
    expect(ciWorkflowSource).toContain('export const mergeQueueSemanticGateJobs')
    expect(ciWorkflowSource).toContain('trustNeedsAdmission: true')
    expect(ciWorkflowSource).toContain('requiredGateCheckName(name)')
  })

  it('hardens dynamic semantic gate names and admission-job permissions', async () => {
    const { mergeQueueAdmittedJob, mergeQueueWorkflowOn, requiredGateCheckName } = (await import(
      // oxlint-disable-next-line import/no-dynamic-require
      new URL('../../../../../../genie/ci-workflow.ts', import.meta.url).href
    )) as any

    expect(requiredGateCheckName("pr/quality's gate")).toBe(
      "${{ ((github.event_name != 'pull_request' || (github.event.action != 'labeled' && github.event.action != 'unlabeled') || (github.event.action == 'labeled' && github.event.label.name == 'mq:ci-admitted')) && (github.event_name != 'pull_request' || (contains(github.event.pull_request.labels.*.name, 'mq:ci-admitted') || (github.event.action == 'labeled' && github.event.label.name == 'mq:ci-admitted')))) && 'pr/quality''s gate' || 'pr/quality''s gate (control event)' }}",
    )

    const runsOn = ['sh-linux-x64', 'nix'] as const
    const admittedJob = mergeQueueAdmittedJob({
      runsOn,
      permissions: { actions: 'read' },
      steps: [{ name: 'Proof', run: 'true' }],
    })

    expect(admittedJob['runs-on']).toEqual(['sh-linux-x64', 'nix'])
    expect(admittedJob['runs-on']).not.toBe(runsOn)
    expect(admittedJob.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      issues: 'read',
      'pull-requests': 'read',
    })
    expect(mergeQueueWorkflowOn()).toMatchObject({ merge_group: null })
  })
})

describe('ci workflow shared auth helpers', () => {
  it('supports minting GitHub App installation tokens for downstream private inputs', () => {
    expect(ciWorkflowSource).toContain('export const githubAppInstallationTokenStep')
    expect(ciWorkflowSource).toContain("uses: 'actions/create-github-app-token@v3' as const")
  })

  it('lets installNixStep override the GitHub access token expression', () => {
    expect(ciWorkflowSource).toContain('githubAccessTokenExpression?: string')
    expect(ciWorkflowSource).toContain(
      "access-tokens = github.com=${opts?.githubAccessTokenExpression ?? '${{ github.token }}'}",
    )
  })

  it('lets installNixStep disable Determinate summaries when runners reuse a preinstalled Nix', () => {
    expect(ciWorkflowSource).toContain('summarize?: boolean')
    expect(ciWorkflowSource).toContain('summarize: opts?.summarize ?? true')
  })

  it('exposes a dedicated env helper for self-hosted wrapper auth', () => {
    expect(ciWorkflowSource).toContain('export const githubAccessTokenEnv')
    expect(ciWorkflowSource).toContain('GITHUB_TOKEN: tokenExpression')
    expect(ciWorkflowSource).toContain('GH_TOKEN: tokenExpression')
    expect(ciWorkflowSource).toContain('export const withGitHubAccessTokenEnv')
  })

  it('can wrap shell steps with job-local private Cachix read auth', () => {
    expect(ciWorkflowSource).toContain('export const withPrivateCachixReadAuth')
    expect(ciWorkflowSource).toContain('CACHIX_AUTH_TOKEN: opts.authTokenExpression')
    expect(ciWorkflowSource).toContain(
      'cachix_netrc="$(mktemp "${RUNNER_TEMP:-/tmp}/cachix-netrc.XXXXXX")"',
    )
    expect(ciWorkflowSource).toContain('netrc-file = $cachix_netrc')
    expect(ciWorkflowSource).toContain('export NIX_CONFIG="$NIX_CONFIG_WITH_APPEND"')
  })

  it('only appends GitHub access tokens to NIX_CONFIG through GITHUB_ENV', () => {
    expect(ciWorkflowSource).toContain('export const appendGitHubAccessTokenToNixConfigStep')
    expect(ciWorkflowSource).toContain('access-tokens = github.com=%s')
    expect(ciWorkflowSource).not.toContain(
      'printf "GITHUB_TOKEN=%s\\nGH_TOKEN=%s\\n" "$token" "$token"',
    )
  })

  it('pins the shared CI actions to the Node-24-safe majors', () => {
    expect(ciWorkflowSource).toContain("uses: 'actions/checkout@v6' as const")
    expect(ciWorkflowSource).toContain("uses: 'cachix/cachix-action@v17' as const")
  })

  it('provides cachix CLI from /nix/store on PATH instead of mutating the runner nix profile', () => {
    expect(ciWorkflowSource).toContain('export const cachixCliBuildStep')
    expect(ciWorkflowSource).toContain('nix build --no-link --print-out-paths nixpkgs#cachix')
    expect(ciWorkflowSource).toContain('echo "$out/bin" >> "$GITHUB_PATH"')
  })

  it('keeps cachixStep free of installCommand so cachix-action short-circuits via PATH', () => {
    const cachixStepSource = extractSourceBlock(ciWorkflowSource, 'export const cachixStep', '})\n')
    expect(cachixStepSource).not.toContain('installCommand')
    expect(cachixStepSource).not.toContain('nix profile install')
  })

  it('uses the Nix-provided Netlify CLI for parallel deploy safety', () => {
    expect(netlifyTaskModuleSource).toContain('netlify = "${pkgs.netlify-cli}/bin/netlify";')
    expect(netlifyTaskModuleSource).not.toContain('bunx netlify-cli@24.11.3')
  })

  it('lets Vercel deploy jobs decorate the deploy run step', () => {
    expect(ciWorkflowSource).toContain('deployStepDecorator?: (')
    expect(ciWorkflowSource).toContain('project: VercelProject')
    expect(vercelDeploySource).toContain('opts.deployStepDecorator?.(')
    expect(vercelDeploySource).toContain('vercelDeployStep(project, opts.runDevenvTasksBefore)')
  })
})

describe('ci workflow standard job helpers', () => {
  it('centralizes self-hosted devenv task job composition', () => {
    expect(ciWorkflowSource).toContain('export const devenvTaskStep')
    expect(ciWorkflowSource).toContain('export const standardSelfHostedDevenvTaskJob')
    expect(ciWorkflowSource).toContain('standardSelfHostedPnpmCiPrepSteps(prep)')
    expect(ciWorkflowSource).toContain('standardSelfHostedPnpmCiPostSteps(post)')
  })
})

describe('ci workflow devenv perf helpers', () => {
  it('exposes reusable devenv perf CI job helpers', () => {
    expect(ciWorkflowSource).toContain('export const devenvPerfJob')
    expect(ciWorkflowSource).toContain('export const devenvPerfBenchmarkStep')
    expect(ciWorkflowSource).toContain('export const devenvPerfArtifactStep')
    expect(ciWorkflowSource).toContain('export type CiMeasurementDescriptor')
    expect(ciWorkflowSource).toContain('export type DevenvPerfProbe')
    expect(ciWorkflowSource).toContain('export type DevenvPerfTaskProbe')
    expect(ciWorkflowSource).toContain('export const nixClosureMeasurementStep')
    expect(ciWorkflowSource).toContain('export const nixClosureMeasurementSteps')
    expect(ciWorkflowSource).toContain('export const nixClosureMeasurementsJob')
    expect(ciWorkflowSource).toContain('export const defaultNixClosureMeasurementBuckets')
    expect(ciWorkflowSource).toContain('export type NixClosureMeasurementBucket')
    expect(ciWorkflowSource).toContain('export type NixClosureMeasurementTarget')
  })

  it('emits the standard warm shell and task-list probes with native trace artifacts', () => {
    expect(generatedCiWorkflowYamlSource).toContain('devenv-perf:')
    expect(generatedCiWorkflowYamlSource).toContain('OTEL_SERVICE_NAME: devenv-perf-ci')
    expect(generatedCiWorkflowYamlSource).toContain(
      "measure 'shell_eval_traced' 'Shell eval with OTEL trace' 'devenv shell' 'Evaluates the dev shell with native devenv JSON tracing enabled.' '$ARTIFACT_DIR/traces/shell_eval_traced.json' '0' '1'",
    )
    expect(generatedCiWorkflowYamlSource).toContain('--trace-to')
    expect(generatedCiWorkflowYamlSource).toContain('json:file:$trace_file')
    expect(generatedCiWorkflowYamlSource).toContain('$ARTIFACT_DIR/traces/shell_eval_traced.json')
    expect(generatedCiWorkflowYamlSource).toContain("measure 'shell_eval_warm' 'Warm shell eval'")
    expect(generatedCiWorkflowYamlSource).toContain("measure 'tasks_list' 'devenv tasks list'")
    expect(generatedCiWorkflowYamlSource).toContain(
      "'Loads the devenv processes command help path.' '' '1' '9'",
    )
  })

  it('writes a stable summary artifact for regression tracking', () => {
    expect(generatedCiWorkflowYamlSource).toContain('schemaVersion: $schemaVersion')
    expect(generatedCiWorkflowYamlSource).toContain('checks: ($timings[0] | map')
    expect(generatedCiWorkflowYamlSource).toContain('measurements.json')
    expect(generatedCiWorkflowYamlSource).toContain('--argjson schemaVersion 1')
    expect(generatedCiWorkflowYamlSource).toContain('effect-utils-ci-measurement')
    expect(generatedCiWorkflowYamlSource).toContain('devenv." + .id + ".duration')
    expect(generatedCiWorkflowYamlSource).toContain(
      'target: { kind: "devenv", id: "dev-shell", name: "dev-shell", label: "Dev shell", group: "devenv", system: $targetSystem }',
    )
    expect(generatedCiWorkflowYamlSource).toContain('probeLabel: .label')
    expect(generatedCiWorkflowYamlSource).toContain('sampleCount: (.statistics.sampleCount // 1)')
    expect(generatedCiWorkflowYamlSource).toContain('baselineSources')
    expect(generatedCiWorkflowYamlSource).toContain('low_baseline_count')
    expect(generatedCiWorkflowYamlSource).toContain('low_current_sample_count')
    expect(generatedCiWorkflowYamlSource).toContain('low_paired_sample_count')
    expect(generatedCiWorkflowYamlSource).toContain('readiness:$readiness')
    expect(generatedCiWorkflowYamlSource).toContain(
      'enforceable: (.enabledCount == .gateableCount)',
    )
    expect(generatedCiWorkflowYamlSource).toContain('within_baseline_range')
    expect(generatedCiWorkflowYamlSource).toContain(
      'elif $needsHistoricalBaselineCount and $baselineSources < ($policy.minBaselineSources // 1) then "low_baseline_count"',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'elif $currentSamples < ($policy.minCurrentSamples // 1) then "low_current_sample_count"',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'if ($gateable and $confidence == "threshold_exceeded") then $thresholdStatus',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'elif ($canUseRobustBandSuppression and $thresholdStatus != "pass" and $withinRobustBand) then "within_robust_band"',
    )
    expect(ciWorkflowSource).toContain("label: 'Needs more baseline'")
    expect(ciWorkflowSource).toContain("label: 'Needs repeat'")
    expect(ciWorkflowSource).toContain("label: 'Needs paired evidence'")
    expect(ciWorkflowSource).toContain("label: 'Too small to matter'")
    expect(ciWorkflowSource).toContain("label: 'Within noise band'")
    expect(ciWorkflowSource).toContain("label: 'Meaningfully lower'")
    expect(generatedCiWorkflowYamlSource).toContain('RUNNER_CLASS:')
    expect(generatedCiWorkflowYamlSource).toContain('namespace-profile-linux-x86-64')
    expect(ciWorkflowSource).toContain('nix.closure.nar_size')
    expect(ciWorkflowSource).toContain('nix.closure.path_count')
    expect(ciWorkflowSource).toContain('nix.closure.bucket.nar_size')
    expect(ciWorkflowSource).toContain('artifact_file=${artifactFileAssignment}')
    expect(ciWorkflowSource).not.toContain('artifact_file=${shellSingleQuote(artifactFile)}')
    expect(ciWorkflowSource).toContain(
      'target: { kind: "nix-closure", id: $targetId, name: $targetName, label: $targetLabel, group: $targetGroup, path: $targetPath, system: $targetSystem }',
    )
    expect(ciWorkflowSource).toContain(
      'topPaths: ($closurePaths | sort_by(.narSize) | reverse | .[:30])',
    )
    expect(generatedCiWorkflowYamlSource).not.toContain('dev3')
    expect(generatedCiWorkflowYamlSource).not.toContain('perf-comparison.json')
    expect(generatedCiWorkflowYamlSource).not.toContain('DEVENV_PERF_REGRESSION_MODE')
    expect(generatedCiWorkflowYamlSource).toContain('devenv-perf-warm-median-v2')
    expect(generatedCiWorkflowYamlSource).toContain("CI_MEASUREMENT_PR_COMMENT_ENABLED: 'true'")
    expect(generatedCiWorkflowYamlSource).toContain(
      'CI_MEASUREMENT_PR_COMMENT_TITLE: CI Measurements',
    )
    expect(generatedCiWorkflowYamlSource).toContain('BASELINE_SEED_RUNS_JSON:')
    expect(generatedCiWorkflowYamlSource).toContain('BASELINE_REQUIRED_OBSERVATIONS_JSON:')
    expect(generatedCiWorkflowYamlSource).toContain('BASELINE_MAX_CANDIDATE_RUNS:')
    expect(generatedCiWorkflowYamlSource).toContain("measure 'task_check_quick_warm'")
    expect(generatedCiWorkflowYamlSource).toContain("measure 'task_check_quick_forced'")
    expect(generatedCiWorkflowYamlSource).not.toContain('"id":"devenv.task_check_quick.duration"')
    expect(ciWorkflowSource).toContain(
      'requiredObservations?: readonly CiMeasurementRequiredBaselineObservation[]',
    )
    expect(ciWorkflowSource).toContain('baselineMaxCandidateRuns?: number')
    expect(ciWorkflowSource).toContain('baseline_requirements_satisfied')
    expect(ciWorkflowSource).toContain('observationCounts: ($observationCounts[0] // null)')
    expect(generatedCiWorkflowYamlSource).toContain('"runId":"26085158592"')
    expect(generatedCiWorkflowYamlSource).toContain('"label":"main baseline"')
    expect(generatedCiWorkflowYamlSource).toContain('Upload devenv perf artifacts')
    expect(generatedCiWorkflowYamlSource).toContain('retention-days: 30')
    expect(ciWorkflowSource).toContain("contents: 'write'")
    expect(ciWorkflowSource).toContain('seedRuns?: readonly CiMeasurementBaselineSeedRun[]')
    expect(ciWorkflowSource).toContain('seedRunIds?: readonly string[]')
    expect(ciWorkflowSource).toContain('baselineSeedRuns?: readonly CiMeasurementBaselineSeedRun[]')
    expect(ciWorkflowSource).toContain('baselineSeedRunIds?: readonly string[]')
    expect(ciWorkflowSource).not.toContain('measurement_pr_number:')
    expect(ciWorkflowSource).not.toContain('CI_MEASUREMENT_PR_COMMENT_PR_NUMBER')
    expect(ciWorkflowSource).toContain(
      'CI measurement PR comments are produced only by pull_request workflows',
    )
    expect(ciWorkflowSource).toContain('unable to publish required CI measurement PR comment')
    expect(ciWorkflowSource).toContain('seedRuns: ($seedRuns[0] // [])')
    expect(ciWorkflowSource).toContain('baselineProvenance: ($baselineProvenance[0] // null)')
    expect(ciWorkflowSource).toContain(
      '["devenvRev", "otelServiceName", "status", "probeLabel", "sampleCount", "measuredSampleCount"] | index($key) | not',
    )
    expect(ciWorkflowSource).toContain('chart_file="$comment_tmp_dir/perf-change-vs-baseline.svg"')
    expect(ciWorkflowSource).toContain(
      'chart_png_file="$comment_tmp_dir/perf-change-vs-baseline.png"',
    )
    expect(ciWorkflowSource).toContain(
      'chart_dark_png_file="$comment_tmp_dir/perf-change-vs-baseline-dark.png"',
    )
    expect(ciWorkflowSource).toContain(
      'No regressions. Comparable movement is below the semantic impact threshold; neutral rows are collapsed below.',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'github.workflow }}-${{ github.event_name }}-${{ github.ref }}',
    )
    expect(generatedCiWorkflowYamlSource).not.toMatch(/^concurrency:/m)
    expect(generatedCiWorkflowYamlSource).toContain('concurrency:\n      group:')
    expect(generatedCiWorkflowYamlSource).toContain('}}-typecheck')
    expect(ciWorkflowSource).toContain('export const ciJobConcurrency = (jobId: string, opts?:')
    expect(ciWorkflowSource).toContain("opts?.matrix === true ? '-${{ strategy.job-index }}' : ''")
    expect(ciWorkflowSource).toContain('const isMatrixJob = (job: GitHubWorkflowArgs')
    expect(generatedCiWorkflowYamlSource).toContain('}}-test-${{ strategy.job-index }}')
    expect(generatedCiWorkflowYamlSource).toContain('}}-nix-check-${{ strategy.job-index }}')
    expect(generatedCiWorkflowYamlSource).toContain("format('measurement-baseline-{0}'")
    expect(generatedCiWorkflowYamlSource).not.toContain("format('measurement-pr-{0}-run-{1}'")
    expect(generatedCiWorkflowYamlSource).not.toContain('inputs.measurement_pr_number')
    expect(generatedCiWorkflowYamlSource).toContain("format('manual-run-{0}', github.run_id)")
    expect(generatedCiWorkflowYamlSource).toContain("format('label-{0}', github.event.label.name)")
    expect(generatedCiWorkflowYamlSource).toContain(
      "inputs.measurement_baseline_ref != '') && (github.event_name != 'pull_request'",
    )
    expect(ciWorkflowSource).toContain(
      '| What changed? | Group | Probe | Baseline -> current | Raw change | Impact | Confidence |',
    )
    expect(ciWorkflowSource).toContain('const semanticGroupLabel = (row) =>')
    expect(ciWorkflowSource).toContain('groupedScanTables(visibleNonZeroImpactRows)')
    expect(ciWorkflowSource).toContain(
      'const zeroImpactRows = actionableComparableRows.filter(isZeroImpactRow)',
    )
    expect(ciWorkflowSource).toContain('<summary>Unchanged / 0-impact measurements (')
    expect(ciWorkflowSource).toContain('<summary>Source-of-truth JSON</summary>')
    expect(ciWorkflowSource).toContain('const sourceOfTruth = {')
    expect(ciWorkflowSource).toContain('No non-zero actionable measurement impact detected.')
    expect(ciWorkflowSource).toContain('readiness <code>')
    expect(ciWorkflowSource).toContain('renderPerfChangeSvg')
    expect(ciWorkflowSource).toContain('Actionable measurement impact')
    expect(ciWorkflowSource).toContain(
      '0 means no actionable PR impact; 1x reaches the warning budget.',
    )
    expect(ciWorkflowSource).toContain('@media (prefers-color-scheme: dark)')
    expect(ciWorkflowSource).toContain('.chart-bg { fill: #0d1117; }')
    expect(ciWorkflowSource).toContain('<picture>')
    expect(ciWorkflowSource).toContain('<source media="(prefers-color-scheme: dark)"')
    expect(ciWorkflowSource).toContain('[SVG source]')
    expect(ciWorkflowSource).toContain('ensure_ci_measurement_tool resvg resvg')
    expect(ciWorkflowSource).toContain('nixpkgs#dejavu_fonts')
    expect(ciWorkflowSource).toContain('DejaVu Sans')
    expect(ciWorkflowSource).toContain('https://raw.githubusercontent.com')
    expect(ciWorkflowSource).toContain('repo_private="$(gh api "repos/$repo"')
    expect(ciWorkflowSource).toContain('if [ "$repo_private" = "true" ]; then')
    expect(ciWorkflowSource).toContain('CI_MEASUREMENT_PR_COMMENT_PUBLIC_ASSET_COMMAND')
    expect(ciWorkflowSource).toContain('bash -c "$public_asset_command" _ "$chart_png_file" png')
    expect(ciWorkflowSource).toContain(
      'bash -c "$public_asset_command" _ "$chart_dark_png_file" png',
    )
    expect(ciWorkflowSource).toContain('gh api "repos/$repo/contents/$asset_svg_path"')
    expect(ciWorkflowSource).toContain('gh api "repos/$repo/contents/$asset_png_path"')
    expect(ciWorkflowSource).toContain('gh api "repos/$repo/contents/$asset_dark_png_path"')
    expect(ciWorkflowSource).toContain('base64 <"$chart_file" | tr -d \'\\n\'')
    expect(ciWorkflowSource).toContain('base64 <"$chart_png_file" | tr -d \'\\n\'')
    expect(ciWorkflowSource).toContain(
      'nix path-info --recursive --closure-size --json "$out_path"',
    )
    expect(ciWorkflowSource).toContain('nix.closure.serialized_nar_size')
  })
})
