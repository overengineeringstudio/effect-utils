import {
  githubWorkflow,
  type ActionlintConfig,
  type GitHubWorkflowArgs,
} from '../../packages/@overeng/genie/src/runtime/mod.ts'
import type { BinaryCacheDescriptor } from './binary-cache-descriptors.ts'
import { workflowCacheDescriptors } from './cache-policy.ts'
import { fleetWorkflowPolicy } from './policy.ts'
import { selfHostedRunnerLabels } from './runners.ts'

export {
  RUNNER_PROFILES,
  type RunnerProfile,
  linuxX64Runner,
  linuxX64HeavyRunner,
  linuxArm64Runner,
  darwinArm64Runner,
  LEGACY_NAMESPACE_LINUX_X64_PAIRED_PERF_RUNNER,
} from './runners.ts'

// =============================================================================
// Shared Config
// =============================================================================

/** Default actionlint config with all known self-hosted runner labels */
export const defaultActionlintConfig: ActionlintConfig = {
  selfHostedRunnerLabels,
}

/** Standard shell defaults for CI run steps */
export const bashShellDefaults = {
  run: { shell: 'bash' },
} as const

type NixRealisationTiming = { readonly p95: number; readonly max: number }

/**
 * Bound bootstrap at three times p95 or twice the observed maximum, whichever
 * is larger, with a two-minute floor for runner noise. Repository-specific
 * measurements belong at the call site. The maximum protects observed cold
 * paths; the step timer also catches trickles above Nix's low-speed threshold.
 */
export const withNixRealisationTimeouts = (
  jobs: GitHubWorkflowArgs['jobs'],
  timingsSeconds: Readonly<
    Record<
      string,
      | NixRealisationTiming
      | { readonly Linux: NixRealisationTiming; readonly macOS: NixRealisationTiming }
    >
  >,
): GitHubWorkflowArgs['jobs'] =>
  Object.fromEntries(
    Object.entries(jobs).map(([id, job]) => [
      id,
      {
        ...job,
        steps: job.steps.map((step) => {
          const measured = step.name === undefined ? undefined : timingsSeconds[step.name]
          if (measured === undefined) return step
          const timeout = ({ p95, max }: NixRealisationTiming) => {
            const minutes = Math.max(2, Math.ceil((3 * p95) / 60), Math.ceil((2 * max) / 60))
            return typeof step['timeout-minutes'] === 'number'
              ? Math.min(minutes, step['timeout-minutes'])
              : minutes
          }
          const linux = timeout('p95' in measured ? measured : measured.Linux)
          const macOS = timeout('p95' in measured ? measured : measured.macOS)
          return {
            ...step,
            'timeout-minutes':
              linux === macOS ? linux : `\${{ runner.os == 'macOS' && ${macOS} || ${linux} }}`,
          }
        }),
      },
    ]),
  )

export type CiTrustTier = 'private' | 'public'

/** Step-local environment for GitHub CLI and authenticated Nix access. */
export const githubTokenEnv = (tokenExpression = '${{ github.token }}') =>
  ({
    GITHUB_TOKEN: tokenExpression,
  }) as const

/**
 * Standard CI environment variables for a repository's cache trust tier.
 * Nix eval policy is enforced at step runtime by helpers like
 * `validateNixStoreStep` and `runDevenvTasksBefore`, which append
 * `restrict-eval = false` while preserving inherited NIX_CONFIG values.
 */
export const standardCIEnv = ({ trustTier }: { readonly trustTier: CiTrustTier }) =>
  ({
    FORCE_SETUP: '1',
    CI: 'true',
    BUCK2_NO_REMOTE_CACHE: '0',
    BUCK2_PUBLIC_CACHE_READ_ONLY: trustTier === 'public' ? '1' : '0',
  }) as const

