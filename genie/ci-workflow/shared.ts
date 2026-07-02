import {
  githubWorkflow,
  type ActionlintConfig,
  type GitHubWorkflowArgs,
} from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { RUNNER_PROFILES, type RunnerProfile } from '../ci.ts'

export { RUNNER_PROFILES, type RunnerProfile }

// =============================================================================
// Shared Config
// =============================================================================

/** Self-hosted NixOS runner labels (x86_64-linux, e.g. dev3) */
export const linuxX64Runner = ['sh-linux-x64', 'nix'] as const

/** Self-hosted NixOS runner labels (aarch64-linux, e.g. dev4) */
export const linuxArm64Runner = ['sh-linux-arm64', 'nix'] as const

/** Self-hosted macOS runner labels (aarch64-darwin, e.g. mbp2021) */
export const darwinArm64Runner = ['sh-darwin-arm64', 'nix'] as const

/** All self-hosted runner labels — derived from the runner constants above + RUNNER_PROFILES */
const SELF_HOSTED_RUNNER_LABELS = [
  ...new Set([...RUNNER_PROFILES, ...linuxX64Runner, ...linuxArm64Runner, ...darwinArm64Runner]),
] as const

/** Default actionlint config with all known self-hosted runner labels */
export const defaultActionlintConfig: ActionlintConfig = {
  selfHostedRunnerLabels: SELF_HOSTED_RUNNER_LABELS,
}

/** Standard shell defaults for CI run steps */
export const bashShellDefaults = {
  run: { shell: 'bash' },
} as const

/**
 * Standard CI environment variables.
 * GITHUB_TOKEN is exported for tools that need it as a shell env var (e.g. gh CLI, nix auth).
 * Nix eval policy is enforced at step runtime by helpers like
 * `validateNixStoreStep` and `runDevenvTasksBefore`, which append
 * `restrict-eval = false` while preserving inherited NIX_CONFIG values.
 */
export const standardCIEnv = {
  FORCE_SETUP: '1',
  CI: 'true',
  GITHUB_TOKEN: '${{ github.token }}',
} as const

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
}

const ciConcurrencyScope = (opts?: Pick<CiConcurrencyOptions, 'measurementBaselineBackfill'>) =>
  opts?.measurementBaselineBackfill === true
    ? "${{ github.event_name == 'workflow_dispatch' && inputs.measurement_baseline_ref != '' && format('measurement-baseline-{0}', inputs.measurement_baseline_ref) || (github.event_name == 'workflow_dispatch' && format('manual-run-{0}', github.run_id) || (github.event_name == 'pull_request' && (github.event.action == 'labeled' || github.event.action == 'unlabeled') && format('label-{0}', github.event.label.name) || 'code')) }}"
    : "${{ github.event_name == 'workflow_dispatch' && format('manual-run-{0}', github.run_id) || (github.event_name == 'pull_request' && (github.event.action == 'labeled' || github.event.action == 'unlabeled') && format('label-{0}', github.event.label.name) || 'code') }}"

const ciCancelInProgress = (opts?: Pick<CiConcurrencyOptions, 'measurementBaselineBackfill'>) =>
  opts?.measurementBaselineBackfill === true
    ? "${{ !(github.event_name == 'workflow_dispatch' && inputs.measurement_baseline_ref != '') && (github.event_name != 'pull_request' || (github.event.action != 'labeled' && github.event.action != 'unlabeled')) }}"
    : "${{ github.event_name != 'pull_request' || (github.event.action != 'labeled' && github.event.action != 'unlabeled') }}"

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

