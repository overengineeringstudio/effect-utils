import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import {
  checkoutStep,
  installNixStep,
  preparePinnedDevenvStep,
  validateNixStoreStep,
} from './setup.ts'
import {
  bashShellDefaults,
  dollar,
  linuxX64Runner,
  shellSingleQuote,
  standardCIEnv,
} from './shared.ts'

export type DevenvPerfProbe = {
  readonly name: string
  readonly command: readonly [string, ...string[]]
  readonly traceOutput?: string
}

export type CiMeasurementObservation = {
  readonly name: string
  readonly unit: string
  readonly value: number
  readonly dimensions?: Record<string, string | number | boolean | null>
}

export const ciMeasurementMetrics = {
  devenvProbeDuration: 'devenv.<probe>.duration',
  nixClosureNarSize: 'nix.closure.nar_size',
  nixClosurePathCount: 'nix.closure.path_count',
  nixClosureBucketNarSize: 'nix.closure.bucket.nar_size',
} as const

export type NixClosureMeasurementBucket = {
  readonly name: string
  readonly pathRegex: string
}

export type NixClosureMeasurementStepOptions = {
  readonly installable: string
  readonly targetName?: string
  readonly targetSystem?: string
  readonly artifactDir?: string
  readonly artifactFile?: string
  readonly buckets?: readonly NixClosureMeasurementBucket[]
}

type DevenvPerfSetupStep = GitHubWorkflowArgs['jobs'][string]['steps'][number]

export type DevenvPerfJobOptions = {
  readonly runsOn?: readonly string[]
  readonly artifactDir?: string
  readonly artifactName?: string
  readonly setupSteps?: readonly DevenvPerfSetupStep[]
  readonly env?: Record<string, string>
  readonly taskProbes?: readonly string[]
  readonly probes?: readonly DevenvPerfProbe[]
  readonly retentionDays?: number
  readonly regressionMode?: 'off' | 'warn' | 'fail'
}

const devenvPerfProbeLine = (probe: DevenvPerfProbe) => {
  const args = probe.command.map(shellSingleQuote).join(' ')
  const trace = probe.traceOutput ?? ''
  return `measure ${shellSingleQuote(probe.name)} ${shellSingleQuote(trace)} ${args}`
}

const defaultDevenvPerfTaskProbe = (task: string): DevenvPerfProbe => ({
  name: `task_${task.replaceAll(':', '_')}`,
  command: ['$DEVENV_BIN', 'tasks', 'run', task, '--mode', 'before', '--no-tui', '--show-output'],
})