/**
 * Cancel superseded CI jobs for the same event, ref, and job id.
 *
 * This is intentionally job-level, not workflow-level. GitHub can wedge
 * workflow_dispatch runs before job creation; when that happens, the run has no
 * check runs, no logs, and the API may return 500 for cancellation. Keeping
 * concurrency at job level lets workflow evaluation materialize visible jobs
 * before any scarce-runner throttling applies.
 *
 * Code validation is a branch-protection signal for the latest PR head. Keeping
 * older code-triggered pull_request jobs alive can consume scarce runners after
 * a newer head exists, so jobs with the same id still cancel superseded work.
 *
 * Measurement baseline backfills are keyed by their subject ref and do not
 * cancel in-progress runs so several historical refs can be backfilled without
 * canceling each other.
 *
 * Manual dispatches are intentionally keyed by run id. They are operator probes
 * and baseline/debug tools, not the authoritative PR-comment path.
 *
 * Merge-queue label churn is different: only the mq:ci-admitted label event is
 * allowed to materialize full PR CI. Other label events do not change the
 * commit under test and must not cancel an already-running validation run.
 */
type CiConcurrencyOptions = {
  readonly matrix?: boolean
  readonly measurementBaselineBackfill?: boolean
  /** False only when the workflow explicitly excludes labeled/unlabeled PR activity. */
  readonly labelEvents?: boolean
}

const ciConcurrencyScope = (
  opts?: Pick<CiConcurrencyOptions, 'measurementBaselineBackfill' | 'labelEvents'>,
) => {
  const manual =
    "github.event_name == 'workflow_dispatch' && format('manual-run-{0}', github.run_id)"
  const labels =
    opts?.labelEvents === false
      ? "'code'"
      : "(github.event_name == 'pull_request' && (github.event.action == 'labeled' || github.event.action == 'unlabeled') && format('label-{0}', github.event.label.name) || 'code')"
  return opts?.measurementBaselineBackfill === true
    ? `\${{ github.event_name == 'workflow_dispatch' && inputs.measurement_baseline_ref != '' && format('measurement-baseline-{0}', inputs.measurement_baseline_ref) || (${manual} || ${labels}) }}`
    : `\${{ ${manual} || ${labels} }}`
}

const ciCancelInProgress = (
  opts?: Pick<CiConcurrencyOptions, 'measurementBaselineBackfill' | 'labelEvents'>,
) => {
  if (opts?.labelEvents === false) {
    return opts.measurementBaselineBackfill === true
      ? "${{ !(github.event_name == 'workflow_dispatch' && inputs.measurement_baseline_ref != '') }}"
      : true
  }
  return opts?.measurementBaselineBackfill === true
    ? "${{ !(github.event_name == 'workflow_dispatch' && inputs.measurement_baseline_ref != '') && (github.event_name != 'pull_request' || (github.event.action != 'labeled' && github.event.action != 'unlabeled')) }}"
    : "${{ github.event_name != 'pull_request' || (github.event.action != 'labeled' && github.event.action != 'unlabeled') }}"
}

export const ciJobConcurrency = ({ jobId, ...opts }: { jobId: string } & CiConcurrencyOptions) =>
  ({
    group:
      '${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}-' +
      ciConcurrencyScope(opts) +
      `-${jobId}` +
      (opts?.matrix === true ? '-${{ strategy.job-index }}' : ''),
    'cancel-in-progress': ciCancelInProgress(opts),
  }) as const

const isMatrixJob = (job: GitHubWorkflowArgs['jobs'][string]) =>
  typeof job.strategy === 'object' && job.strategy !== null && 'matrix' in job.strategy

const workflowDispatchBaselineRefInput = {
  description:
    'Optional ref/SHA to checkout before running CI measurement jobs. Used to backfill comparable baseline artifacts.',
  required: false,
  default: '',
  type: 'string',
} as const