const withDefaultJobConcurrency = ({
  jobs,
  ...opts
}: { jobs: GitHubWorkflowArgs['jobs'] } & Pick<
  CiConcurrencyOptions,
  'measurementBaselineBackfill'
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

/**
 * Standard wrapper for composed CI workflows.
 *
 * This keeps cancellation policy centralized in `effect-utils`. Repos can still
 * override the workflow-level policy by passing an explicit `concurrency`
 * field, and individual jobs can opt out or provide their own `concurrency`.
 */
export const ciWorkflow = (args: GitHubWorkflowArgs) =>
  (({ concurrency, actionlint, jobs, on, ...rest }) =>
    githubWorkflow({
      ...rest,
      on: concurrency === undefined ? withJobConcurrencyDispatchInputs(on) : on,
      ...(concurrency === undefined ? {} : { concurrency }),
      actionlint: actionlint ?? defaultActionlintConfig,
      jobs:
        concurrency === undefined
          ? withDefaultJobConcurrency({
              jobs,
              measurementBaselineBackfill: supportsMeasurementBaselineBackfill(on),
            })
          : jobs,
    }))(args)

export type NixConfigOptions = {
  unrestrictedEval?: boolean
  extraLines?: readonly string[]
}

export type NixBinaryCache = {
  readonly uri: string
  readonly publicKey: string
}

export const devenvBinaryCache = {
  uri: 'https://devenv.cachix.org',
  publicKey: 'devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=',
} as const satisfies NixBinaryCache

/** Build a binary-cache descriptor for a Cachix cache. */
export const cachixBinaryCache = (opts: { name: string; publicKey: string }): NixBinaryCache => ({
  uri: `https://${opts.name}.cachix.org`,
  publicKey: opts.publicKey,
})

const dedupeBinaryCaches = (caches: readonly NixBinaryCache[]) => [
  ...new Map(caches.map((cache) => [cache.uri, cache])).values(),
]

export const cachixHostsFromBinaryCaches = (caches: readonly NixBinaryCache[]) => [
  ...new Set(
    caches.flatMap((cache) => {
      const host = new URL(cache.uri).host
      return host.endsWith('.cachix.org') === true ? [host] : []
    }),
  ),
]

/** Render `extra-conf` lines for one or more binary caches. */
export const nixBinaryCachesExtraConf = (caches: readonly NixBinaryCache[]) => {
  const resolvedCaches = dedupeBinaryCaches([devenvBinaryCache, ...caches])
  return [
    `extra-substituters = ${resolvedCaches.map((cache) => cache.uri).join(' ')}`,
    `extra-trusted-public-keys = ${resolvedCaches.map((cache) => cache.publicKey).join(' ')}`,
  ].join('\n')
}

export const devenvBinRef = '"${DEVENV_BIN:?DEVENV_BIN not set}"'

export const resolveDevenvRevScript = `DEVENV_REV=$(jq -r .nodes.devenv.locked.rev devenv.lock)
if [ -z "$DEVENV_REV" ] || [ "$DEVENV_REV" = "null" ]; then
  echo '::error::devenv.lock missing .nodes.devenv.locked.rev'
  exit 1
fi`

export const resolveDevenvFnScript = `resolve_devenv() {
  nix build \\
    --accept-flake-config \\
    --option extra-substituters ${devenvBinaryCache.uri} \\
    --option extra-trusted-public-keys ${devenvBinaryCache.publicKey} \\
    --no-link \\
    --print-out-paths \\
    "github:cachix/devenv/$DEVENV_REV#devenv"
}`

export const shellSingleQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

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

/**
 * Keep pnpm's hot mutable content isolated per job while still allowing cache reuse across runs.
 *
 * In the pnpm 11 + GVS configuration we use today, the effective hot state lives
 * under `PNPM_HOME`, not `PNPM_STORE_DIR`. `PNPM_HOME` must stay
 * workspace-relative because the GVS links embed absolute paths and those need
 * to stay valid for relocatable artifacts like `vercel deploy --prebuilt`.
 */
export const jobLocalPnpmHome = '${{ github.workspace }}/.pnpm-home'

/**
 * Keep pnpm's auxiliary mutable store content isolated per job.
 *
 * We still wire `PNPM_STORE_DIR` explicitly for pnpm, but the primary CI cache
 * target is `PNPM_HOME` because that is where pnpm 11 GVS keeps the reusable
 * links and metadata.
 */
export const jobLocalPnpmStore = '${{ runner.temp }}/pnpm-store/${{ github.job }}'

/**
 * Canonical pnpm CI state surface for pnpm 11 + GVS on self-hosted runners.
 *
 * `PNPM_HOME` carries the hot reusable links and metadata, while the
 * auxiliary mutable store content still lives under `PNPM_STORE_DIR`. The
 * supported cache contract restores both together under one exact key.
 */
export const jobLocalPnpmStatePaths = [jobLocalPnpmHome, jobLocalPnpmStore].join('\n')

/** Job-local CI diagnostics directory used for runner pressure snapshots and install logs. */
export const jobLocalCiDiagnosticsDir = '${{ runner.temp }}/ci-diagnostics/${{ github.job }}'

/** Workspace-local cache root for mutable Nix client cache content on CI runners. */
export const workspaceLocalNixCacheRoot = '${{ github.workspace }}/.ci-cache'

/** Default Nix cache path restored/saved by the shared CI cache helpers. */
export const workspaceLocalNixCachePath = `${workspaceLocalNixCacheRoot}/nix`

/**
 * Fall back to the standard CI pnpm paths when a workflow has not exported
 * them via `pnpmStateSetupStep` yet. This keeps `runDevenvTasksBefore` safe for
 * downstream callers while effect-utils centralizes the preferred setup step.
 */
export const withCiPnpmState = (command: string) =>
  `PNPM_HOME="\${PNPM_HOME:-${jobLocalPnpmHome}}" PNPM_STORE_DIR="\${PNPM_STORE_DIR:-${jobLocalPnpmStore}}" PNPM_CONFIG_STORE_DIR="\${PNPM_CONFIG_STORE_DIR:-${jobLocalPnpmStore}}" ${command}`

export const runDevenvTasksBeforeWithOptions = (
  opts: NixConfigOptions,
  ...args: [string, ...string[]]
) =>
  withAppendedNixConfig({
    command: withCiPnpmState(
      `DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false ${devenvBinRef} tasks run ${args.join(' ')}`,
    ),
    opts,
  })

export const defaultCiRuntimeScriptsDir = 'genie/ci-scripts'
export const preparedCiRuntimeScriptsDir = '${{ runner.temp }}/genie-ci-scripts'

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
 * Some namespace runners also lose the multi-user Nix daemon socket after
 * setup; retry those after a best-effort daemon restart. This daemon-socket
 * sub-case is a distinct runner-side failure mode and is NOT covered by the
 * two upstream store-race refs below — it has no tracked upstream fix yet.
 *
 * TODO: Remove the store-validity-race retry once NixOS/nix#15469 and
 * DeterminateSystems/nix-src#395 are released. The daemon-socket repair branch
 * must be reassessed separately (see `repair_nix_daemon`).
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
