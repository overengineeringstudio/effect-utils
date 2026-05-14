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

export type CiMeasurementDescriptor = {
  readonly id: string
  readonly label: string
  readonly group?: string
  readonly description?: string
}

export type CiMeasurementGatePolicy = {
  readonly enabled?: boolean
  readonly minBaselineSources?: number
  readonly minCurrentSamples?: number
  readonly noiseFloor?: number
  readonly warnRatio?: number
  readonly failRatio?: number
  readonly warnAbs?: number
  readonly failAbs?: number
}

export type DevenvPerfProbe = CiMeasurementDescriptor & {
  readonly command: readonly [string, ...string[]]
  readonly traceOutput?: string
  readonly warmupRepetitions?: number
  readonly repetitions?: number
  readonly gate?: CiMeasurementGatePolicy
}

export type CiMeasurementObservation = {
  readonly id?: string
  readonly label?: string
  readonly group?: string
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
  readonly label?: string
  readonly pathRegex: string
}

export type NixClosureMeasurementStepOptions = {
  readonly installable: string
  readonly targetId?: string
  readonly targetName?: string
  readonly targetLabel?: string
  readonly targetGroup?: string
  readonly targetSystem?: string
  readonly artifactDir?: string
  readonly artifactFile?: string
  readonly buckets?: readonly NixClosureMeasurementBucket[]
}

export type GitHubPreviousArtifactStepOptions = {
  readonly artifactName: string
  readonly outputDir: string
  readonly workflowName?: string
  readonly branch?: string
  readonly seedRunIds?: readonly string[]
  readonly maxRuns?: number
  readonly tokenExpression?: string
}

export type CiMeasurementsComparisonStepOptions = {
  readonly currentDir?: string
  readonly baselineDir?: string
  readonly outputFile?: string
  readonly regressionMode?: 'off' | 'warn' | 'fail'
  readonly prComment?: {
    readonly enabled?: boolean
    readonly title?: string
    readonly maxRows?: number
    readonly maxHistory?: number
    readonly assetBranch?: string
    readonly tokenExpression?: string
  }
}

export type CiMeasurementsArtifactStepOptions = {
  readonly artifactName: string
  readonly path: string
  readonly retentionDays?: number
}

/** Job-level permissions required when CI measurement comparison posts PR comments. */
export const ciMeasurementsCommentPermissions = {
  contents: 'write',
  issues: 'write',
  'pull-requests': 'write',
} as const

type DevenvPerfSetupStep = GitHubWorkflowArgs['jobs'][string]['steps'][number]
export type DevenvPerfTaskProbe =
  | string
  | {
      readonly task: string
      readonly id?: string
      readonly label?: string
      readonly group?: string
      readonly description?: string
      readonly warmupRepetitions?: number
      readonly repetitions?: number
      readonly gate?: CiMeasurementGatePolicy
    }

export type DevenvPerfJobOptions = {
  readonly runsOn?: readonly string[]
  readonly artifactDir?: string
  readonly artifactName?: string
  readonly baselineArtifactName?: string
  readonly baselineSeedRunIds?: readonly string[]
  readonly baselineMaxRuns?: number
  readonly setupSteps?: readonly DevenvPerfSetupStep[]
  readonly env?: Record<string, string>
  readonly taskProbes?: readonly DevenvPerfTaskProbe[]
  readonly probes?: readonly DevenvPerfProbe[]
  readonly retentionDays?: number
  readonly regressionMode?: 'off' | 'warn' | 'fail'
  readonly prComment?: CiMeasurementsComparisonStepOptions['prComment']
  readonly permissions?: GitHubWorkflowArgs['jobs'][string]['permissions']
}

const defaultDevenvPerfGatePolicy = (probeId: string): CiMeasurementGatePolicy => {
  if (probeId === 'shell_eval_traced') {
    return {
      enabled: false,
      minBaselineSources: 10,
      minCurrentSamples: 3,
      warnRatio: 1.25,
      failRatio: 1.5,
      warnAbs: 1.5,
      failAbs: 3,
      noiseFloor: 0.5,
    }
  }
  if (probeId === 'tasks_list' || probeId === 'processes_help') {
    return {
      enabled: true,
      minBaselineSources: 10,
      minCurrentSamples: 5,
      warnRatio: 2,
      failRatio: 3,
      warnAbs: 0.25,
      failAbs: 1,
      noiseFloor: 0.1,
    }
  }
  return {
    enabled: true,
    minBaselineSources: 10,
    minCurrentSamples: 5,
    warnRatio: 1.1,
    failRatio: 1.2,
    warnAbs: 0.25,
    failAbs: 0.5,
    noiseFloor: 0.1,
  }
}

const devenvPerfGatePolicy = (probe: Pick<DevenvPerfProbe, 'id' | 'gate'>) => ({
  ...defaultDevenvPerfGatePolicy(probe.id),
  ...probe.gate,
})

const devenvPerfProbeLine = (probe: DevenvPerfProbe) => {
  const args = probe.command.map(shellSingleQuote).join(' ')
  const trace = probe.traceOutput ?? ''
  const gatePolicy = devenvPerfGatePolicy(probe)
  const defaultRepetitions = gatePolicy.enabled ? gatePolicy.minCurrentSamples : 1
  const repetitions = Math.max(1, Math.floor(probe.repetitions ?? defaultRepetitions))
  const defaultWarmupRepetitions = gatePolicy.enabled && repetitions > 1 ? 1 : 0
  const warmupRepetitions = Math.max(0, Math.floor(probe.warmupRepetitions ?? defaultWarmupRepetitions))
  return `measure ${shellSingleQuote(probe.id)} ${shellSingleQuote(probe.label)} ${shellSingleQuote(probe.group ?? '')} ${shellSingleQuote(probe.description ?? '')} ${shellSingleQuote(trace)} ${shellSingleQuote(String(warmupRepetitions))} ${shellSingleQuote(String(repetitions))} ${shellSingleQuote(JSON.stringify(gatePolicy))} ${args}`
}

const defaultDevenvPerfTaskProbe = (probe: DevenvPerfTaskProbe): DevenvPerfProbe => {
  const task = typeof probe === 'string' ? probe : probe.task
  const id = typeof probe === 'string' ? undefined : probe.id
  const label = typeof probe === 'string' ? undefined : probe.label
  const group = typeof probe === 'string' ? undefined : probe.group
  const description = typeof probe === 'string' ? undefined : probe.description
  const warmupRepetitions = typeof probe === 'string' ? undefined : probe.warmupRepetitions
  const repetitions = typeof probe === 'string' ? undefined : probe.repetitions
  const gate = typeof probe === 'string' ? undefined : probe.gate
  return {
    id: id ?? `task_${task.replaceAll(':', '_')}`,
    label: label ?? task,
    group: group ?? 'devenv tasks',
    description: description ?? `Runs the devenv task '${task}' in before mode without the TUI.`,
    warmupRepetitions,
    repetitions,
    gate,
    command: ['$DEVENV_BIN', 'tasks', 'run', task, '--mode', 'before', '--no-tui', '--show-output'],
  }
}