const withJobConcurrencyDispatchInputs = (
  on: GitHubWorkflowArgs['on'],
): GitHubWorkflowArgs['on'] => {
  if (
    typeof on !== 'object' ||
    on === null ||
    !('workflow_dispatch' in on) ||
    on.workflow_dispatch === null
  ) {
    return on
  }

  return {
    ...on,
    workflow_dispatch: {
      ...on.workflow_dispatch,
      inputs: {
        measurement_baseline_ref: workflowDispatchBaselineRefInput,
        ...on.workflow_dispatch.inputs,
      },
    },
  }
}

const supportsMeasurementBaselineBackfill = (on: GitHubWorkflowArgs['on']) =>
  typeof on === 'object' &&
  on !== null &&
  'workflow_dispatch' in on &&
  on.workflow_dispatch !== null

const excludesLabelEvents = (on: GitHubWorkflowArgs['on']): boolean => {
  if (typeof on !== 'object' || on === null || Array.isArray(on) === true) return false
  return [on.pull_request, on.pull_request_target].every(
    (trigger) =>
      trigger === undefined ||
      (trigger !== null &&
        'types' in trigger &&
        Array.isArray(trigger.types) &&
        trigger.types.every((type) => type !== 'labeled' && type !== 'unlabeled')),
  )
}

const withDefaultJobConcurrency = ({
  jobs,
  ...opts
}: { jobs: GitHubWorkflowArgs['jobs'] } & Pick<
  CiConcurrencyOptions,
  'measurementBaselineBackfill' | 'labelEvents'
>): GitHubWorkflowArgs['jobs'] =>
  Object.fromEntries(
    Object.entries(jobs).map(([jobId, job]) => [
      jobId,
      job.concurrency === undefined
        ? { ...job, concurrency: ciJobConcurrency({ jobId, ...opts, matrix: isMatrixJob(job) }) }
        : job,
    ]),
  )

export const ciWorkflowConcurrency = {
  group:
    '${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}-' + ciConcurrencyScope(),
  'cancel-in-progress': ciCancelInProgress(),
} as const

export type CiWorkflowArgs = GitHubWorkflowArgs & {
  readonly trustTier: CiTrustTier
  readonly binaryCaches?: readonly BinaryCacheDescriptor[]
  /**
   * Attest sandbox support for jobs whose runs-on cannot be resolved statically.
   * This does not override an explicitly unprivileged Namespace Linux label.
   */
  readonly linuxNixSandboxCapabilities?: Readonly<Record<string, 'supported'>>
}

const linuxNixSandboxSettings = ['sandbox = true', 'sandbox-fallback = false']

/** Installer/daemon setting; the empty Darwin branch leaves its policy unchanged. */
export const linuxNixSandboxFallbackConf = linuxNixSandboxSettings
  .map((setting) => `\${{ runner.os == 'Linux' && '${setting}' || '' }}`)
  .join('\n')

/** Fork policy shared by runner selection, sandbox validation, and TS admission. */
export const namespacePrivilegeTrustedPredicate =
  "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository"

/**
 * Resolve bounded runner alternatives, not incidental quoted strings.
 * The trusted suffix is the existing runtime-admitted exception; arbitrary
 * feature interpolation must instead carry an explicit capability attestation.
 */