const renderDevenvPerfScript = (
  opts: Required<Pick<DevenvPerfJobOptions, 'taskProbes' | 'probes'>>,
) => {
  const probes: readonly DevenvPerfProbe[] = [
    {
      name: 'shell_eval_traced',
      command: [
        '$DEVENV_BIN',
        '--trace-to',
        'json:file:$trace_file',
        'shell',
        '--no-reload',
        '--',
        'true',
      ],
      traceOutput: '$ARTIFACT_DIR/traces/shell_eval_traced.json',
    },
    { name: 'shell_eval_warm', command: ['$DEVENV_BIN', 'shell', '--no-reload', '--', 'true'] },
    { name: 'tasks_list', command: ['$DEVENV_BIN', 'tasks', 'list'] },
    { name: 'processes_help', command: ['$DEVENV_BIN', 'processes', '--help'] },
    ...opts.taskProbes.map(defaultDevenvPerfTaskProbe),
    ...opts.probes,
  ]

  return String.raw`set -euo pipefail

mkdir -p "$ARTIFACT_DIR/traces"

{
  printf 'timestamp_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'repository=%s\n' "${dollar}{GITHUB_REPOSITORY:-unknown}"
  printf 'ref=%s\n' "${dollar}{GITHUB_REF:-unknown}"
  printf 'sha=%s\n' "${dollar}{GITHUB_SHA:-unknown}"
  printf 'runner_name=%s\n' "${dollar}{RUNNER_NAME:-unknown}"
  printf 'runner_os=%s\n' "${dollar}{RUNNER_OS:-unknown}"
  printf 'runner_arch=%s\n' "${dollar}{RUNNER_ARCH:-unknown}"
  printf 'devenv_rev=%s\n' "${dollar}{DEVENV_REV:-unknown}"
  printf 'otel_service_name=%s\n' "${dollar}{OTEL_SERVICE_NAME:-unknown}"
  df -h / /nix 2>/dev/null || df -h /
  ps -eo pid,ppid,stat,etime,pcpu,pmem,comm,args 2>/dev/null \
    | grep -E 'devenv direnv-export|nix-daemon|nix build|nix flake|github-runner' \
    | grep -v grep || true
} >"$ARTIFACT_DIR/host-context.txt"

printf '[' >"$ARTIFACT_DIR/timings.json"
first=1

json_append_timing() {
  local name="$1"
  local status="$2"
  local duration_ms="$3"
  local stdout="$4"
  local stderr="$5"
  local trace="$6"

  if [ "$first" -eq 0 ]; then
    printf ',' >>"$ARTIFACT_DIR/timings.json"
  fi
  first=0

  jq -cn \
    --arg name "$name" \
    --argjson status "$status" \
    --argjson durationMs "$duration_ms" \
    --arg stdout "$stdout" \
    --arg stderr "$stderr" \
    --arg trace "$trace" \
    '{name:$name,status:$status,durationMs:$durationMs,stdout:$stdout,stderr:$stderr,trace:(if $trace == "" then null else $trace end)}' \
    >>"$ARTIFACT_DIR/timings.json"
}

measure() {
  local name="$1"
  local trace_file="$2"
  shift 2
  case "$trace_file" in
    '$ARTIFACT_DIR'*) trace_file="${dollar}{ARTIFACT_DIR}${dollar}{trace_file#'$ARTIFACT_DIR'}" ;;
  esac
  local stdout="$ARTIFACT_DIR/$name.stdout"
  local stderr="$ARTIFACT_DIR/$name.stderr"
  local started ended status duration_ms

  mkdir -p "$(dirname "$trace_file")"
  started="$(date +%s%3N)"
  set +e
  expanded=()
  for arg in "$@"; do
    case "$arg" in
      '$DEVENV_BIN') expanded+=("${dollar}{DEVENV_BIN:?DEVENV_BIN not set}") ;;
      '$ARTIFACT_DIR'*) expanded+=("${dollar}{ARTIFACT_DIR}${dollar}{arg#'$ARTIFACT_DIR'}") ;;
      'json:file:$trace_file') expanded+=("json:file:$trace_file") ;;
      '$trace_file') expanded+=("file:$trace_file") ;;
      *) expanded+=("$arg") ;;
    esac
  done
  "${dollar}{expanded[@]}" >"$stdout" 2>"$stderr"
  status=$?
  set -e
  ended="$(date +%s%3N)"
  duration_ms=$((ended - started))

  json_append_timing "$name" "$status" "$duration_ms" "$stdout" "$stderr" "$trace_file"

  if [ "$status" -ne 0 ]; then
    echo "::error::$name failed after ${dollar}{duration_ms}ms; stderr tail follows"
    tail -80 "$stderr" || true
    return "$status"
  fi
}

${probes.map(devenvPerfProbeLine).join('\n')}

printf ']\n' >>"$ARTIFACT_DIR/timings.json"

jq . "$ARTIFACT_DIR/timings.json" >"$ARTIFACT_DIR/timings.pretty.json"
jq -n \
  --slurpfile timings "$ARTIFACT_DIR/timings.json" \
  --arg schemaVersion "1" \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg repository "${dollar}{GITHUB_REPOSITORY:-unknown}" \
  --arg ref "${dollar}{GITHUB_REF:-unknown}" \
  --arg sha "${dollar}{GITHUB_SHA:-unknown}" \
  --arg runnerName "${dollar}{RUNNER_NAME:-unknown}" \
  --arg runnerOs "${dollar}{RUNNER_OS:-unknown}" \
  --arg runnerArch "${dollar}{RUNNER_ARCH:-unknown}" \
  --arg devenvRev "${dollar}{DEVENV_REV:-unknown}" \
  --arg otelServiceName "${dollar}{OTEL_SERVICE_NAME:-unknown}" \
  '{
    schemaVersion: $schemaVersion,
    generatedAt: $generatedAt,
    repository: $repository,
    ref: $ref,
    sha: $sha,
    runner: { name: $runnerName, os: $runnerOs, arch: $runnerArch },
    devenv: { rev: $devenvRev },
    otel: { serviceName: $otelServiceName },
    checks: ($timings[0] | map({ key: .name, value: . }) | from_entries)
  }' >"$ARTIFACT_DIR/summary.json"

jq -n \
  --slurpfile timings "$ARTIFACT_DIR/timings.json" \
  --argjson schemaVersion 1 \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg repository "${dollar}{GITHUB_REPOSITORY:-unknown}" \
  --arg branchKind "${dollar}{GITHUB_EVENT_NAME:-unknown}" \
  --arg ref "${dollar}{GITHUB_REF:-unknown}" \
  --arg headSha "${dollar}{GITHUB_SHA:-unknown}" \
  --arg baseSha "${dollar}{GITHUB_BASE_SHA:-}" \
  --arg runnerName "${dollar}{RUNNER_NAME:-unknown}" \
  --arg runnerOs "${dollar}{RUNNER_OS:-unknown}" \
  --arg runnerArch "${dollar}{RUNNER_ARCH:-unknown}" \
  --arg runnerClass "${dollar}{RUNNER_CLASS:-unknown}" \
  --arg githubRunId "${dollar}{GITHUB_RUN_ID:-unknown}" \
  --arg githubRunAttempt "${dollar}{GITHUB_RUN_ATTEMPT:-unknown}" \
  --arg githubJob "${dollar}{GITHUB_JOB:-unknown}" \
  --arg taskId "${dollar}{CROSSTASK_TASK_ID:-}" \
  --arg taskAttemptId "${dollar}{CROSSTASK_ATTEMPT_ID:-}" \
  --arg traceId "${dollar}{TRACE_ID:-}" \
  --arg devenvRev "${dollar}{DEVENV_REV:-unknown}" \
  --arg otelServiceName "${dollar}{OTEL_SERVICE_NAME:-unknown}" \
  --arg targetSystem "${dollar}{DEVENV_SYSTEM:-${dollar}{RUNNER_OS:-unknown}}" \
  '{
    schemaVersion: $schemaVersion,
    generatedAt: $generatedAt,
    producer: { name: "effect-utils-ci-measurement", version: 1 },
    subject: {
      repo: $repository,
      branchKind: (if $branchKind == "" then "unknown" else $branchKind end),
      ref: $ref,
      headSha: $headSha,
      baseSha: $baseSha
    },
    execution: {
      provider: (if ($githubRunId != "" and $githubRunId != "unknown") then "github-actions" else "local" end),
      workflow: "CI",
      job: $githubJob,
      runId: $githubRunId,
      runAttempt: $githubRunAttempt,
      taskId: $taskId,
      attemptId: $taskAttemptId,
      traceId: $traceId,
      runner: { name: $runnerName, os: $runnerOs, arch: $runnerArch, class: $runnerClass }
    },
    target: { kind: "devenv", name: "dev-shell", system: $targetSystem },
    observations: (
      $timings[0]
      | map({
          name: ("devenv." + .name + ".duration"),
          unit: "seconds",
          value: (.durationMs / 1000),
          dimensions: {
            probe: .name,
            status: .status,
            devenvRev: $devenvRev,
            otelServiceName: $otelServiceName
          }
        })
    ),
    artifacts: [
      { name: "host-context", path: "host-context.txt", contentType: "text/plain" },
      { name: "timings", path: "timings.json", contentType: "application/json" },
      { name: "summary", path: "summary.json", contentType: "application/json" },
      { name: "shell-eval-trace", path: "traces/shell_eval_traced.json", contentType: "application/json" }
    ],
    details: {
      stdoutStderrByProbe: (
        $timings[0]
        | map({ key: .name, value: { stdout: .stdout, stderr: .stderr, trace: .trace } })
        | from_entries
      )
    }
  }' >"$ARTIFACT_DIR/measurements.json"

compare_baseline() {
  local baseline_path="${dollar}{DEVENV_PERF_BASELINE_SUMMARY:-$ARTIFACT_DIR/baseline/summary.json}"
  local mode="${dollar}{DEVENV_PERF_REGRESSION_MODE:-warn}"

  if [ "$mode" = "off" ]; then
    jq -n --argjson schemaVersion 1 --arg status skipped --arg mode "$mode" '{schemaVersion:$schemaVersion, status:$status, mode:$mode, checks:{}}' >"$ARTIFACT_DIR/perf-comparison.json"
    return 0
  fi

  if [ ! -f "$baseline_path" ]; then
    jq -n \
      --argjson schemaVersion 1 \
      --arg status baseline_missing \
      --arg mode "$mode" \
      --arg baseline "$baseline_path" \
      '{schemaVersion:$schemaVersion, status:$status, mode:$mode, baseline:$baseline, checks:{}}' \
      >"$ARTIFACT_DIR/perf-comparison.json"
    echo "::notice::devenv perf baseline not found at $baseline_path; recorded current measurements only"
    return 0
  fi

  jq -n \
    --slurpfile current "$ARTIFACT_DIR/summary.json" \
    --slurpfile baseline "$baseline_path" \
    --argjson schemaVersion 1 \
    --arg mode "$mode" \
    --arg baselinePath "$baseline_path" \
    '
      def budget($name):
        if $name == "shell_eval_traced" then
          {warnRatio:1.25, failRatio:1.5, warnMs:1500, failMs:3000}
        elif $name == "shell_eval_warm" then
          {warnRatio:1.5, failRatio:2.0, warnMs:500, failMs:1000}
        elif $name == "tasks_list" or $name == "processes_help" then
          {warnRatio:2.0, failRatio:3.0, warnMs:250, failMs:1000}
        else
          {warnRatio:1.5, failRatio:2.0, warnMs:1000, failMs:3000}
        end;
      def classify($name; $current; $baseline):
        budget($name) as $b
        | ($current - $baseline) as $delta
        | (if $baseline > 0 then ($current / $baseline) else null end) as $ratio
        | if $baseline <= 0 then "unknown"
          elif ($delta > $b.failMs and $current > ($baseline * $b.failRatio)) then "fail"
          elif ($delta > $b.warnMs and $current > ($baseline * $b.warnRatio)) then "warn"
          else "pass"
          end as $status
        | {status:$status, currentMs:$current, baselineMs:$baseline, deltaMs:$delta, ratio:$ratio, budget:$b};
      ($current[0].checks // {}) as $currentChecks
      | ($baseline[0].checks // {}) as $baselineChecks
      | (
          $currentChecks
          | to_entries
          | map(
              .key as $name
              | .value as $current
              | ($baselineChecks[$name] // null) as $base
              | {
                  key: $name,
                  value:
                    if $base == null then
                      {status:"missing_baseline", currentMs:$current.durationMs}
                    elif ($current.status != 0) then
                      {status:"current_failed", currentMs:$current.durationMs, baselineMs:$base.durationMs}
                    elif ($base.status != 0) then
                      {status:"baseline_failed", currentMs:$current.durationMs, baselineMs:$base.durationMs}
                    else
                      classify($name; $current.durationMs; $base.durationMs)
                    end
                }
            )
          | from_entries
        ) as $checks
      | (
          if any($checks[]; .status == "fail") then "fail"
          elif any($checks[]; .status == "warn") then "warn"
          elif any($checks[]; .status == "missing_baseline") then "partial"
          else "pass"
          end
        ) as $status
      | {schemaVersion:$schemaVersion, status:$status, mode:$mode, baseline:$baselinePath, checks:$checks}
    ' >"$ARTIFACT_DIR/perf-comparison.json"

  local status
  status="$(jq -r '.status' "$ARTIFACT_DIR/perf-comparison.json")"
  case "$status:$mode" in
    fail:fail)
      echo "::error::devenv perf regression detected"
      jq . "$ARTIFACT_DIR/perf-comparison.json"
      return 1
      ;;
    fail:*|warn:*)
      echo "::warning::devenv perf regression threshold exceeded"
      jq . "$ARTIFACT_DIR/perf-comparison.json"
      ;;
  esac
}

compare_baseline

if [ -n "${dollar}{GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Devenv perf"
    echo ""
    echo "| Probe | Status | Duration |"
    echo "| --- | ---: | ---: |"
    jq -r '.[] | "| \(.name) | \(.status) | \(.durationMs) ms |"' "$ARTIFACT_DIR/timings.json"
    echo ""
    echo "- Artifact directory: \`$ARTIFACT_DIR\`"
    echo "- OTEL service: \`${dollar}{OTEL_SERVICE_NAME:-unknown}\`"
    echo ""
    echo "#### Regression comparison"
    echo ""
    if [ -f "$ARTIFACT_DIR/perf-comparison.json" ]; then
      jq -r '["- Status: " + .status, "- Mode: " + .mode, "- Baseline: " + (.baseline // "none")] | .[]' "$ARTIFACT_DIR/perf-comparison.json"
    fi
  } >>"$GITHUB_STEP_SUMMARY"
fi

cat "$ARTIFACT_DIR/timings.pretty.json"
`
}