const renderDevenvPerfScript = (
  opts: Required<Pick<DevenvPerfJobOptions, 'taskProbes' | 'probes'>>,
) => {
  const probes: readonly DevenvPerfProbe[] = [
    {
      id: 'shell_eval_traced',
      label: 'Shell eval with OTEL trace',
      group: 'devenv shell',
      description: 'Evaluates the dev shell with native devenv JSON tracing enabled.',
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
    {
      id: 'shell_eval_warm',
      label: 'Warm shell eval',
      group: 'devenv shell',
      description: 'Evaluates a warm dev shell without reloading direnv state.',
      warmupRepetitions: 1,
      repetitions: 5,
      command: ['$DEVENV_BIN', 'shell', '--no-reload', '--', 'true'],
    },
    {
      id: 'tasks_list',
      label: 'devenv tasks list',
      group: 'devenv cli',
      description: 'Lists devenv tasks to measure task graph loading overhead.',
      warmupRepetitions: 1,
      repetitions: 9,
      command: ['$DEVENV_BIN', 'tasks', 'list'],
    },
    {
      id: 'processes_help',
      label: 'devenv processes --help',
      group: 'devenv cli',
      description: 'Loads the devenv processes command help path.',
      warmupRepetitions: 1,
      repetitions: 9,
      command: ['$DEVENV_BIN', 'processes', '--help'],
    },
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
  printf 'runner_class=%s\n' "${dollar}{RUNNER_CLASS:-unknown}"
  printf 'cpu_count=%s\n' "$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || printf unknown)"
  printf 'load_average=%s\n' "$(cat /proc/loadavg 2>/dev/null || uptime 2>/dev/null || printf unknown)"
  printf 'memory=%s\n' "$(free -h 2>/dev/null | tr '\n' ';' || printf unknown)"
  printf 'cpu_model=%s\n' "$(awk -F ': ' '/model name|Hardware|Processor/ { print $2; exit }' /proc/cpuinfo 2>/dev/null || printf unknown)"
  printf 'devenv_rev=%s\n' "${dollar}{DEVENV_REV:-unknown}"
  printf 'otel_service_name=%s\n' "${dollar}{OTEL_SERVICE_NAME:-unknown}"
  nix store ping 2>/dev/null || true
  nix config show substituters trusted-substituters builders max-jobs cores 2>/dev/null || true
  df -h / /nix 2>/dev/null || df -h /
  ps -eo pid,ppid,stat,etime,pcpu,pmem,comm,args 2>/dev/null \
    | grep -E 'devenv direnv-export|nix-daemon|nix build|nix flake|github-runner' \
    | grep -v grep || true
} >"$ARTIFACT_DIR/host-context.txt"

printf '[' >"$ARTIFACT_DIR/timings.json"
first=1

json_append_timing() {
  local id="$1"
  local label="$2"
  local group="$3"
  local description="$4"
  local status="$5"
  local duration_ms="$6"
  local stdout="$7"
  local stderr="$8"
  local trace="$9"
  local gate_policy="${dollar}{10}"
  local samples_file="$ARTIFACT_DIR/$id.samples.json"

  if [ "$first" -eq 0 ]; then
    printf ',' >>"$ARTIFACT_DIR/timings.json"
  fi
  first=0

  jq -cn \
    --slurpfile samples "$samples_file" \
    --arg id "$id" \
    --arg label "$label" \
    --arg group "$group" \
    --arg description "$description" \
    --argjson status "$status" \
      --argjson durationMs "$duration_ms" \
      --arg stdout "$stdout" \
      --arg stderr "$stderr" \
      --arg trace "$trace" \
      --argjson gatePolicy "$gate_policy" \
      '($samples[0] // []) as $sampleList
      | ($sampleList | map(select(.phase != "warmup" and .status == 0) | .durationMs)) as $successfulDurations
      | ($sampleList | map(select(.phase == "warmup"))) as $warmupSamples
      | {
        id:$id,
        name:$id,
        label:$label,
        group:(if $group == "" then null else $group end),
        description:(if $description == "" then null else $description end),
        status:$status,
        durationMs:$durationMs,
        stdout:$stdout,
        stderr:$stderr,
          trace:(if $trace == "" then null else $trace end),
          gatePolicy:$gatePolicy,
          statistics: {
          sampleCount: ($sampleList | length),
          warmupCount: ($warmupSamples | length),
          measuredSampleCount: (($sampleList | length) - ($warmupSamples | length)),
          successfulSampleCount: ($successfulDurations | length),
          minDurationMs: ($successfulDurations | min),
          maxDurationMs: ($successfulDurations | max),
          medianDurationMs: $durationMs
        },
        samples:$sampleList
      }' \
    >>"$ARTIFACT_DIR/timings.json"
}

measure() {
  local id="$1"
  local label="$2"
  local group="$3"
    local description="$4"
    local trace_file="$5"
    local warmup_repetitions="$6"
    local repetitions="$7"
    local gate_policy="$8"
    shift 8
  case "$trace_file" in
    '$ARTIFACT_DIR'*) trace_file="${dollar}{ARTIFACT_DIR}${dollar}{trace_file#'$ARTIFACT_DIR'}" ;;
  esac
  local stdout="$ARTIFACT_DIR/$id.stdout"
  local stderr="$ARTIFACT_DIR/$id.stderr"
  local samples_file="$ARTIFACT_DIR/$id.samples.json"
  local started ended status duration_ms

  mkdir -p "$(dirname "$trace_file")"
  if ! [[ "$repetitions" =~ ^[0-9]+$ ]] || [ "$repetitions" -lt 1 ]; then
    repetitions=1
  fi
  if ! [[ "$warmup_repetitions" =~ ^[0-9]+$ ]] || [ "$warmup_repetitions" -lt 0 ]; then
    warmup_repetitions=0
  fi

  printf '[' >"$samples_file"
  local sample_first=1
  local sample_index measured_index total_repetitions phase sample_stdout sample_stderr sample_trace expanded
  total_repetitions=$((warmup_repetitions + repetitions))
  for sample_index in $(seq 1 "$total_repetitions"); do
    if [ "$sample_index" -le "$warmup_repetitions" ]; then
      phase="warmup"
      measured_index=""
    else
      phase="measured"
      measured_index=$((sample_index - warmup_repetitions))
    fi
    sample_stdout="$ARTIFACT_DIR/$id.$sample_index.stdout"
    sample_stderr="$ARTIFACT_DIR/$id.$sample_index.stderr"
    sample_trace=""
    if [ -n "$trace_file" ]; then
      sample_trace="$trace_file"
      if [ "$repetitions" -gt 1 ]; then
        sample_trace="${dollar}{trace_file%.*}.$sample_index.${dollar}{trace_file##*.}"
      fi
    fi

    started="$(date +%s%3N)"
    set +e
    expanded=()
    for arg in "$@"; do
      case "$arg" in
        '$DEVENV_BIN') expanded+=("${dollar}{DEVENV_BIN:?DEVENV_BIN not set}") ;;
        '$ARTIFACT_DIR'*) expanded+=("${dollar}{ARTIFACT_DIR}${dollar}{arg#'$ARTIFACT_DIR'}") ;;
        'json:file:$trace_file') expanded+=("json:file:$sample_trace") ;;
        '$trace_file') expanded+=("file:$sample_trace") ;;
        *) expanded+=("$arg") ;;
      esac
    done
    "${dollar}{expanded[@]}" >"$sample_stdout" 2>"$sample_stderr"
    status=$?
    set -e
    ended="$(date +%s%3N)"
    duration_ms=$((ended - started))

    if [ "$sample_first" -eq 0 ]; then
      printf ',' >>"$samples_file"
    fi
    sample_first=0
    jq -cn \
      --argjson index "$sample_index" \
      --arg measuredIndex "$measured_index" \
      --arg phase "$phase" \
      --argjson status "$status" \
      --argjson durationMs "$duration_ms" \
      --arg stdout "$sample_stdout" \
      --arg stderr "$sample_stderr" \
      --arg trace "$sample_trace" \
      '{index:$index,measuredIndex:(if $measuredIndex == "" then null else ($measuredIndex | tonumber) end),phase:$phase,status:$status,durationMs:$durationMs,stdout:$stdout,stderr:$stderr,trace:(if $trace == "" then null else $trace end)}' \
      >>"$samples_file"

    stdout="$sample_stdout"
    stderr="$sample_stderr"
    trace_file="$sample_trace"

    if [ "$status" -ne 0 ]; then
      break
    fi
  done
  printf ']\n' >>"$samples_file"

  status="$(jq -r 'map(.status) | max // 0' "$samples_file")"
  duration_ms="$(jq -r 'map(select(.phase != "warmup" and .status == 0) | .durationMs) as $values | if ($values | length) == 0 then (map(.durationMs) | max // 0) else ($values | sort | .[(length - 1) / 2 | floor]) end' "$samples_file")"

  cp "$stdout" "$ARTIFACT_DIR/$id.stdout" 2>/dev/null || true
  cp "$stderr" "$ARTIFACT_DIR/$id.stderr" 2>/dev/null || true

  json_append_timing "$id" "$label" "$group" "$description" "$status" "$duration_ms" "$ARTIFACT_DIR/$id.stdout" "$ARTIFACT_DIR/$id.stderr" "$trace_file" "$gate_policy"

  if [ "$status" -ne 0 ]; then
    echo "::error::$id failed after ${dollar}{duration_ms}ms; stderr tail follows"
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
    checks: ($timings[0] | map({ key: .id, value: . }) | from_entries)
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
    producer: {
      name: "effect-utils-ci-measurement",
      version: 2,
      measurementProtocol: "devenv-perf-warm-median-v2"
    },
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
    target: { kind: "devenv", id: "dev-shell", name: "dev-shell", label: "Dev shell", group: "devenv", system: $targetSystem },
    observations: (
      $timings[0]
      | map({
          id: ("devenv." + .id + ".duration"),
          label: .label,
          group: .group,
          name: ("devenv." + .id + ".duration"),
          unit: "seconds",
            value: (.durationMs / 1000),
            policy: .gatePolicy,
            statistics: {
            sampleCount: (.statistics.sampleCount // 1),
            warmupCount: (.statistics.warmupCount // 0),
            measuredSampleCount: (.statistics.measuredSampleCount // (.statistics.sampleCount // 1)),
            successfulSampleCount: (.statistics.successfulSampleCount // (if .status == 0 then 1 else 0 end)),
            min: ((.statistics.minDurationMs // .durationMs) / 1000),
            max: ((.statistics.maxDurationMs // .durationMs) / 1000),
            median: ((.statistics.medianDurationMs // .durationMs) / 1000)
          },
          dimensions: {
            probe: .id,
            probeLabel: .label,
            status: .status,
            sampleCount: (.statistics.sampleCount // 1),
            warmupCount: (.statistics.warmupCount // 0),
            measuredSampleCount: (.statistics.measuredSampleCount // (.statistics.sampleCount // 1)),
            measurementProtocol: "devenv-perf-warm-median-v2",
            aggregation: "median",
            phase: "warm",
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
        | map({ key: .id, value: { label: .label, group: .group, description: .description, stdout: .stdout, stderr: .stderr, trace: .trace } })
        | from_entries
      )
    }
  }' >"$ARTIFACT_DIR/measurements.json"

if [ -n "${dollar}{GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Devenv perf"
    echo ""
    echo "| Probe | Status | Duration |"
    echo "| --- | ---: | ---: |"
    jq -r '.[] | "| \(.label // .id) | \(.status) | \(.durationMs) ms |"' "$ARTIFACT_DIR/timings.json"
    echo ""
    echo "- Artifact directory: \`$ARTIFACT_DIR\`"
    echo "- OTEL service: \`${dollar}{OTEL_SERVICE_NAME:-unknown}\`"
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

export const downloadPreviousGitHubArtifactStep = (opts: GitHubPreviousArtifactStepOptions) =>
  ({
    name: `Download previous artifact: ${opts.artifactName}`,
    shell: 'bash',
    env: {
      GH_TOKEN: opts.tokenExpression ?? '${{ github.token }}',
      BASELINE_ARTIFACT_NAME: opts.artifactName,
      BASELINE_OUTPUT_DIR: opts.outputDir,
      BASELINE_WORKFLOW_NAME: opts.workflowName ?? '${{ github.workflow }}',
      BASELINE_BRANCH: opts.branch ?? '${{ github.base_ref || github.ref_name }}',
      BASELINE_SEED_RUN_IDS: opts.seedRunIds?.join(' ') ?? '',
      BASELINE_MAX_RUNS: String(opts.maxRuns ?? 5),
    },
    run: String.raw`set -euo pipefail

mkdir -p "$BASELINE_OUTPUT_DIR"

if ! command -v gh >/dev/null 2>&1; then
  echo "::notice::gh is not available; skipping previous artifact download"
  exit 0
fi

repo="${dollar}{GITHUB_REPOSITORY:?GITHUB_REPOSITORY not set}"
workflow="${dollar}{BASELINE_WORKFLOW_NAME:-CI}"
branch="${dollar}{BASELINE_BRANCH:-${dollar}{GITHUB_BASE_REF:-${dollar}{GITHUB_REF_NAME:-main}}}"

candidate_runs="$(
  gh run list \
    --repo "$repo" \
    --workflow "$workflow" \
    --branch "$branch" \
    --event push \
    --status success \
    --json databaseId,headSha \
    --limit 20 \
    --jq '[.[] | select(.headSha != env.GITHUB_SHA) | .databaseId] | .[]'
)"

candidate_runs="$candidate_runs
$BASELINE_SEED_RUN_IDS"

max_runs="${dollar}{BASELINE_MAX_RUNS:-5}"
if ! [[ "$max_runs" =~ ^[0-9]+$ ]] || [ "$max_runs" -lt 1 ]; then
  max_runs=1
fi

run_id=""
artifact_name=""
artifact_id=""
downloaded_runs_file="$BASELINE_OUTPUT_DIR/baseline-runs.jsonl"
seen_runs_file="$BASELINE_OUTPUT_DIR/baseline-seen-runs.txt"
: >"$downloaded_runs_file"
: >"$seen_runs_file"
for candidate_run in $candidate_runs; do
  if [ -z "$candidate_run" ]; then
    continue
  fi
  if grep -qxF "$candidate_run" "$seen_runs_file"; then
    continue
  fi
  printf '%s\n' "$candidate_run" >>"$seen_runs_file"
  if [ "$(wc -l <"$downloaded_runs_file" | tr -d ' ')" -ge "$max_runs" ]; then
    break
  fi

  artifact_json="$(
    gh api "repos/$repo/actions/runs/$candidate_run/artifacts" \
      --jq '.artifacts
        | map(select(.expired == false))
        | map(select(.name == env.BASELINE_ARTIFACT_NAME or (.name | startswith(env.BASELINE_ARTIFACT_NAME + "-"))))
        | sort_by(.created_at // "")
        | reverse
        | .[0] // empty'
  )"

  if [ -n "$artifact_json" ]; then
    current_artifact_name="$(printf '%s' "$artifact_json" | jq -r '.name')"
    current_artifact_id="$(printf '%s' "$artifact_json" | jq -r '.id')"
    current_output_dir="$BASELINE_OUTPUT_DIR/run-$candidate_run"
    mkdir -p "$current_output_dir"
    if gh run download "$candidate_run" \
      --repo "$repo" \
      --name "$current_artifact_name" \
      --dir "$current_output_dir"; then
      if [ -z "$run_id" ]; then
        run_id="$candidate_run"
        artifact_name="$current_artifact_name"
        artifact_id="$current_artifact_id"
      fi
      jq -cn \
        --arg runId "$candidate_run" \
        --arg artifactName "$current_artifact_name" \
        --arg artifactId "$current_artifact_id" \
        --arg path "run-$candidate_run" \
        '{runId:$runId, artifactName:$artifactName, artifactId:$artifactId, path:$path}' \
        >>"$downloaded_runs_file"
    else
      echo "::notice::failed to download baseline artifact $current_artifact_name from run $candidate_run"
    fi
  fi
done

if [ -z "$run_id" ] || [ -z "$artifact_name" ]; then
  echo "::notice::no successful baseline run found for $repo workflow=$workflow branch=$branch"
  exit 0
fi

jq -n \
  --slurpfile runs "$downloaded_runs_file" \
  --argjson schemaVersion 1 \
  --arg repository "$repo" \
  --arg workflow "$workflow" \
  --arg branch "$branch" \
  --arg runId "$run_id" \
  --arg artifactName "$artifact_name" \
  --arg artifactId "$artifact_id" \
  '{
    schemaVersion: $schemaVersion,
    source: "github-actions-artifact",
    repository: $repository,
    workflow: $workflow,
    branch: $branch,
    runId: $runId,
    artifactName: $artifactName,
    artifactId: $artifactId,
    runs: $runs
  }' >"$BASELINE_OUTPUT_DIR/baseline-provenance.json"

echo "Downloaded $(wc -l <"$downloaded_runs_file" | tr -d ' ') baseline artifact(s), latest $artifact_name from run $run_id into $BASELINE_OUTPUT_DIR"
`,
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

export const ciMeasurementsArtifactStep = (opts: CiMeasurementsArtifactStepOptions) =>
  ({
    name: `Upload CI measurements: ${opts.artifactName}`,
    if: 'always()',
    uses: 'actions/upload-artifact@v4',
    with: {
      name: opts.artifactName,
      path: opts.path,
      'if-no-files-found': 'error',
      'retention-days': opts.retentionDays ?? 30,
    },
  }) as const

export const nixClosureMeasurementStep = (opts: NixClosureMeasurementStepOptions) => {
  const artifactDir = opts.artifactDir ?? 'tmp/ci-measurements'
  const artifactFileAssignment =
    opts.artifactFile === undefined
      ? '"$ARTIFACT_DIR/measurements.json"'
      : shellSingleQuote(opts.artifactFile)
  const targetName = opts.targetName ?? opts.installable
  const targetId = opts.targetId ?? targetName
  const targetLabel = opts.targetLabel ?? targetName
  const targetGroup = opts.targetGroup ?? 'nix closure'
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
target_id=${shellSingleQuote(targetId)}
target_name=${shellSingleQuote(targetName)}
target_label=${shellSingleQuote(targetLabel)}
target_group=${shellSingleQuote(targetGroup)}
artifact_file=${artifactFileAssignment}
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
  --arg targetId "$target_id" \
  --arg targetLabel "$target_label" \
  --arg targetGroup "$target_group" \
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
            id: "nix.closure.bucket.nar_size",
            label: (($bucket.label // $bucket.name) + " closure size"),
            group: "nix closure buckets",
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
        target: { kind: "nix-closure", id: $targetId, name: $targetName, label: $targetLabel, group: $targetGroup, system: $targetSystem },
        observations: ([
          {
            id: "nix.closure.nar_size",
            label: "Total closure size",
            group: "nix closure",
            name: "nix.closure.nar_size",
            unit: "bytes",
            value: $totalNarSize,
            dimensions: { bucket: "total" }
          },
          {
            id: "nix.closure.path_count",
            label: "Total closure path count",
            group: "nix closure",
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

export const compareCiMeasurementsStep = (opts?: CiMeasurementsComparisonStepOptions) =>
  ({
    name: 'Compare CI measurements with baseline',
    shell: 'bash',
    env: {
      CI_MEASUREMENT_CURRENT_DIR: opts?.currentDir ?? 'tmp/ci-measurements/current',
      CI_MEASUREMENT_BASELINE_DIR: opts?.baselineDir ?? 'tmp/ci-measurements/baseline',
      CI_MEASUREMENT_COMPARISON_FILE:
        opts?.outputFile ?? 'tmp/ci-measurements/measurement-comparison.json',
      CI_MEASUREMENT_REGRESSION_MODE: opts?.regressionMode ?? 'warn',
      CI_MEASUREMENT_PR_COMMENT_ENABLED: opts?.prComment?.enabled === true ? 'true' : 'false',
      CI_MEASUREMENT_PR_COMMENT_TITLE: opts?.prComment?.title ?? 'CI Measurements',
      CI_MEASUREMENT_PR_COMMENT_MAX_ROWS: String(opts?.prComment?.maxRows ?? 10),
      CI_MEASUREMENT_PR_COMMENT_MAX_HISTORY: String(opts?.prComment?.maxHistory ?? 20),
      CI_MEASUREMENT_PR_COMMENT_ASSET_BRANCH:
        opts?.prComment?.assetBranch ?? 'ci-measurement-assets',
      ...(opts?.prComment?.tokenExpression === undefined
        ? {}
        : { GH_TOKEN: opts.prComment.tokenExpression }),
    },
    run: String.raw`set -euo pipefail

export PATH="/run/current-system/sw/bin:/usr/bin:/bin:$PATH"

current_dir="${dollar}{CI_MEASUREMENT_CURRENT_DIR:?CI_MEASUREMENT_CURRENT_DIR not set}"
baseline_dir="${dollar}{CI_MEASUREMENT_BASELINE_DIR:?CI_MEASUREMENT_BASELINE_DIR not set}"
comparison_file="${dollar}{CI_MEASUREMENT_COMPARISON_FILE:?CI_MEASUREMENT_COMPARISON_FILE not set}"
mode="${dollar}{CI_MEASUREMENT_REGRESSION_MODE:-warn}"
mkdir -p "$(dirname "$comparison_file")"

if [ "$mode" = "off" ]; then
  jq -n --argjson schemaVersion 1 --arg status skipped --arg mode "$mode" \
    '{schemaVersion:$schemaVersion,status:$status,mode:$mode,comparisons:{}}' \
    >"$comparison_file"
  exit 0
fi

current_index="$(mktemp)"
baseline_index="$(mktemp)"
find "$current_dir" -path "$baseline_dir" -prune -o -name measurements.json -type f -print | sort >"$current_index" || true
{
  find "$baseline_dir" -maxdepth 1 -name measurements.json -type f -print
  find "$baseline_dir" -mindepth 2 -maxdepth 2 -name measurements.json -type f -print
} | sort -u >"$baseline_index" || true

if [ ! -s "$current_index" ]; then
  echo "::error::no current measurements.json files found under $current_dir"
  exit 1
fi

current_json="$comparison_file.current.json"
baseline_json="$comparison_file.baseline.json"
xargs -r jq -s '.' <"$current_index" >"$current_json"
if [ -s "$baseline_index" ]; then
  xargs -r jq -s '.' <"$baseline_index" >"$baseline_json"
else
  printf '[]\n' >"$baseline_json"
fi

jq -n \
  --slurpfile current "$current_json" \
  --slurpfile baseline "$baseline_json" \
  --argjson schemaVersion 1 \
  --arg mode "$mode" \
  --arg currentDir "$current_dir" \
  --arg baselineDir "$baseline_dir" \
  '
    def identity_dimensions:
      (.dimensions // {})
      | to_entries
      | map(select(.key as $key | ["devenvRev", "otelServiceName", "status", "probeLabel", "sampleCount", "measuredSampleCount"] | index($key) | not))
      | sort_by(.key)
      | map("\(.key)=\(.value|tostring)")
      | join(",");

    def observation_key($doc):
      [
        ($doc.target.kind // "unknown"),
        ($doc.target.id // $doc.target.name // "unknown"),
        ($doc.target.system // "unknown"),
        (.id // .name // "unknown"),
        (.unit // "unknown"),
        identity_dimensions
      ] | join("|");

    def median:
      sort as $sorted
      | ($sorted | length) as $count
      | if $count == 0 then null
        elif ($count % 2) == 1 then $sorted[($count / 2 | floor)]
        else (($sorted[($count / 2 - 1)] + $sorted[($count / 2)]) / 2)
        end;

    def percentile($p):
      sort as $sorted
      | ($sorted | length) as $count
      | if $count == 0 then null
        else $sorted[(($p * ($count - 1)) | floor)]
        end;

    def observations_by_key($docs):
      reduce $docs[]? as $doc
        ({};
          reduce (($doc.observations // [])[]? | select(.value | type == "number")) as $obs
            (.;
              ($obs | observation_key($doc)) as $key
              | .[$key] = ((.[$key] // []) + [{
                  target: $doc.target,
                  observation: $obs,
                  generatedAt: $doc.generatedAt
                }])
            )
        );

    def observation_stats($items):
      ($items | map(.observation.value)) as $values
      | ($items | map(.observation.statistics.measuredSampleCount // .observation.statistics.sampleCount // 1) | add // ($items | length)) as $sampleCount
      | {
          target: ($items[0].target // {}),
          observation: ($items[-1].observation // {}),
          value: ($values | median),
          min: ($values | min),
          max: ($values | max),
          p95: ($values | percentile(0.95)),
          sourceCount: ($items | length),
          sampleCount: $sampleCount,
          generatedAt: ($items[-1].generatedAt // null)
        };

    def budget($metric; $unit):
      if $metric == "nix.closure.nar_size" then
        {warnRatio:1.10, failRatio:1.25, warnAbs:52428800, failAbs:209715200}
      elif $metric == "nix.closure.bucket.nar_size" then
        {warnRatio:1.15, failRatio:1.35, warnAbs:52428800, failAbs:209715200}
      elif $metric == "nix.closure.path_count" then
        {warnRatio:1.10, failRatio:1.25, warnAbs:100, failAbs:500}
      elif $unit == "seconds" then
        {warnRatio:1.10, failRatio:1.20, warnAbs:0.25, failAbs:0.5}
      else
        {warnRatio:1.25, failRatio:1.50, warnAbs:1, failAbs:3}
      end;

    def noise_floor($metric; $unit):
      if $metric == "nix.closure.nar_size" or $metric == "nix.closure.bucket.nar_size" then 10485760
      elif $metric == "nix.closure.path_count" then 10
      elif $unit == "seconds" then 0.1
      else 0
      end;
    def default_policy($metric; $unit):
      budget($metric; $unit) as $b
      | noise_floor($metric; $unit) as $noise
      | $b + {
          enabled:true,
          minBaselineSources:(if $metric == "nix.closure.nar_size" or $metric == "nix.closure.bucket.nar_size" or $metric == "nix.closure.path_count" then 3 else 10 end),
          minCurrentSamples:(if $unit == "seconds" then 3 else 1 end),
          noiseFloor:$noise
        };
    def observation_policy($obs):
      default_policy($obs.name // "unknown"; $obs.unit // "unknown") + ($obs.policy // {});
    def policy_enabled($policy):
      if ($policy | has("enabled")) then $policy.enabled else true end;
    def abs_value: if . < 0 then -. else . end;

    def classify($metric; $unit; $policy; $current; $baseline; $baselineMin; $baselineMax; $baselineP95; $currentSamples; $baselineSources):
      $policy as $b
      | ($policy.noiseFloor // noise_floor($metric; $unit)) as $noise
      | ($current - $baseline) as $delta
      | (if $baseline > 0 then ($current / $baseline) else null end) as $ratio
      | (
          $baselineMin != null
          and $baselineMax != null
          and $current >= $baselineMin
          and $current <= $baselineMax
        ) as $withinBaselineRange
      | (
          if $baseline <= 0 then "unknown"
          elif ($delta > $b.failAbs and $current > ($baseline * $b.failRatio)) then "fail"
          elif ($delta > $b.warnAbs and $current > ($baseline * $b.warnRatio)) then "warn"
          else "pass"
          end
        ) as $thresholdStatus
      | (
          policy_enabled($policy) == true
          and $baseline > 0
          and $baselineSources >= ($policy.minBaselineSources // 1)
          and $currentSamples >= ($policy.minCurrentSamples // 1)
        ) as $gateable
      | (
          if (policy_enabled($policy) != true) then "disabled"
          elif $baseline <= 0 then "missing_baseline"
          elif $baselineSources < ($policy.minBaselineSources // 1) then "low_baseline_count"
          elif $currentSamples < ($policy.minCurrentSamples // 1) then "low_current_sample_count"
          else "eligible"
          end
        ) as $gateReason
      | (
          if $baseline <= 0 then "unknown"
          elif (policy_enabled($policy) != true) then "diagnostic"
          elif ($delta | abs_value) <= $noise then "noise_floor"
          elif ($withinBaselineRange and $thresholdStatus == "pass") then "within_baseline_range"
          elif $baselineSources < ($policy.minBaselineSources // 1) then "low_baseline_count"
          elif $currentSamples < ($policy.minCurrentSamples // 1) then "low_current_sample_count"
          elif $thresholdStatus == "pass" then "within_budget"
          elif ($baselineP95 != null and $current <= $baselineP95) then "within_baseline_distribution"
          else "threshold_exceeded"
          end
        ) as $confidence
      | (
          if ($gateable and $confidence == "threshold_exceeded") then $thresholdStatus
          elif $thresholdStatus == "unknown" then "unknown"
          else "pass"
          end
        ) as $status
      | (
          if $baseline <= 0 then "unknown"
          elif ($delta | abs_value) <= $noise then "unchanged"
          elif ($withinBaselineRange and $thresholdStatus == "pass") then "unchanged"
          elif $delta < 0 then "improved"
          else "regressed"
          end
        ) as $direction
      | {status:$status,current:$current,baseline:$baseline,delta:$delta,ratio:$ratio,budget:$b,gatePolicy:$policy,gateable:$gateable,gateReason:$gateReason,confidence:$confidence,direction:$direction};

    (observations_by_key($current[0]) | with_entries(.value = observation_stats(.value))) as $currentObs
    | (observations_by_key($baseline[0]) | with_entries(.value = observation_stats(.value))) as $baselineObs
    | (
        $currentObs
        | to_entries
        | map(
            .key as $key
            | .value as $currentValue
            | ($baselineObs[$key] // null) as $baselineValue
            | {
                key: $key,
                value: (
                  if $baselineValue == null then
                    {
                      status: "missing_baseline",
                      target: $currentValue.target,
                      observation: $currentValue.observation,
                        current: $currentValue.value,
                        currentSamples: $currentValue.sampleCount,
                        baselineSources: 0,
                        gatePolicy: ($currentValue.observation | observation_policy(.)),
                        gateable: false,
                        gateReason: "missing_baseline",
                        confidence: "missing_baseline",
                        direction: "unknown"
                      }
                    else
                      classify(
                        $currentValue.observation.name;
                        $currentValue.observation.unit;
                        ($currentValue.observation | observation_policy(.));
                        $currentValue.value;
                        $baselineValue.value;
                        $baselineValue.min;
                        $baselineValue.max;
                        $baselineValue.p95;
                        $currentValue.sampleCount;
                        $baselineValue.sourceCount
                      ) + {
                      target: $currentValue.target,
                      observation: $currentValue.observation,
                        currentSamples: $currentValue.sampleCount,
                        baselineSources: $baselineValue.sourceCount,
                        baselineMin: $baselineValue.min,
                        baselineMax: $baselineValue.max,
                        baselineP95: $baselineValue.p95
                      }
                  end
                )
              }
          )
        | from_entries
      ) as $comparisons
    | (
        if any($comparisons[]?; .status == "fail") then "fail"
        elif any($comparisons[]?; .status == "warn") then "warn"
        elif any($comparisons[]?; .status == "missing_baseline" and (if (.gatePolicy | has("enabled")) then .gatePolicy.enabled else true end)) then "partial"
        else "pass"
        end
      ) as $status
    | {
        schemaVersion:$schemaVersion,
        status:$status,
        mode:$mode,
        currentDir:$currentDir,
        baselineDir:$baselineDir,
        comparisons:$comparisons
      }
  ' >"$comparison_file"

baseline_provenance_file="$baseline_dir/baseline-provenance.json"
if [ -f "$baseline_provenance_file" ]; then
  comparison_with_provenance="$(mktemp)"
  jq --slurpfile baselineProvenance "$baseline_provenance_file" \
    '. + {baselineProvenance: ($baselineProvenance[0] // null)}' \
    "$comparison_file" >"$comparison_with_provenance"
  mv "$comparison_with_provenance" "$comparison_file"
fi

status="$(jq -r '.status' "$comparison_file")"
exit_code=0
case "$status:$mode" in
  fail:fail)
    echo "::error::CI measurement regression detected"
    exit_code=1
    ;;
  fail:*|warn:*)
    echo "::warning::CI measurement regression threshold exceeded"
    ;;
  partial:*)
    echo "::notice::CI measurement baseline is missing for one or more observations"
    ;;
esac

if [ -n "${dollar}{GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### ${dollar}{CI_MEASUREMENT_PR_COMMENT_TITLE:-CI Measurements}"
    echo ""
    jq -r '"- Status: " + .status + "\n- Mode: " + .mode + "\n- Baseline: " + .baselineDir' "$comparison_file"
    echo ""
    echo "| Status | Gate | Target | Observation | Current | Baseline | Delta | Ratio |"
    echo "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |"
    jq -r '
      .comparisons
      | to_entries
      | sort_by(
          if .value.status == "fail" then 0
          elif .value.status == "warn" then 1
          elif .value.status == "missing_baseline" then 2
          else 3
          end
        )
      | .[:20]
      | .[]
      | .value as $v
        | [
            $v.status,
            (if ($v.gateable // false) then "yes" else ($v.gateReason // "no") end),
            (($v.target.kind // "unknown") + "/" + ($v.target.name // "unknown") + "/" + ($v.target.system // "unknown")),
          ($v.observation.name // "unknown"),
          (($v.current // $v.observation.value // 0) | tostring),
          (($v.baseline // "") | tostring),
          (($v.delta // "") | tostring),
          (if $v.ratio == null or $v.ratio == "" then "" else (($v.ratio * 100 | round / 100) | tostring) end)
        ]
      | "| " + (map(gsub("\\|"; "\\\\|")) | join(" | ")) + " |"
    ' "$comparison_file"
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [ "${dollar}{CI_MEASUREMENT_PR_COMMENT_ENABLED:-false}" = "true" ] && [ "${dollar}{GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
  can_render_pr_comment=true
  if ! command -v gh >/dev/null 2>&1; then
    echo "::notice::gh is not available; skipping CI measurement PR comment"
    can_render_pr_comment=false
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "::notice::jq is not available; skipping CI measurement PR comment"
    can_render_pr_comment=false
  fi
  if [ -z "${dollar}{GH_TOKEN:-${dollar}{GITHUB_TOKEN:-}}" ]; then
    echo "::notice::GH_TOKEN/GITHUB_TOKEN is not set; skipping CI measurement PR comment"
    can_render_pr_comment=false
  fi

  event_path="${dollar}{GITHUB_EVENT_PATH:-}"
  pr_number=""
  if [ "$can_render_pr_comment" = "true" ] && [ -n "$event_path" ] && [ -f "$event_path" ]; then
    pr_number="$(jq -r '.pull_request.number // empty' "$event_path")"
  fi
  if [ "$can_render_pr_comment" = "true" ] && [ -z "$pr_number" ]; then
    echo "::notice::pull request number is unavailable; skipping CI measurement PR comment"
    can_render_pr_comment=false
  fi

  if [ "$can_render_pr_comment" = "true" ]; then
    repo="${dollar}{GITHUB_REPOSITORY:?GITHUB_REPOSITORY not set}"
    comment_tmp_dir="$(mktemp -d)"
    comments_json="$comment_tmp_dir/comments.json"
    comment_body="$comment_tmp_dir/comment.md"
    comment_id_file="$comment_tmp_dir/comment-id.txt"
    chart_file="$comment_tmp_dir/perf-change-vs-baseline.svg"
    renderer_script="$comment_tmp_dir/render-ci-measurement-comment.mjs"

    if ! gh api "repos/$repo/issues/$pr_number/comments" --paginate >"$comments_json"; then
      echo "::notice::unable to list PR comments; skipping CI measurement PR comment"
      can_render_pr_comment=false
    fi

    if [ "$can_render_pr_comment" = "true" ]; then
      asset_branch="${dollar}{CI_MEASUREMENT_PR_COMMENT_ASSET_BRANCH:-ci-measurement-assets}"
      asset_title="$(printf '%s' "${dollar}{CI_MEASUREMENT_PR_COMMENT_TITLE:-ci-measurements}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
      if [ -z "$asset_title" ]; then
        asset_title="ci-measurements"
      fi
      asset_head_sha="${dollar}{GITHUB_HEAD_SHA:-${dollar}{GITHUB_SHA:-unknown}}"
      asset_run_id="${dollar}{GITHUB_RUN_ID:-local}"
      asset_run_attempt="${dollar}{GITHUB_RUN_ATTEMPT:-0}"
      asset_path="ci-measurements/pr-$pr_number/${dollar}{asset_head_sha}/run-${dollar}{asset_run_id}-attempt-${dollar}{asset_run_attempt}/${dollar}{asset_title}.svg"
      if [ "${dollar}{GITHUB_SERVER_URL:-https://github.com}" = "https://github.com" ]; then
        chart_url="https://raw.githubusercontent.com/$repo/$asset_branch/$asset_path"
      else
        chart_url="${dollar}{GITHUB_SERVER_URL:-https://github.com}/$repo/raw/$asset_branch/$asset_path"
      fi
      export CI_MEASUREMENT_PR_COMMENT_CHART_URL="$chart_url"

      cat > "$renderer_script" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs'

const [comparisonPath, commentsPath, bodyPath, commentIdPath, chartPath] = process.argv.slice(2)
const title = process.env.CI_MEASUREMENT_PR_COMMENT_TITLE || 'CI Measurements'
const maxRows = Number.parseInt(process.env.CI_MEASUREMENT_PR_COMMENT_MAX_ROWS || '10', 10)
const maxHistory = Number.parseInt(process.env.CI_MEASUREMENT_PR_COMMENT_MAX_HISTORY || '20', 10)
const repo = process.env.GITHUB_REPOSITORY || 'unknown'
const runId = process.env.GITHUB_RUN_ID || ''
const runAttempt = process.env.GITHUB_RUN_ATTEMPT || ''
const sha = process.env.GITHUB_SHA || ''
const headSha = process.env.GITHUB_HEAD_SHA || sha
const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
const workflow = process.env.GITHUB_WORKFLOW || 'CI'
const job = process.env.GITHUB_JOB || ''
const chartUrl = process.env.CI_MEASUREMENT_PR_COMMENT_CHART_URL || ''

const marker = '<!-- ci-measurement-comment:managed -->'
const statePrefix = '<!-- ci-measurement-comment:state\n'
const stateSuffix = '\n-->'
const stateTag = 'ci-measurement-comment-state'
const schemaVersion = 1

const comparison = JSON.parse(readFileSync(comparisonPath, 'utf8'))
const comments = JSON.parse(readFileSync(commentsPath, 'utf8'))
if (!Array.isArray(comments)) throw new Error('comments response must be an array')

const existing = comments.find((comment) => {
  return typeof comment?.body === 'string' && comment.body.includes(marker)
})

const extractState = (body) => {
  if (typeof body !== 'string') return undefined
  const start = body.indexOf(statePrefix)
  if (start === -1) return undefined
  const end = body.indexOf(stateSuffix, start + statePrefix.length)
  if (end === -1) return undefined
  try {
    const parsed = JSON.parse(body.slice(start + statePrefix.length, end))
    if (parsed && parsed._tag === stateTag && Array.isArray(parsed.runs)) return parsed
  } catch {
    return undefined
  }
  return undefined
}

const formatNumber = (value) => {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a'
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 1000) / 1000)
}

const formatValue = (value, unit) => {
  if (value === null || value === undefined) return 'n/a'
  if (unit === 'bytes') {
    if (value >= 1073741824) return formatNumber(Math.round((value / 1073741824) * 10) / 10) + ' GiB'
    if (value >= 1048576) return formatNumber(Math.round((value / 1048576) * 10) / 10) + ' MiB'
    if (value >= 1024) return formatNumber(Math.round((value / 1024) * 10) / 10) + ' KiB'
    return formatNumber(value) + ' B'
  }
  if (unit === 'seconds') return formatNumber(value) + ' s'
  return formatNumber(value) + (unit ? ' ' + unit : '')
}

const formatDelta = (value, unit) => {
  if (value === null || value === undefined) return 'n/a'
  const sign = value >= 0 ? '+' : '-'
  return sign + formatValue(Math.abs(value), unit)
}

const formatRatio = (value) => {
  if (value === null || value === undefined) return 'n/a'
  return formatNumber(Math.round((value - 1) * 1000) / 10) + '%'
}

const formatResult = (row) => {
  if (row.confidence === 'low_baseline_count') return 'gray needs baseline'
  if (row.confidence === 'low_current_sample_count') return 'gray needs repeat'
  if (row.confidence === 'diagnostic') return 'gray diagnostic'
  if (row.status === 'fail') return 'red regression'
  if (row.status === 'warn') return 'yellow regression'
  if (row.status === 'missing_baseline') return 'gray no baseline'
  if (row.confidence === 'noise_floor') return 'gray noise floor'
  if (row.confidence === 'within_baseline_range') return 'gray within range'
  if (row.confidence === 'within_baseline_distribution') return 'gray within p95'
  if (row.direction === 'improved') return 'green improved'
  return 'gray unchanged'
}

const formatGate = (row) => {
  if (row.gateable) return 'yes'
  const reason = row.gateReason || row.confidence || 'unknown'
  return 'no<br><sub>' + reason + '</sub>'
}

const escapeCell = (value) => String(value ?? '-').replaceAll('|', '\\|').replaceAll('\n', '<br>')
const escapeXml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')

const humanProbe = (row) => {
  if (row.observation?.label) return row.observation.label
  const probe = row.observation?.dimensions?.probe
  const name = row.observation?.name || 'unknown'
  const labels = {
    shell_eval_traced: 'Shell eval with OTEL trace',
    shell_eval_warm: 'Warm shell eval',
    tasks_list: 'devenv tasks list',
    processes_help: 'devenv processes --help',
    task_pnpm_install: 'pnpm:install',
    task_genie_run: 'genie:run',
    task_check_quick: 'check:quick',
  }
  if (probe && labels[probe]) return labels[probe]
  if (name.startsWith('devenv.') && name.endsWith('.duration')) {
    return name.slice('devenv.'.length, -'.duration'.length).replaceAll('_', ' ')
  }
  return name
}

const chartProbe = (row) => {
  if (row.observation?.label) return row.observation.label
  const probe = row.observation?.dimensions?.probe
  const labels = {
    shell_eval_traced: 'Shell eval with OTEL trace',
    shell_eval_warm: 'Warm shell eval',
    tasks_list: 'devenv tasks list',
    processes_help: 'processes --help',
    task_pnpm_install: 'pnpm:install',
    task_genie_run: 'genie:run',
    task_check_quick: 'check:quick',
  }
  if (probe && labels[probe]) return labels[probe]
  return humanProbe(row)
}

const dimensions = (row) => {
  const entries = Object.entries(row.observation?.dimensions || {})
  if (entries.length === 0) return '-'
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + '=' + String(value))
    .join('<br>')
}

const rank = (row) => {
  if (row.status === 'fail') return 0
  if (row.status === 'warn') return 1
  if (row.status === 'missing_baseline') return 2
  return 3
}

const allRows = Object.values(comparison.comparisons || {}).sort((left, right) => {
  const byRank = rank(left) - rank(right)
  if (byRank !== 0) return byRank
  return (right.delta || 0) - (left.delta || 0)
})
const protocolLabel = (() => {
  const protocols = new Set(
    allRows
      .map((row) => row.observation?.dimensions?.measurementProtocol)
      .filter((value) => typeof value === 'string' && value.length > 0),
  )
  return protocols.size > 0 ? Array.from(protocols).join(', ') : 'legacy'
})()
const visibleLimit = Number.isFinite(maxRows) && maxRows > 0 ? maxRows : 10
const comparableRows = allRows.filter((row) => typeof row.baseline === 'number')
const hasComparableBaseline = comparableRows.length > 0
const visibleRows = (hasComparableBaseline
  ? allRows.filter((row) => typeof row.baseline === 'number')
  : allRows.slice().sort((left, right) => (right.current || 0) - (left.current || 0))
).slice(0, visibleLimit)

const comparisonTable = (rows) => {
  if (rows.length === 0) return 'No measurement regressions detected.'
  return [
    '| Probe | Baseline | Current | Change | Result | Gate | Confidence |',
    '| --- | ---: | ---: | ---: | --- | --- | --- |',
    ...rows.map((row) => {
      const unit = row.observation?.unit
      const baselineRange = typeof row.baselineMin === 'number' && typeof row.baselineMax === 'number' && row.baselineMin !== row.baselineMax
        ? '<br><sub>range ' + formatValue(row.baselineMin, unit) + ' - ' + formatValue(row.baselineMax, unit) + '</sub>'
        : ''
      return '| ' + [
        humanProbe(row),
        formatValue(row.baseline, unit) + baselineRange,
        formatValue(row.current, unit),
        formatDelta(row.delta, unit) + ' / ' + formatRatio(row.ratio),
        formatResult(row),
        formatGate(row),
        (row.confidence || 'unknown') + '<br><sub>baseline n=' + (row.baselineSources ?? 0) + ', current samples=' + (row.currentSamples ?? 1) + '</sub>',
      ].map(escapeCell).join(' | ') + ' |'
    }),
  ].join('\n')
}

const currentOnlyTable = (rows) => {
  if (rows.length === 0) return 'No current measurements found.'
  return [
    '| Probe | Current |',
    '| --- | ---: |',
    ...rows.map((row) => {
      return '| ' + [humanProbe(row), formatValue(row.current, row.observation?.unit)].map(escapeCell).join(' | ') + ' |'
    }),
  ].join('\n')
}

const allMeasurementsTable = (rows) => {
  if (rows.length === 0) return 'No measurement regressions detected.'
  return [
    '| Status | Gate | Target | Observation | Dimensions | Baseline | Current | Delta | Ratio |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...rows.map((row) => {
      const unit = row.observation?.unit
      return '| ' + [
        row.status,
        row.gateable ? 'yes' : (row.gateReason || 'no'),
        row.target?.label || row.target?.name || 'unknown',
        row.observation?.label || row.observation?.name || 'unknown',
        dimensions(row),
        formatValue(row.baseline, unit),
        formatValue(row.current, unit),
        formatDelta(row.delta, unit),
        formatRatio(row.ratio),
      ].map(escapeCell).join(' | ') + ' |'
    }),
  ].join('\n')
}

const truncate = (value, maxLength) => {
  const text = String(value)
  if (text.length <= maxLength) return text
  if (maxLength <= 1) return text.slice(0, maxLength)
  return text.slice(0, Math.max(0, maxLength - 3)) + '...'
}

const renderPerfChangeSvg = (rows) => {
  const chartRows = rows
    .filter((row) => row.observation?.unit === 'seconds')
    .filter((row) => typeof row.current === 'number' && typeof row.baseline === 'number')
    .filter((row) => typeof row.ratio === 'number')
    .sort((left, right) => ((left.ratio || 1) - 1) - ((right.ratio || 1) - 1))
    .slice(0, visibleLimit)
  if (chartRows.length === 0) return ''

  const percentages = chartRows.map((row) => ((row.ratio || 1) - 1) * 100)
  const minPct = Math.min(-1, ...percentages)
  const maxPct = Math.max(1, ...percentages)
  const lower = Math.floor(minPct)
  const upper = Math.ceil(maxPct)
  const span = upper - lower || 1
  const width = 900
  const rowHeight = 42
  const height = 96 + chartRows.length * rowHeight + 34
  const labelX = 238
  const plotX = 260
  const plotWidth = 342
  const percentX = 626
  const nominalX = 704
  const topY = 78
  const barHeight = 18
  const zeroX = plotX + ((0 - lower) / span) * plotWidth

  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">',
    '<rect width="' + width + '" height="' + height + '" rx="10" fill="#050b1f"/>',
    '<text x="' + width / 2 + '" y="28" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="16" font-weight="700" fill="#e5e7eb">Perf change vs baseline (%)</text>',
    '<text x="' + plotX + '" y="55" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="11" fill="#20d6a3">faster</text>',
    '<text x="' + (plotX + plotWidth) + '" y="55" text-anchor="end" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="11" fill="#fb6b6b">slower</text>',
    '<text x="' + nominalX + '" y="55" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="11" fill="#64748b">baseline -> current</text>',
    '<line x1="' + zeroX.toFixed(1) + '" y1="66" x2="' + zeroX.toFixed(1) + '" y2="' + (height - 34) + '" stroke="#ef4444" stroke-width="1.2" opacity="0.85"/>',
  ]

  for (const [index, row] of chartRows.entries()) {
    const pct = ((row.ratio || 1) - 1) * 100
    const y = topY + index * rowHeight
    const valueWidth = Math.max(2, Math.abs(pct) / span * plotWidth)
    const x = pct < 0 ? zeroX - valueWidth : zeroX
    const color = pct < 0 ? '#20d6a3' : '#fb6b6b'
    const formattedPct = (pct > 0 ? '+' : '') + formatNumber(Math.round(pct * 10) / 10) + '%'
    const label = chartProbe(row)
    const nominal = formatValue(row.baseline, row.observation?.unit).replaceAll(' ', '') + ' -> ' + formatValue(row.current, row.observation?.unit).replaceAll(' ', '')
    svg.push(
      '<text x="' + labelX + '" y="' + (y + 13) + '" text-anchor="end" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="12" fill="#cbd5e1"><title>' + escapeXml(label) + '</title>' + escapeXml(truncate(label, 30)) + '</text>',
      '<rect x="' + plotX + '" y="' + y + '" width="' + plotWidth + '" height="' + barHeight + '" rx="5" fill="#111827"/>',
      '<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + valueWidth.toFixed(1) + '" height="' + barHeight + '" rx="5" fill="' + color + '"/>',
      '<text x="' + percentX + '" y="' + (y + 13) + '" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="12" font-weight="700" fill="' + color + '">' + escapeXml(formattedPct) + '</text>',
      '<text x="' + nominalX + '" y="' + (y + 13) + '" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="11" fill="#94a3b8"><title>' + escapeXml(nominal) + '</title>' + escapeXml(truncate(nominal, 24)) + '</text>',
    )
  }

  svg.push(
    '<text x="' + zeroX.toFixed(1) + '" y="' + (height - 16) + '" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="10" fill="#94a3b8">0%</text>',
    '</svg>',
  )
  return svg.join('\n')
}

const statusWord = comparison.status || 'unknown'
const runUrl = runId ? serverUrl + '/' + repo + '/actions/runs/' + runId : undefined
const shortSha = (headSha || sha || 'unknown').slice(0, 7)
const existingState = extractState(existing?.body)
const currentRun = {
  commitSha: headSha || sha || 'unknown',
  shortSha,
  generatedAt: new Date().toISOString(),
  status: statusWord,
  mode: comparison.mode || 'unknown',
  runUrl,
  runAttempt,
  workflow,
  job,
  visibleRows: visibleRows.map((row) => ({
    status: row.status,
    target: row.target?.label || row.target?.name || 'unknown',
    observation: row.observation?.label || row.observation?.name || 'unknown',
    dimensions: dimensions(row).replaceAll('<br>', ', '),
    baseline: formatValue(row.baseline, row.observation?.unit),
    current: formatValue(row.current, row.observation?.unit),
    delta: formatDelta(row.delta, row.observation?.unit),
    ratio: formatRatio(row.ratio),
  })),
}
const previousRuns = (existingState?.runs || []).filter((run) => run.commitSha !== currentRun.commitSha)
const historyLimit = Number.isFinite(maxHistory) && maxHistory > 0 ? maxHistory : 20
const state = { _tag: stateTag, schemaVersion, title, runs: [currentRun, ...previousRuns].slice(0, historyLimit) }
const gateModeLabel = (mode) => {
  if (mode === 'fail') return 'enforced'
  if (mode === 'warn') return 'advisory'
  if (mode === 'off') return 'off'
  return mode || 'unknown'
}
const historyRows = state.runs.slice(1).map((run) => {
  const link = run.runUrl ? '[' + run.shortSha + '](' + run.runUrl + ')' : run.shortSha
  const top = Array.isArray(run.visibleRows) && run.visibleRows.length > 0
    ? run.visibleRows.slice(0, 3).map((row) => row.status + ' ' + row.target + ' ' + row.observation + ' ' + row.delta + ' / ' + row.ratio).join('<br>')
    : 'No regressions'
  return '| ' + [link, run.status, gateModeLabel(run.mode), top].map(escapeCell).join(' | ') + ' |'
})

const runLink = runUrl ? '[workflow run](' + runUrl + ')' : 'workflow run unavailable'
const baselineProvenance = comparison.baselineProvenance
const baselineLabel = baselineProvenance?.runId
  ? '[main run ' + baselineProvenance.runId + '](' + serverUrl + '/' + repo + '/actions/runs/' + baselineProvenance.runId + ')' +
    (Array.isArray(baselineProvenance.runs) && baselineProvenance.runs.length > 1 ? ' + ' + (baselineProvenance.runs.length - 1) + ' older baseline runs' : '')
  : 'not available'
const chartSvg = hasComparableBaseline ? renderPerfChangeSvg(visibleRows.length > 0 ? visibleRows : allRows) : ''
if (chartPath && chartSvg) writeFileSync(chartPath, chartSvg)
const chartMarkdown = chartUrl && chartSvg ? '![Perf change vs baseline chart](' + chartUrl + ')' : ''

const summaryLines = [
  '## ' + title,
  '',
  '- Status: ' + statusWord,
  '- Gate: ' + gateModeLabel(comparison.mode),
  '- Commit: ' + shortSha,
  '- Run: ' + runLink,
  '- Baseline: ' + baselineLabel,
  '- Protocol: ' + protocolLabel,
  '',
  hasComparableBaseline
    ? 'Chart: performance change versus baseline median. Green is faster, red is slower, gray is within noise or baseline range.'
    : 'No compatible baseline was available, so this run shows current measurements only.',
  '',
  chartMarkdown,
  '',
  hasComparableBaseline ? comparisonTable(visibleRows) : currentOnlyTable(visibleRows),
  '',
  '<details>',
  '<summary>All measurements</summary>',
  '',
  allMeasurementsTable(allRows),
  '',
  '</details>',
]

if (historyRows.length > 0) {
  summaryLines.push(
    '',
    '<details>',
    '<summary>Previous runs</summary>',
    '',
    '| Commit | Status | Gate | Top changes |',
    '| --- | --- | --- | --- |',
    ...historyRows,
    '',
    '</details>',
  )
}

summaryLines.push('', marker, statePrefix + JSON.stringify(state, null, 2) + stateSuffix)
writeFileSync(bodyPath, summaryLines.join('\n') + '\n')
writeFileSync(commentIdPath, existing?.id ? String(existing.id) : '')
EOF

      node "$renderer_script" "$comparison_file" "$comments_json" "$comment_body" "$comment_id_file" "$chart_file"

      if [ -s "$chart_file" ]; then
        if ! gh api "repos/$repo/git/ref/heads/$asset_branch" >/dev/null 2>&1; then
          default_branch_sha="$(gh api "repos/$repo/git/ref/heads/${dollar}{GITHUB_BASE_REF:-main}" --jq '.object.sha' 2>/dev/null || true)"
          if [ -z "$default_branch_sha" ]; then
            default_branch_sha="${dollar}{GITHUB_SHA:-}"
          fi
          if [ -n "$default_branch_sha" ]; then
            gh api "repos/$repo/git/refs" --method POST --field ref="refs/heads/$asset_branch" --field sha="$default_branch_sha" >/dev/null || true
          fi
        fi
        chart_content="$(base64 <"$chart_file" | tr -d '\n')"
        if ! gh api "repos/$repo/contents/$asset_path" --method PUT --field message="Update CI measurement chart for PR #$pr_number" --field content="$chart_content" --field branch="$asset_branch" >/dev/null; then
          echo "::notice::unable to upload CI measurement chart asset"
          sed -i.bak '/!\[Perf change vs baseline chart\]/d' "$comment_body"
        fi
      fi

      comment_id="$(cat "$comment_id_file")"
      if [ -n "$comment_id" ]; then
        if ! gh api "repos/$repo/issues/comments/$comment_id" --method PATCH --field body="$(cat "$comment_body")" >/dev/null; then
          echo "::notice::unable to update CI measurement PR comment"
        fi
      else
        if ! gh api "repos/$repo/issues/$pr_number/comments" --method POST --field body="$(cat "$comment_body")" >/dev/null; then
          echo "::notice::unable to create CI measurement PR comment"
        fi
      fi
    fi
  fi
fi

if [ "$exit_code" -ne 0 ]; then
  exit "$exit_code"
fi
`,
  }) as const

export const devenvPerfJob = (opts?: DevenvPerfJobOptions) => {
  const artifactDir = opts?.artifactDir ?? 'tmp/devenv-perf-ci'
  const artifactName =
    opts?.artifactName ??
    'devenv-perf-${{ github.job }}-${{ github.run_id }}-attempt-${{ github.run_attempt }}'
  const baselineArtifactName = opts?.baselineArtifactName ?? opts?.artifactName

  return {
    'runs-on': opts?.runsOn ?? linuxX64Runner,
    ...(opts?.permissions === undefined ? {} : { permissions: opts.permissions }),
    defaults: bashShellDefaults,
    env: {
      ...standardCIEnv,
      ARTIFACT_DIR: artifactDir,
      OTEL_SERVICE_NAME: 'devenv-perf-ci',
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
      ...(baselineArtifactName === undefined
        ? []
        : [
            downloadPreviousGitHubArtifactStep({
              artifactName: baselineArtifactName,
              outputDir: `${artifactDir}/baseline`,
              seedRunIds: opts?.baselineSeedRunIds,
              maxRuns: opts?.baselineMaxRuns,
            }),
          ]),
      devenvPerfBenchmarkStep({
        taskProbes: opts?.taskProbes,
        probes: opts?.probes,
      }),
      compareCiMeasurementsStep({
        currentDir: artifactDir,
        baselineDir: `${artifactDir}/baseline`,
        outputFile: `${artifactDir}/measurement-comparison.json`,
        regressionMode: opts?.regressionMode ?? 'warn',
        prComment: opts?.prComment,
      }),
      devenvPerfArtifactStep({
        artifactDir,
        artifactName,
        retentionDays: opts?.retentionDays,
      }),
    ],
  } as const
}