const resolveRunnerLabelAlternatives = (label: string): readonly string[] | undefined => {
  const expression = /^\s*\$\{\{([\s\S]*?)\}\}\s*$/.exec(label)
  if (expression !== null) {
    const alternatives = /^[^&|]+&&\s*'((?:[^']|'')*)'\s*\|\|\s*'((?:[^']|'')*)'\s*$/.exec(
      expression[1] ?? '',
    )
    return alternatives?.slice(1).map((alternative) => alternative.replaceAll("''", "'"))
  }
  const trustedSuffix = `\${{ (${namespacePrivilegeTrustedPredicate}) && ';container.privileged=true' || '' }}`
  const resolved = label
    .replaceAll(trustedSuffix, ';container.privileged=true')
    .replace(/\$\{\{\s*github\.run_id\s*\}\}/g, 'GENIE_RUN_ID')
  return resolved.includes('${{') === true ? undefined : [resolved]
}

/**
 * Validate the runner before emitting a workflow that installs strict-sandbox Nix.
 * Namespace feature labels can be separate array entries; expression alternatives
 * must be checked independently rather than borrowing another branch's privilege.
 */
const validateLinuxNixSandboxRunners = ({
  jobs,
  capabilities,
}: {
  readonly jobs: GitHubWorkflowArgs['jobs']
  readonly capabilities: CiWorkflowArgs['linuxNixSandboxCapabilities']
}): void => {
  for (const [jobId, job] of Object.entries(jobs)) {
    if (
      job.steps.some(
        (step) => step.uses?.startsWith('DeterminateSystems/determinate-nix-action@') === true,
      ) === false
    )
      continue
    const labels = [job['runs-on']].flat()
    // Fixed machine constraints apply to the entire job, not each selector.
    if (
      labels.includes('self-hosted') === true ||
      labels.some((label) =>
        /^(?:namespace-profile-|nscloud-)[^$;]*(?:macos|darwin)[^$;]*$/.test(
          label.split(';')[0] ?? '',
        ),
      ) === true
    )
      continue
    const fail = (reason: string): never => {
      throw new Error(
        `CI job "${jobId}": ${reason}. Install Nix requires sandbox = true and sandbox-fallback = false on Linux. ` +
          'Append container.privileged=true to a Namespace profile label, or use a namespace-features label beside a -with-features machine label. ' +
          'For an opaque runs-on expression, declare linuxNixSandboxCapabilities: { ' +
          `[${JSON.stringify(jobId)}]: 'supported' } only when every possible Linux runner supports strict Nix sandboxing.`,
      )
    }
    const entries = labels.map((label) => {
      const resolved = resolveRunnerLabelAlternatives(label)
      return {
        opaque: resolved === undefined,
        unknownMachine: resolved === undefined && (label.split(';')[0] ?? '').includes('${{'),
        // Unknown programs need attestation, but cannot erase their static
        // fragments or their literal runner alternatives.
        alternatives: resolved ?? [
          label.replace(/\$\{\{[\s\S]*?\}\}/g, 'GENIE_OPAQUE'),
          ...[...label.matchAll(/'((?:[^']|'')*)'/g)]
            .map((match) => (match[1] ?? '').replaceAll("''", "'"))
            .filter((literal) =>
              /^(?:namespace-profile-|nscloud-|namespace-features:)/.test(literal),
            ),
        ],
      }
    })
    const staticLabels = entries.flatMap((entry) => entry.alternatives)
    const namespaceLinux = staticLabels.filter(
      (label) =>
        /^(?:namespace-profile-|nscloud-)/.test(label) === true &&
        /(?:^|[-;])(?:macos|darwin)(?:[-;]|$)/.test(label) === false,
    )
    if (
      namespaceLinux.length === 0 &&
      entries.every((entry) => entry.unknownMachine === false) === true
    )
      continue
    // Static disablement always wins, including separate feature alternatives.
    if (
      staticLabels.some((label) => /(?:^|[;:])container\.privileged=false(?:;|$)/.test(label)) ===
      true
    )
      fail(
        'literal runner feature lacks container.privileged=true: explicitly disables container.privileged',
      )
    const hasOpaqueLabel = entries.some((entry) => entry.opaque)
    if (hasOpaqueLabel === true && capabilities?.[jobId] !== 'supported')
      fail(`cannot statically determine runs-on ${JSON.stringify(job['runs-on'])}`)
    // A separate feature entry guarantees privilege only if all its alternatives
    // supply it. Attestation may fill an unknown entry, never an unprivileged literal.
    const hasPrivilegedFeatures = entries.some((entry) =>
      entry.alternatives.every(
        (label) =>
          label.startsWith('namespace-features:') === true &&
          /(?:^|[;:])container\.privileged=true(?:;|$)/.test(label) === true,
      ),
    )
    for (const label of staticLabels) {
      if (
        label.startsWith('namespace-features:') === true &&
        label.includes('GENIE_OPAQUE') === false &&
        /(?:^|[;:])container\.privileged=true(?:;|$)/.test(label) === false
      )
        fail(`literal feature label ${JSON.stringify(label)} lacks container.privileged=true`)
    }
    for (const label of namespaceLinux) {
      const privileged =
        (label.split(';')[0] ?? '').endsWith('-with-features') === true
          ? hasPrivilegedFeatures || hasOpaqueLabel
          : /(?:^|;)container\.privileged=true(?:;|$)/.test(label)
      if (privileged === false)
        fail(
          `Namespace Linux runner ${JSON.stringify(label)} lacks container.privileged=true in its supported label format`,
        )
    }
  }
}