export const devenvPerfBenchmarkStep = (
  opts?: Pick<DevenvPerfJobOptions, 'taskProbes' | 'probes'>,
) =>
  ({
    name: 'Benchmark devenv surfaces',
    shell: 'bash',
    run: renderDevenvPerfScript({
      taskProbes: opts?.taskProbes ?? [],
      probes: opts?.probes ?? [],
    }),
  }) as const

export const devenvPerfArtifactStep = (
  opts?: Pick<DevenvPerfJobOptions, 'artifactDir' | 'artifactName' | 'retentionDays'>,
) =>
  ({
    name: 'Upload devenv perf artifacts',
    if: 'always()',
    uses: 'actions/upload-artifact@v4',
    with: {
      name:
        opts?.artifactName ??
        'devenv-perf-${{ github.job }}-${{ github.run_id }}-attempt-${{ github.run_attempt }}',
      path: opts?.artifactDir ?? 'tmp/devenv-perf-ci',
      'if-no-files-found': 'error',
      'retention-days': opts?.retentionDays ?? 30,
    },
  }) as const

export const nixClosureMeasurementStep = (opts: NixClosureMeasurementStepOptions) => {
  const artifactDir = opts.artifactDir ?? 'tmp/ci-measurements'
  const artifactFile = opts.artifactFile ?? '$ARTIFACT_DIR/measurements.json'
  const targetName = opts.targetName ?? opts.installable
  const buckets = JSON.stringify(opts.buckets ?? [])
  const targetSystemAssignment =
    opts.targetSystem === undefined
      ? `target_system="${dollar}{DEVENV_SYSTEM:-${dollar}{RUNNER_OS:-unknown}}"`
      : `target_system=${shellSingleQuote(opts.targetSystem)}`

  return {
    name: `Measure Nix closure: ${targetName}`,
    shell: 'bash',
    env: {
      ARTIFACT_DIR: artifactDir,
      RUNNER_CLASS: '${{ runner.os }}-${{ runner.arch }}',
    },
    run: String.raw`set -euo pipefail

mkdir -p "$ARTIFACT_DIR"
installable=${shellSingleQuote(opts.installable)}
target_name=${shellSingleQuote(targetName)}
artifact_file=${shellSingleQuote(artifactFile)}
${targetSystemAssignment}

out_path="$(nix build --no-link --print-out-paths "$installable")"
path_info="$ARTIFACT_DIR/nix-closure-path-info.json"
paths_file="$ARTIFACT_DIR/nix-closure-paths.json"

nix path-info --recursive --json "$out_path" >"$path_info"
jq 'to_entries | map({ path: .key, narSize: (.value.narSize // 0) })' "$path_info" >"$paths_file"

jq -n \
  --slurpfile paths "$paths_file" \
  --argjson schemaVersion 1 \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg repository "${dollar}{GITHUB_REPOSITORY:-unknown}" \
  --arg branchKind "${dollar}{GITHUB_EVENT_NAME:-unknown}" \
  --arg ref "${dollar}{GITHUB_REF:-unknown}" \
  --arg headSha "${dollar}{GITHUB_SHA:-unknown}" \
  --arg baseSha "${dollar}{GITHUB_BASE_SHA:-}" \
  --arg runnerName "${dollar}{RUNNER_NAME:-unknown}" \
  --arg runnerOs "${dollar}{RUNNER_OS:-unknown}" \
  --arg runnerArch "${dollar}{RUNNER_ARCH:-unknown}" \
  --arg runnerClass "${dollar}{RUNNER_CLASS:-unknown}" \
  --arg githubRunId "${dollar}{GITHUB_RUN_ID:-unknown}" \
  --arg githubRunAttempt "${dollar}{GITHUB_RUN_ATTEMPT:-unknown}" \
  --arg githubJob "${dollar}{GITHUB_JOB:-unknown}" \
  --arg taskId "${dollar}{CROSSTASK_TASK_ID:-}" \
  --arg taskAttemptId "${dollar}{CROSSTASK_ATTEMPT_ID:-}" \
  --arg traceId "${dollar}{TRACE_ID:-}" \
  --arg targetName "$target_name" \
  --arg targetSystem "$target_system" \
  --arg outPath "$out_path" \
  --argjson buckets ${shellSingleQuote(buckets)} \
  '
    ($paths[0] // []) as $closurePaths
    | ($closurePaths | map(.narSize) | add // 0) as $totalNarSize
    | ($closurePaths | length) as $pathCount
    | ($buckets | map(
        . as $bucket
        | {
            name: "nix.closure.bucket.nar_size",
            unit: "bytes",
            value: (
              $closurePaths
              | map(select(.path | test($bucket.pathRegex)) | .narSize)
              | add // 0
            ),
            dimensions: { bucket: $bucket.name }
          }
      )) as $bucketObservations
    | {
        schemaVersion: $schemaVersion,
        generatedAt: $generatedAt,
        producer: { name: "effect-utils-ci-measurement", version: 1 },
        subject: {
          repo: $repository,
          branchKind: (if $branchKind == "" then "unknown" else $branchKind end),
          ref: $ref,
          headSha: $headSha,
          baseSha: $baseSha
        },
        execution: {
          provider: (if ($githubRunId != "" and $githubRunId != "unknown") then "github-actions" else "local" end),
          workflow: "CI",
          job: $githubJob,
          runId: $githubRunId,
          runAttempt: $githubRunAttempt,
          taskId: $taskId,
          attemptId: $taskAttemptId,
          traceId: $traceId,
          runner: { name: $runnerName, os: $runnerOs, arch: $runnerArch, class: $runnerClass }
        },
        target: { kind: "nix-closure", name: $targetName, system: $targetSystem },
        observations: ([
          {
            name: "nix.closure.nar_size",
            unit: "bytes",
            value: $totalNarSize,
            dimensions: { bucket: "total" }
          },
          {
            name: "nix.closure.path_count",
            unit: "count",
            value: $pathCount,
            dimensions: { bucket: "total" }
          }
        ] + $bucketObservations),
        artifacts: [
          { name: "nix-closure-path-info", path: "nix-closure-path-info.json", contentType: "application/json" },
          { name: "nix-closure-paths", path: "nix-closure-paths.json", contentType: "application/json" }
        ],
        details: {
          outPath: $outPath,
          topPaths: ($closurePaths | sort_by(.narSize) | reverse | .[:30])
        }
      }
  ' >"$artifact_file"

cat "$artifact_file"
`,
  } as const
}

export const devenvPerfJob = (opts?: DevenvPerfJobOptions) => {
  const artifactDir = opts?.artifactDir ?? 'tmp/devenv-perf-ci'

  return {
    'runs-on': opts?.runsOn ?? linuxX64Runner,
    defaults: bashShellDefaults,
    env: {
      ...standardCIEnv,
      ARTIFACT_DIR: artifactDir,
      OTEL_SERVICE_NAME: 'devenv-perf-ci',
      DEVENV_PERF_REGRESSION_MODE: opts?.regressionMode ?? 'warn',
      RUNNER_CLASS: (opts?.runsOn ?? linuxX64Runner).join(','),
      ...opts?.env,
    },
    steps: [
      ...(opts?.setupSteps ?? [
        checkoutStep(),
        installNixStep(),
        preparePinnedDevenvStep,
        validateNixStoreStep,
      ]),
      devenvPerfBenchmarkStep({
        taskProbes: opts?.taskProbes,
        probes: opts?.probes,
      }),
      devenvPerfArtifactStep({
        artifactDir,
        artifactName: opts?.artifactName,
        retentionDays: opts?.retentionDays,
      }),
    ],
  } as const
}