/** Also covers preinstalled Nix and jobs that do not use the shared installer. */
export const linuxNixSandboxFallbackStep = {
  id: 'linux-nix-sandbox-policy',
  name: 'Disable Linux Nix sandbox fallback',
  if: "${{ runner.os == 'Linux' }}",
  shell: 'bash' as const,
  run: [
    'set -euo pipefail',
    `printf 'NIX_CONFIG<<EOF\\n%s\\n${linuxNixSandboxSettings.join('\\n')}\\nEOF\\n' "\${NIX_CONFIG:-}" >> "$GITHUB_ENV"`,
  ].join('\n'),
}

export const linuxSandboxAdmissionStepId = 'linux-sandbox-admission'
export const defaultRefPolicyVerdictStepId = 'default-ref-policy-verdict'

type CiJobSteps = GitHubWorkflowArgs['jobs'][string]['steps']

/** All execution prerequisites in a job jointly own its admission boundary. */
export const ciJobAdmission = (steps: CiJobSteps) => {
  let after = -1
  const conditions: string[] = []
  for (const [index, step] of steps.entries()) {
    const condition =
      step.id === linuxSandboxAdmissionStepId
        ? `(runner.os != 'Linux' || steps.${linuxSandboxAdmissionStepId}.outcome == 'success')`
        : step.id === defaultRefPolicyVerdictStepId
          ? `steps.${defaultRefPolicyVerdictStepId}.outcome == 'success'`
          : undefined
    if (condition !== undefined) {
      after = index
      conditions.push(condition)
    }
  }
  return { after, condition: conditions.length === 0 ? undefined : conditions.join(' && ') }
}

/**
 * Explicit status functions bypass Actions' implicit success() prerequisite.
 * Restore admission for executable cleanup, retaining data-only artifact/cache saves.
 */
export const withCiAdmissionCleanup = (steps: CiJobSteps): CiJobSteps => {
  const { condition } = ciJobAdmission(steps)
  if (condition === undefined) return steps
  const suffix = ` && (${condition})`
  return steps.map((step) => {
    if (
      step.if === undefined ||
      /\b(?:always|failure|cancelled|success)\s*\(/.test(step.if) === false
    )
      return step
    if (/^actions\/(?:upload-artifact|cache\/save)@/.test(step.uses ?? '') === true) return step
    const expression = step.if.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, '')
    if (expression.endsWith(suffix) === true) return step
    return { ...step, if: `\${{ (${expression})${suffix} }}` }
  })
}

export const buck2CiJobInstanceStep = {
  id: 'buck2-ci-job-instance',
  name: 'Initialize Buck2 CI job instance',
  shell: 'bash',
  // A fresh nonce, not the matrix parent ID or runner name: sequential
  // matrix children may reuse the same runner and checkout directory.
  run: `printf 'BUCK2_CI_JOB_INSTANCE=%s\\n' "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \\n')" >> "$GITHUB_ENV"`,
} as const

const withStandardCIEnv = ({
  jobs,
  trustTier,
}: {
  readonly jobs: GitHubWorkflowArgs['jobs']
  readonly trustTier: CiTrustTier
}): GitHubWorkflowArgs['jobs'] =>
  Object.fromEntries(
    Object.entries(jobs).map(([jobId, job]) => [
      jobId,
      {
        ...job,
        env: {
          ...standardCIEnv({ trustTier }),
          ...job.env,
        },
        steps: withCiAdmissionCleanup([
          linuxNixSandboxFallbackStep,
          buck2CiJobInstanceStep,
          ...job.steps.filter((step) => step.id !== linuxNixSandboxFallbackStep.id),
        ]),
      },
    ]),
  )

/**
 * Standard wrapper for composed CI workflows.
 *
 * This keeps cache trust and cancellation policy centralized in `effect-utils`.
 * Repos can still override the workflow-level policy by passing an explicit
 * `concurrency` field, and individual jobs can opt out or provide their own
 * `concurrency`.
 */
export const ciWorkflow = ({
  trustTier,
  binaryCaches,
  linuxNixSandboxCapabilities,
  ...args
}: CiWorkflowArgs) => {
  const { concurrency, actionlint, jobs, on, ...rest } = args
  validateLinuxNixSandboxRunners({ jobs, capabilities: linuxNixSandboxCapabilities })
  const workflow = {
    [workflowCacheDescriptors]: binaryCaches ?? [],
    ...rest,
    policy:
      args.policy ??
      fleetWorkflowPolicy({
        repository: '${{ github.repository }}',
        workflow: args.name ?? 'CI',
      }),
    on: concurrency === undefined ? withJobConcurrencyDispatchInputs(on) : on,
    ...(concurrency === undefined ? {} : { concurrency }),
    actionlint: actionlint ?? defaultActionlintConfig,
    jobs: withStandardCIEnv({
      trustTier,
      jobs:
        concurrency === undefined
          ? withDefaultJobConcurrency({
              jobs,
              measurementBaselineBackfill: supportsMeasurementBaselineBackfill(on),
              labelEvents: !excludesLabelEvents(on),
            })
          : jobs,
    }),
  }
  return githubWorkflow(workflow)
}

export type NixConfigOptions = {
  unrestrictedEval?: boolean
  extraLines?: readonly string[]
}

/** Public bootstrap cache for the pinned devenv binary, not an implicit job cache. */
export const devenvBinaryCache = {
  kind: 'nix-binary',
  name: 'devenv',
  visibility: 'public',
  uri: 'https://devenv.cachix.org',
  publicKey: 'devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=',
} as const

export const devenvBinRef = '"${DEVENV_BIN:?DEVENV_BIN not set}"'

export const shellSingleQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

export const resolveDevenvRevScriptFor = (
  lockFile = 'devenv.lock',
) => `DEVENV_REV=$(jq -r .nodes.devenv.locked.rev ${shellSingleQuote(lockFile)})
if [ -z "$DEVENV_REV" ] || [ "$DEVENV_REV" = "null" ]; then
  printf '::error::%s missing .nodes.devenv.locked.rev\\n' ${shellSingleQuote(lockFile)}
  exit 1
fi`

export const resolveDevenvRevScript = resolveDevenvRevScriptFor()

export const resolveDevenvFnScript = `DEVENV_GC_ROOT_DIR="${'${RUNNER_TEMP:-/tmp}'}/genie-nix-gc-roots"
DEVENV_GC_ROOT_ID=$(printf '%s' "${'${GITHUB_RUN_ID:-local-$$}'}-${'${GITHUB_RUN_ATTEMPT:-0}'}-${'${GITHUB_JOB:-job}'}" | tr -c 'A-Za-z0-9._-' '_')
DEVENV_GC_ROOT="$DEVENV_GC_ROOT_DIR/devenv-$DEVENV_GC_ROOT_ID"

resolve_devenv_once() {
  mkdir -p "$DEVENV_GC_ROOT_DIR"
  nix build \\
    --accept-flake-config \\
    --option extra-substituters ${devenvBinaryCache.uri} \\
    --option extra-trusted-public-keys ${devenvBinaryCache.publicKey} \\
    --out-link "$DEVENV_GC_ROOT" \\
    --print-out-paths \\
    "github:cachix/devenv/$DEVENV_REV#devenv"
}

resolve_devenv() {
  local invalid_path
  local log
  local rc

  log=$(mktemp)
  if resolve_devenv_once 2>"$log"; then
    cat "$log" >&2
    rm -f "$log"
    return 0
  else
    rc=$?
  fi
  cat "$log" >&2
  invalid_path=$(grep -E -o "error:[[:space:]]*path '/nix/store/[^']*'[[:space:]]*is not( a)? valid( store path)?" "$log" |
    head -1 | grep -o "/nix/store/[^']*" || true)
  rm -f "$log"
  [ -n "$invalid_path" ] || return "$rc"

  echo "::warning::devenv resolution hit an invalid Nix store path; clearing the client eval cache and retrying once: $invalid_path" >&2
  rm -rf "${'${XDG_CACHE_HOME:-$HOME/.cache}'}/nix/eval-cache-"* ~/.cache/nix/eval-cache-*
  nix-store --repair-path "$invalid_path" >/dev/null 2>&1 ||
    nix-store --realise "$invalid_path" >/dev/null 2>&1 || true
  if resolve_devenv_once; then
    if [ -n "${'${GITHUB_STEP_SUMMARY:-}'}" ]; then
      echo '### Recovered Nix store lifecycle incident' >> "$GITHUB_STEP_SUMMARY"
      echo "- Invalid path: $invalid_path" >> "$GITHUB_STEP_SUMMARY"
      echo '- Attempts: 2/2' >> "$GITHUB_STEP_SUMMARY"
    fi
    return 0
  else
    return $?
  fi
}`

/** Build extra-conf / NIX_CONFIG content for common Nix feature flags. */
export const nixExtraConf = (opts: NixConfigOptions = {}) =>
  [
    ...(opts.unrestrictedEval === true ? ['restrict-eval = false'] : []),
    ...(opts.extraLines ?? []),
  ].join('\n')

export const withAppendedNixConfig = ({
  command,
  opts = {},
}: {
  command: string
  opts?: NixConfigOptions
}) => {
  const extraConf = nixExtraConf(opts)
  if (extraConf === '') {
    return command
  }

  const quotedExtraConf = shellSingleQuote(extraConf)
  return `if [ -n "${'${NIX_CONFIG:-}'}" ]; then NIX_CONFIG_WITH_APPEND=$(printf '%s\\n%s' "$NIX_CONFIG" ${quotedExtraConf}); else NIX_CONFIG_WITH_APPEND=${quotedExtraConf}; fi; NIX_CONFIG="$NIX_CONFIG_WITH_APPEND" ${command}`
}

export const dollar = '$'

/** Stable runner scratch shared by one job's synthesized composition and mutable tool state. */
export const ciCompositionStateRoot = '${{ runner.temp }}/composition-state'

/** Job-local pnpm home, independent of the disposable synthesized workspace path. */
export const ciPnpmHome = `${ciCompositionStateRoot}/pnpm-home`

/** Stable pnpm content store projected into the owned member through a relative workspace symlink. */
export const ciPnpmStore = `${ciCompositionStateRoot}/pnpm-store-pure-v1`

/** Job-local CI diagnostics directory used for runner pressure snapshots and install logs. */
export const jobLocalCiDiagnosticsDir = `${ciCompositionStateRoot}/diagnostics/${'${{ github.job }}'}`

/** Stable mutable Nix client cache root, independent of CI run and workspace identity. */
export const ciNixCacheRoot = `${ciCompositionStateRoot}/nix-cache`

/** Default Nix cache path restored/saved by the shared CI cache helpers. */
export const ciNixCachePath = `${ciNixCacheRoot}/nix`

/** Enter the actions checkout selected for this shell step. */
export const ciSourceRoot = 'cd "${GITHUB_WORKSPACE:-$PWD}"'

/** Run one source-dependent shell command from the canonical CI source root. */
export const withCiSourceRoot = (command: string) => `${ciSourceRoot} && ${command}`

export const runDevenvTasksBeforeWithOptions = (
  opts: NixConfigOptions,
  ...args: [string, ...string[]]
) =>
  withCiSourceRoot(
    withAppendedNixConfig({
      command: `DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false \${PIPELINE_RUN_PREFIX:+$PIPELINE_RUN_PREFIX }${devenvBinRef} tasks run ${args.join(' ')}`,
      opts,
    }),
  )

export const defaultCiRuntimeScriptsDir = 'genie/ci-scripts'
export const preparedCiRuntimeScriptsDir = `${ciCompositionStateRoot}/ci-runtime`
export const prepareJobLocalRustState = `. "${preparedCiRuntimeScriptsDir}/prepare-job-local-rust-state.sh"`

export type GcRaceRetryOptions = {
  readonly command: string
  readonly label: string
  readonly scriptsDir?: string
}

/**
 * Retry wrapper for the Nix store validity race where `derivationStrict` fails
 * with `path '/nix/store/...' is not valid`.
 *
 * In practice this often surfaces through higher-level eval wrappers such as
 * `Failed to convert config.cachix to JSON` / `while evaluating the option
 * cachix.package` before the final invalid-store-path line appears. We treat
 * those as the same root cause and retry after realizing the missing path and
 * clearing the eval cache.
 *
 * Some runners also lose the multi-user Nix daemon socket after setup. Retry
 * those passively so host supervision can restore service; CI jobs must not
 * mutate the shared daemon. This daemon-socket sub-case is a distinct
 * runner-side failure mode and is not covered by the upstream refs below.
 *
 * TODO: Remove the store-validity-race retry once NixOS/nix#15469 and
 * DeterminateSystems/nix-src#395 are released. Reassess the daemon-socket retry
 * separately when host supervision exposes a stronger availability contract.
 * @see https://github.com/NixOS/nix/pull/15469
 * @see https://github.com/DeterminateSystems/nix-src/issues/395
 */
export const withGcRaceRetry = ({
  command,
  label,
  scriptsDir = preparedCiRuntimeScriptsDir,
}: GcRaceRetryOptions) => {
  const quotedCommand = shellSingleQuote(command)
  const quotedLabel = shellSingleQuote(label)
  const scriptPath = `${scriptsDir}/run-with-nix-gc-race-retry.sh`

  if (scriptsDir === defaultCiRuntimeScriptsDir) {
    return `bash ${shellSingleQuote(scriptPath)} ${quotedLabel} ${quotedCommand}`
  }

  return [
    `__genie_ci_retry_script=${shellSingleQuote(scriptPath)}`,
    `bash "$__genie_ci_retry_script" ${quotedLabel} ${quotedCommand}`,
  ].join('\n')
}

export const createRunDevenvTasksBefore =
  (opts: { readonly scriptsDir?: string } = {}) =>
  (...args: [string, ...string[]]) =>
    withGcRaceRetry({
      command: runDevenvTasksBeforeWithOptions({ unrestrictedEval: true }, ...args),
      label: `devenv tasks run ${args.join(' ')}`,
      ...(opts.scriptsDir === undefined ? {} : { scriptsDir: opts.scriptsDir }),
    })

/** Build a command that runs one or more devenv tasks with dependencies. */
export const runDevenvTasksBefore = createRunDevenvTasksBefore()
