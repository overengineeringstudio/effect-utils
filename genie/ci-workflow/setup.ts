import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import type { RunnerProfile } from '../ci.ts'
import { applyMegarepoLockStep } from './megarepo.ts'
import {
  bashShellDefaults,
  cachixHostsFromBinaryCaches,
  jobLocalCiDiagnosticsDir,
  jobLocalPnpmHome,
  jobLocalPnpmStatePaths,
  jobLocalPnpmStore,
  nixBinaryCachesExtraConf,
  resolveDevenvFnScript,
  resolveDevenvRevScript,
  linuxX64Runner,
  runDevenvTasksBefore,
  shellSingleQuote,
  standardCIEnv,
  withGcRaceRetry,
  workspaceLocalNixCachePath,
  workspaceLocalNixCacheRoot,
  type NixBinaryCache,
} from './shared.ts'

type WorkflowJob = GitHubWorkflowArgs['jobs'][string]
type WorkflowStep = WorkflowJob['steps'][number]

const evictOutPathShellLines = [
  '      if nix path-info "$outPath" >/dev/null 2>&1; then',
  '        echo "evicting cached: $(basename "$outPath")"',
  '        if ! nix store delete --ignore-liveness "$outPath" >/dev/null 2>&1; then',
  '          echo "::error::failed to evict cached pnpm-deps output: $outPath"',
  '          exit 1',
  '        fi',
  '        if nix path-info "$outPath" >/dev/null 2>&1; then',
  '          echo "::error::cached pnpm-deps output still present after eviction: $outPath"',
  '          exit 1',
  '        fi',
  '      fi',
] as const

const withEachPnpmDepsDrvShellLines = ({
  flakeRef,
  bodyLines,
}: {
  flakeRef: string
  bodyLines: readonly string[]
}) =>
  [
    `targetRef=${shellSingleQuote(flakeRef)}`,
    'entriesJson=$(mktemp)',
    'if nix eval --json "$targetRef.passthru.depsBuildEntries" >"$entriesJson" 2>/dev/null; then',
    "  while IFS=$'\\t' read -r attrName drv; do",
    '    [ -n "$drv" ] || continue',
    ...bodyLines,
    '  done < <(jq -r \'.[] | [.attrName, (.drvPath // "")] | @tsv\' "$entriesJson")',
    'else',
    '  topDrv=$(nix path-info --derivation "$targetRef" 2>/dev/null || true)',
    '  if [ -n "$topDrv" ]; then',
    '    while IFS= read -r drv; do',
    '      [ -n "$drv" ] || continue',
    '      attrName=""',
    ...bodyLines,
    '    done < <(nix-store -qR "$topDrv" 2>/dev/null | grep "pnpm-deps-[a-z0-9-]*-v[0-9].*\\.drv$" || true)',
    '  fi',
    'fi',
    'rm -f "$entriesJson"',
  ] as const

/** Evict cached pnpm-deps fixed-output outputs so CI re-derives them fresh. */
export const evictCachedPnpmDepsStep = ({
  flakeRef,
  name = 'Evict cached pnpm deps',
}: {
  flakeRef: string
  name?: string
}) => ({
  name,
  shell: 'bash',
  run: withEachPnpmDepsDrvShellLines({
    flakeRef,
    bodyLines: [
      '    while IFS= read -r outPath; do',
      '      [ -n "$outPath" ] || continue',
      ...evictOutPathShellLines,
      '    done < <(nix-store -q --outputs "$drv" 2>/dev/null || true)',
    ],
  }).join('\n'),
})

/**
 * Namespace runner with run ID-based affinity to prevent queue jumping.
 * Adds a run ID label so runners spawned for one workflow run
 * don't steal jobs from other runs.
 */
export const namespaceRunner = ({
  profile,
  runId,
}: {
  profile: RunnerProfile | (string & {})
  runId: string
}) => [profile, `namespace-features:github.run-id=${runId}`] as const

// =============================================================================
// Step Atoms
// =============================================================================

/** Checkout repository via actions/checkout@v6 */
export const checkoutStep = (opts?: { repository?: string; ref?: string; path?: string }) => ({
  uses: 'actions/checkout@v6' as const,
  ...(opts !== undefined && Object.keys(opts).length > 0 ? { with: opts } : {}),
})

/** Mint a GitHub App installation token for downstream private-repo fetches. */
export const githubAppInstallationTokenStep = (opts: {
  id: string
  appId: string
  privateKey: string
  owner: string
  repositories: readonly [string, ...string[]]
  name?: string
}) => ({
  id: opts.id,
  name: opts.name ?? `Mint ${opts.owner} GitHub App token`,
  uses: 'actions/create-github-app-token@v3' as const,
  with: {
    'app-id': opts.appId,
    'private-key': opts.privateKey,
    owner: opts.owner,
    repositories: opts.repositories.join(','),
  },
})

/**
 * Build shell env bindings for a GitHub token.
 *
 * Use this on later run steps when self-hosted wrappers or ad hoc git/nix
 * invocations must authenticate with the minted installation token.
 */
export const githubAccessTokenEnv = (tokenExpression: string) => ({
  GITHUB_TOKEN: tokenExpression,
  GH_TOKEN: tokenExpression,
})

/**
 * Attach a GitHub token env binding to an existing workflow step.
 *
 * This is the supported way to pass an installation token through later steps.
 * GitHub Actions does not allow overriding `GITHUB_*` variables via `$GITHUB_ENV`.
 */
export const withGitHubAccessTokenEnv = <
  TStep extends {
    env?: Record<string, string>
  },
>(
  step: TStep,
  tokenExpression: string,
): TStep => ({
  ...step,
  env: {
    ...step.env,
    ...githubAccessTokenEnv(tokenExpression),
  },
})

const withPrivateCachixReadAuthCommand = ({
  command,
  cacheHosts,
}: {
  command: string
  cacheHosts: readonly string[]
}) => {
  if (cacheHosts.length === 0) {
    return command
  }

  return [
    'if [ -z "${CACHIX_AUTH_TOKEN:-}" ]; then',
    '  echo "::error::CACHIX_AUTH_TOKEN is not set"',
    '  exit 1',
    'fi',
    'cachix_netrc="$(mktemp "${RUNNER_TEMP:-/tmp}/cachix-netrc.XXXXXX")"',
    'trap \'rm -f "$cachix_netrc"\' EXIT',
    'chmod 600 "$cachix_netrc"',
    `for host in ${cacheHosts.map(shellSingleQuote).join(' ')}; do`,
    `  printf 'machine %s\\npassword %s\\n' "$host" "$CACHIX_AUTH_TOKEN" >> "$cachix_netrc"`,
    'done',
    'if [ -n "${NIX_CONFIG:-}" ]; then',
    '  NIX_CONFIG_WITH_APPEND=$(printf \'%s\\n%s\' "$NIX_CONFIG" "netrc-file = $cachix_netrc")',
    'else',
    '  NIX_CONFIG_WITH_APPEND="netrc-file = $cachix_netrc"',
    'fi',
    'export NIX_CONFIG="$NIX_CONFIG_WITH_APPEND"',
    command,
  ].join('\n')
}

/**
 * Attach job-local Cachix read auth to a shell step.
 *
 * This keeps private cache pull auth local to the step instead of relying on
 * host-global netrc state owned by the runner image.
 */
export const withPrivateCachixReadAuth = <
  TStep extends {
    run: string
    env?: Record<string, string>
  },
>(
  step: TStep,
  opts: {
    authTokenExpression: string
    binaryCaches: readonly NixBinaryCache[]
  },
): TStep => {
  const cacheHosts = cachixHostsFromBinaryCaches(opts.binaryCaches)
  if (cacheHosts.length === 0) {
    return step
  }

  return {
    ...step,
    env: {
      ...step.env,
      CACHIX_AUTH_TOKEN: opts.authTokenExpression,
    },
    run: withPrivateCachixReadAuthCommand({
      command: step.run,
      cacheHosts,
    }),
  }
}

/**
 * Append a GitHub access token line to NIX_CONFIG for later shell steps.
 *
 * This only updates `NIX_CONFIG`. Use `withGitHubAccessTokenEnv(...)` when the
 * same token also needs to be visible to self-hosted runner wrappers or other
 * tools that read `GITHUB_TOKEN` / `GH_TOKEN` from the step environment.
 */
export const appendGitHubAccessTokenToNixConfigStep = (opts: {
  tokenExpression: string
  name?: string
}) => ({
  name: opts.name ?? 'Export GitHub access token for Nix',
  shell: 'bash' as const,
  run: [
    `token=${shellSingleQuote(opts.tokenExpression)}`,
    'if [ -n "${NIX_CONFIG:-}" ]; then',
    '  printf "NIX_CONFIG<<EOF\\n%s\\naccess-tokens = github.com=%s\\nEOF\\n" "$NIX_CONFIG" "$token" >> "$GITHUB_ENV"',
    'else',
    '  printf "NIX_CONFIG<<EOF\\naccess-tokens = github.com=%s\\nEOF\\n" "$token" >> "$GITHUB_ENV"',
    'fi',
  ].join('\n'),
})

/**
 * Install Nix via DeterminateSystems/determinate-nix-action@v3.
 * Includes shared binary caches and github.com access-tokens
 * by default. On self-hosted where Nix is pre-installed, this action is a no-op
 * and extra-conf is silently skipped — the runner's nix wrapper handles
 * access-tokens there by reading GITHUB_TOKEN from the environment.
 */
export const installNixStep = (opts?: {
  binaryCaches?: readonly NixBinaryCache[]
  extraConf?: string
  githubAccessTokenExpression?: string
  summarize?: boolean
}) => ({
  name: 'Install Nix',
  uses: 'DeterminateSystems/determinate-nix-action@v3' as const,
  with: {
    'extra-conf': [
      /**
       * TODO: Remove explicit experimental-features override once upstream ca-derivations issues are resolved
       * @see https://github.com/NixOS/nix/issues/12361
       * @see https://github.com/cachix/devenv/issues/2364
       */
      'experimental-features = nix-command flakes',
      /** Trust flake-level nixConfig (e.g. additional repo-local substituters) */
      'accept-flake-config = true',
      nixBinaryCachesExtraConf(opts?.binaryCaches ?? []),
      `access-tokens = github.com=${opts?.githubAccessTokenExpression ?? '${{ github.token }}'}`,
      ...(opts?.extraConf !== undefined ? [opts.extraConf] : []),
    ].join('\n'),
    summarize: opts?.summarize ?? true,
  },
})

/**
 * Provide the cachix CLI to subsequent steps from a /nix/store output.
 *
 * Must run before `cachixStep` in the same job. cachix-action's
 * `which.sync('cachix', { nothrow: true })` short-circuit then skips its
 * built-in installer, so the binary stays a /nix/store path and the runner's
 * nix profile is never mutated.
 */
export const cachixCliBuildStep = {
  name: 'Provide cachix CLI from nixpkgs',
  shell: 'bash',
  run: [
    'set -euo pipefail',
    'out=$(nix build --no-link --print-out-paths nixpkgs#cachix)',
    'echo "$out/bin" >> "$GITHUB_PATH"',
  ].join('\n'),
} as const

/** Enable a Cachix binary cache. Requires `cachixCliBuildStep` earlier in the job. */
export const cachixStep = (opts: { name: string; authToken?: string }) => ({
  name: 'Enable Cachix cache',
  uses: 'cachix/cachix-action@v17' as const,
  with: {
    name: opts.name,
    ...(opts.authToken !== undefined ? { authToken: opts.authToken } : {}),
  },
})

/**
 * Prepare lock-pinned devenv metadata from devenv.lock.
 */
export const preparePinnedDevenvStep = {
  name: 'Use pinned devenv from lock',
  run: `${resolveDevenvRevScript}
echo "DEVENV_REV=$DEVENV_REV" >> "$GITHUB_ENV"
echo "Pinned devenv rev: $DEVENV_REV"`,
  shell: 'bash',
} as const

/**
 * Export the canonical CI pnpm paths once so every later shell step shares the
 * same writable store and the same workspace-relative GVS projection.
 */
export const pnpmStateSetupStep = {
  name: 'Isolate pnpm state',
  shell: 'bash',
  run: [
    `echo "PNPM_STORE_DIR=${jobLocalPnpmStore}" >> "$GITHUB_ENV"`,
    `echo "PNPM_CONFIG_STORE_DIR=${jobLocalPnpmStore}" >> "$GITHUB_ENV"`,
    `echo "PNPM_HOME=${jobLocalPnpmHome}" >> "$GITHUB_ENV"`,
  ].join('\n'),
} as const

/**
 * Export the canonical workspace-local Nix cache root so later steps share the
 * same mutable client cache surface across one CI job.
 */
export const nixCacheSetupStep = {
  name: 'Isolate nix cache',
  shell: 'bash',
  run: [
    `mkdir -p "${workspaceLocalNixCachePath}"`,
    `echo "XDG_CACHE_HOME=${workspaceLocalNixCacheRoot}" >> "$GITHUB_ENV"`,
  ].join('\n'),
} as const

/**
 * Export the job-local CI diagnostics directory once so later steps can
 * collect runner pressure snapshots and install logs in one place.
 */
export const ciDiagnosticsSetupStep = {
  name: 'Prepare CI diagnostics',
  shell: 'bash',
  run: `mkdir -p "${jobLocalCiDiagnosticsDir}"
echo "CI_DIAGNOSTICS_DIR=${jobLocalCiDiagnosticsDir}" >> "$GITHUB_ENV"`,
} as const

const runnerPressureSnapshotScript = [
  'set -euo pipefail',
  'mkdir -p "$CI_DIAGNOSTICS_DIR"',
  'pressure_file="$CI_DIAGNOSTICS_DIR/runner-pressure.txt"',
  '{',
  '  echo "timestamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  '  echo "runner_name=${RUNNER_NAME:-unknown}"',
  '  echo "runner_os=${RUNNER_OS:-unknown}"',
  '  echo "runner_arch=${RUNNER_ARCH:-unknown}"',
  '  echo "github_job=${GITHUB_JOB:-unknown}"',
  '  echo',
  '  uptime',
  '  echo',
  '  if command -v free >/dev/null 2>&1; then',
  '    free -h',
  '  elif [ -r /proc/meminfo ]; then',
  '    cat /proc/meminfo',
  '  elif command -v vm_stat >/dev/null 2>&1; then',
  '    vm_stat',
  '    if command -v memory_pressure >/dev/null 2>&1; then',
  '      echo',
  '      memory_pressure || true',
  '    fi',
  '  else',
  '    echo "memory stats unavailable on runner"',
  '  fi',
  '  echo',
  '  if [ -r /proc/pressure/memory ]; then',
  '    cat /proc/pressure/memory',
  '  fi',
  '  echo',
  '  df -h /',
  '  echo',
  '  if command -v ps >/dev/null 2>&1; then',
  '    if ps -eo pid,ppid,user,%cpu,%mem,etime,stat,comm --sort=-%cpu >/dev/null 2>&1; then',
  '      ps -eo pid,ppid,user,%cpu,%mem,etime,stat,comm --sort=-%cpu | head -15',
  '    else',
  '      ps -axo pid,ppid,user,%cpu,%mem,etime,stat,comm -r | head -15',
  '    fi',
  '  else',
  '    echo "ps unavailable on runner"',
  '  fi',
  '} | tee "$pressure_file"',
  'if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then',
  '  {',
  '    echo "### Runner pressure"',
  '    echo ""',
  '    echo "```text"',
  '    tail -20 "$pressure_file"',
  '    echo "```"',
  '  } >> "$GITHUB_STEP_SUMMARY"',
  'fi',
].join('\n')

/**
 * Capture a quick runner pressure snapshot before the install starts.
 *
 * This does not fail the job. It gives the later failure summary and artifact
 * enough context to tell whether pnpm timed out under host pressure.
 */
export const captureRunnerPressureStep = {
  name: 'Capture runner pressure',
  shell: 'bash',
  run: runnerPressureSnapshotScript,
} as const

const pnpmInstallFailureSummaryScript = [
  'classify_pnpm_failure() {',
  '  local log_file="$1"',
  '  local signature="unknown"',
  '  local evidence=""',
  '  if grep -Eq "ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_FAIL|Socket timeout|ECONNRESET|EAI_AGAIN" "$log_file"; then',
  '    signature="registry/network fetch"',
  '    evidence="$(grep -Em1 \x27ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_FAIL|Socket timeout|ECONNRESET|EAI_AGAIN\x27 "$log_file" || true)"',
  '  elif grep -Eq "ERR_PNPM_WORKSPACE_PKG_NOT_FOUND" "$log_file"; then',
  '    signature="workspace package mismatch"',
  '    evidence="$(grep -Em1 \x27ERR_PNPM_WORKSPACE_PKG_NOT_FOUND\x27 "$log_file" || true)"',
  '  fi',
  '  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then',
  '    {',
  '      echo "### pnpm install failed"',
  '      echo ""',
  '      echo "- Classification: $signature"',
  '      echo "- Evidence: \\`$evidence\\`"',
  '      echo "- Log artifact: \\`$CI_DIAGNOSTICS_DIR/pnpm-install.log\\`"',
  '      echo ""',
  '      echo "```text"',
  '      tail -80 "$log_file"',
  '      echo "```"',
  '    } >> "$GITHUB_STEP_SUMMARY"',
  '  fi',
  '  echo "::warning::pnpm install failed ($signature); see $CI_DIAGNOSTICS_DIR/pnpm-install.log"',
  '}',
].join('\n')

/**
 * Run the repo-root pnpm install while teeing the full log to the diagnostics
 * directory and summarizing failures in the job output.
 */
export const pnpmInstallWithDiagnosticsStep = () =>
  ({
    name: 'Install pnpm dependencies',
    shell: 'bash',
    run: [
      'set -euo pipefail',
      'mkdir -p "$CI_DIAGNOSTICS_DIR"',
      'log_file="$CI_DIAGNOSTICS_DIR/pnpm-install.log"',
      'set +e',
      '(',
      runDevenvTasksBefore('pnpm:install'),
      ') 2>&1 | tee "$log_file"',
      'rc=${PIPESTATUS[0]}',
      'set -e',
      'if [ "$rc" -ne 0 ]; then',
      pnpmInstallFailureSummaryScript,
      '  classify_pnpm_failure "$log_file"',
      'fi',
      'exit "$rc"',
    ].join('\n'),
  }) as const

const nixCachePrimaryKey = (keyPrefix: string, hashFilesExpression: string) =>
  `${keyPrefix}-${'${{ runner.os }}'}-${'${{ runner.arch }}'}-${hashFilesExpression}`

/**
 * Restore the shared workspace-local Nix cache before expensive eval/build work.
 *
 * The default cache authority keys off the lockfiles that affect Nix inputs and
 * repo composition. Consumers can override the key prefix or hash expression
 * when a narrower surface is more appropriate.
 */
export const restoreNixCacheStep = (opts?: {
  keyPrefix?: string
  stepId?: string
  path?: string
  hashFilesExpression?: string
}) => {
  const keyPrefix = opts?.keyPrefix ?? 'nix-cache-v1'
  const path = opts?.path ?? workspaceLocalNixCachePath
  const hashFilesExpression =
    opts?.hashFilesExpression ?? "${{ hashFiles('devenv.lock', 'flake.lock', 'megarepo.lock') }}"

  return {
    id: opts?.stepId ?? 'restore-nix-cache',
    name: 'Restore nix cache',
    uses: 'actions/cache/restore@v4' as const,
    with: {
      path,
      key: nixCachePrimaryKey(keyPrefix, hashFilesExpression),
      'restore-keys': `${keyPrefix}-${'${{ runner.os }}'}-${'${{ runner.arch }}'}-`,
    },
  }
}

/**
 * Save the shared workspace-local Nix cache after the main task graph runs.
 *
 * Reuses the primary key emitted by the restore step so the save path stays
 * aligned with the exact cache authority evaluated earlier in the job.
 */
export const saveNixCacheStep = (opts?: { restoreStepId?: string; path?: string }) => {
  const restoreStepId = opts?.restoreStepId ?? 'restore-nix-cache'
  const path = opts?.path ?? workspaceLocalNixCachePath

  return {
    name: 'Save nix cache',
    if: `\${{ always() && steps.${restoreStepId}.outputs.cache-primary-key != '' }}`,
    uses: 'actions/cache/save@v4' as const,
    with: {
      path,
      key: `\${{ steps.${restoreStepId}.outputs.cache-primary-key }}`,
    },
  }
}

const pnpmStateCachePrimaryKey = (keyPrefix: string) =>
  `${keyPrefix}-${'${{ runner.os }}'}-${'${{ runner.arch }}'}-${"${{ hashFiles('**/pnpm-lock.yaml') }}"}`

/**
 * Restore the job-local pnpm state snapshot before any install work runs.
 *
 * Live pnpm state must use exact-key semantics. Prefix fallback restore keys
 * are not part of the supported contract for mutable pnpm state because they
 * blur the authority boundary between the current lockfile graph and older
 * warmed state.
 */
export const restorePnpmStateStep = (opts?: {
  keyPrefix?: string
  stepId?: string
  path?: string
}) => {
  const keyPrefix = opts?.keyPrefix ?? 'pnpm-state-v1'
  const path = opts?.path ?? jobLocalPnpmStatePaths

  return {
    id: opts?.stepId ?? 'restore-pnpm-state',
    name: 'Restore pnpm state',
    uses: 'actions/cache/restore@v4' as const,
    with: {
      path,
      // The fetched state contents are platform-specific, so the cache must
      // isolate both OS and CPU architecture to avoid cross-platform corruption.
      key: pnpmStateCachePrimaryKey(keyPrefix),
    },
  }
}

/**
 * Save the job-local pnpm state after the main task graph runs.
 *
 * Save only after prior steps succeeded. This avoids publishing partial or
 * corrupt live state after a failed dependency preparation step.
 */
export const savePnpmStateStep = (opts?: {
  keyPrefix?: string
  restoreStepId?: string
  path?: string
}) => {
  const keyPrefix = opts?.keyPrefix ?? 'pnpm-state-v1'
  const restoreStepId = opts?.restoreStepId ?? 'restore-pnpm-state'
  const path = opts?.path ?? jobLocalPnpmStatePaths

  return {
    name: 'Save pnpm state',
    if: `\${{ success() && steps.${restoreStepId}.outputs.cache-hit != 'true' }}`,
    uses: 'actions/cache/save@v4' as const,
    with: {
      path,
      // Reuse the same primary key expression as restore. GitHub Actions does
      // not allow nesting `${{ ... }}` inside a fallback string of another
      // expression, so deriving the key once in TypeScript keeps the emitted
      // workflow expression valid.
      key: pnpmStateCachePrimaryKey(keyPrefix),
    },
  }
}

/**
 * Shared self-hosted CI setup for repos that prepare a devenv workspace,
 * restore warmed mutable state, and run `pnpm:install` before the main task.
 *
 * This composes the existing step atoms into one standard contract so
 * downstream repos can delete local workflow glue instead of reassembling the
 * same Nix/pnpm/diagnostics sequence by hand.
 */
export const standardSelfHostedPnpmCiPrepSteps = (opts?: {
  checkout?: Parameters<typeof checkoutStep>[0]
  installNix?: Parameters<typeof installNixStep>[0]
  restoreNixCache?: Parameters<typeof restoreNixCacheStep>[0]
  applyMegarepoLock?: false | Parameters<typeof applyMegarepoLockStep>[0]
  restorePnpmState?: Parameters<typeof restorePnpmStateStep>[0]
  includeDiagnostics?: boolean
}) =>
  [
    checkoutStep(opts?.checkout),
    installNixStep(opts?.installNix),
    preparePinnedDevenvStep,
    nixCacheSetupStep,
    restoreNixCacheStep(opts?.restoreNixCache),
    validateNixStoreStep,
    ...(opts?.applyMegarepoLock === false ? [] : [applyMegarepoLockStep(opts?.applyMegarepoLock)]),
    pnpmStateSetupStep,
    ciDiagnosticsSetupStep,
    ...(opts?.includeDiagnostics === false ? [] : [captureRunnerPressureStep]),
    restorePnpmStateStep(opts?.restorePnpmState),
    pnpmInstallWithDiagnosticsStep(),
  ] as const

/**
 * Shared self-hosted CI tail for repos that save warmed mutable state and keep
 * pnpm / runner diagnostics attached to the finished job.
 */
export const standardSelfHostedPnpmCiPostSteps = (opts?: {
  savePnpmState?: Parameters<typeof savePnpmStateStep>[0]
  saveNixCache?: Parameters<typeof saveNixCacheStep>[0]
  includeDiagnosticsArtifact?: boolean
}) =>
  [
    savePnpmStateStep(opts?.savePnpmState),
    saveNixCacheStep(opts?.saveNixCache),
    ...(opts?.includeDiagnosticsArtifact === false ? [] : [ciDiagnosticsArtifactStep()]),
  ] as const

export const devenvTaskStep = (name: string, ...args: [string, ...string[]]) => ({
  name,
  run: runDevenvTasksBefore(...args),
})

export type StandardSelfHostedDevenvTaskJobOptions = Omit<
  WorkflowJob,
  'runs-on' | 'defaults' | 'env' | 'steps'
> & {
  readonly runsOn?: string | readonly string[]
  readonly defaults?: WorkflowJob['defaults']
  readonly env?: Record<string, string>
  readonly prepSteps?: readonly WorkflowStep[]
  readonly postSteps?: readonly WorkflowStep[]
  readonly prep?: Parameters<typeof standardSelfHostedPnpmCiPrepSteps>[0]
  readonly post?: Parameters<typeof standardSelfHostedPnpmCiPostSteps>[0]
  readonly step: WorkflowStep
}

export const standardSelfHostedDevenvTaskJob = ({
  runsOn = linuxX64Runner,
  defaults = bashShellDefaults,
  env = standardCIEnv,
  prepSteps,
  postSteps,
  prep,
  post,
  step,
  ...jobOptions
}: StandardSelfHostedDevenvTaskJobOptions): WorkflowJob => ({
  'runs-on': Array.isArray(runsOn) ? [...runsOn] : runsOn,
  defaults,
  env,
  steps: [
    ...(prepSteps ?? standardSelfHostedPnpmCiPrepSteps(prep)),
    step,
    ...(postSteps ?? standardSelfHostedPnpmCiPostSteps(post)),
  ],
  ...jobOptions,
})

/**
 * Upload CI diagnostics captured during the pnpm install / runner-pressure
 * steps as a single artifact on failure.
 */
export const ciDiagnosticsArtifactStep = (opts?: { if?: string; retentionDays?: number }) => ({
  name: 'Upload CI diagnostics artifact',
  if: opts?.if ?? "failure() && env.CI_DIAGNOSTICS_DIR != ''",
  uses: 'actions/upload-artifact@v4' as const,
  with: {
    name: 'ci-diagnostics-${{ github.job }}-${{ runner.os }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}',
    path: '${{ env.CI_DIAGNOSTICS_DIR }}',
    'if-no-files-found': 'ignore',
    'retention-days': opts?.retentionDays ?? 14,
  },
})

/**
 * Validate exported pnpm fixed-output derivations by realizing them (which
 * may substitute from Cachix), then evicting the output and rebuilding from
 * scratch.
 *
 * FOD output paths are deterministic from the declared hash. If Cachix has a
 * previously-valid output (uploaded when the hash was correct), Nix substitutes
 * it without rebuilding — even if the hash is now stale. `--rebuild` also
 * must avoid shared-daemon-store heuristics. On CI runners, `nix store delete`
 * may succeed while the out path still appears valid due to lingering roots or
 * daemon-managed store state, which makes path-visibility checks flaky.
 *
 * The fix: realize once, then use `nix build --rebuild`. Nix rebuilds the FOD
 * and compares the result to the trusted store path directly. If the declared
 * hash is stale, the rebuild/check fails with the underlying hash mismatch.
 */
export const validateColdPnpmDepsStep = ({
  flakeRefs,
  name = 'Cold pnpm deps validation',
  substituters,
}: {
  flakeRefs: readonly [string, ...string[]]
  name?: string
  substituters?: readonly string[]
}) => ({
  name,
  shell: 'bash',
  run: (() => {
    const substituterArgs =
      substituters === undefined || substituters.length === 0
        ? ''
        : ` --option substituters ${shellSingleQuote(substituters.join(' '))}`

    const command = [
      'set -euo pipefail',
      `for attr in ${flakeRefs.map(shellSingleQuote).join(' ')}; do`,
      '  echo "::group::rebuild-check $attr"',
      '  # Step 1: Realize once (may substitute) so rebuild has a trusted output to compare against.',
      `  nix build --no-link "$attr"${substituterArgs}`,
      '  # Step 2: Rebuild and compare locally. This fails on stale fixed-output hashes without',
      '  # relying on whether a shared daemon store made the prior out path disappear.',
      `  nix build --no-link --rebuild "$attr"${substituterArgs}`,
      '  echo "::endgroup::"',
      'done',
    ].join('\n')

    return withGcRaceRetry({ command, label: name })
  })(),
})

/** Evict any cached pnpm-deps outputs below a flake target and rebuild it against cache.nixos.org only. */
export const coldFreshNixBuildStep = ({
  flakeRef,
  name = 'Cold fresh Nix build',
  extraArgs = [],
}: {
  flakeRef: string
  name?: string
  extraArgs?: readonly string[]
}) => ({
  name,
  shell: 'bash',
  run: [
    'set -euo pipefail',
    ...withEachPnpmDepsDrvShellLines({
      flakeRef,
      bodyLines: [
        '    installable="${drv}^*"',
        '    echo "cold-building pnpm deps: ${attrName:-$drv}"',
        '    nix build --no-link "$installable" --option substituters "https://cache.nixos.org" || true',
        '    while IFS= read -r outPath; do',
        '      [ -n "$outPath" ] || continue',
        ...evictOutPathShellLines,
        '    done < <(nix path-info "$installable" 2>/dev/null || true)',
        '    nix build --no-link "$installable" --option substituters "https://cache.nixos.org"',
      ],
    }),
    `nix build --no-link ${shellSingleQuote(flakeRef)}${extraArgs.length === 0 ? '' : ` ${extraArgs.map(shellSingleQuote).join(' ')}`} --option substituters "https://cache.nixos.org"`,
  ].join('\n'),
})

/**
 * Guard the pnpm dependency-prep contract against regressions that would
 * silently reintroduce package-manager self-bootstrap or implicit lockfile
 * normalization inside fixed-output builds.
 */
export const pnpmBuilderContractStep = ({
  builderFile = 'nix/workspace-tools/lib/mk-pnpm-deps.nix',
  name = 'Guard pnpm builder contract',
}: {
  builderFile?: string
  name?: string
}) => ({
  name,
  shell: 'bash',
  run: [
    'set -euo pipefail',
    `builder=${shellSingleQuote(builderFile)}`,
    'if [ ! -f "$builder" ]; then',
    '  echo "::error::missing pnpm deps builder: $builder"',
    '  exit 1',
    'fi',
    'for required in \\',
    "  'manage-package-manager-versions=false' \\",
    "  'npm_config_manage_package_manager_versions=false' \\",
    "  'frozenLockfile ? true' \\",
    "  'pnpm install --frozen-lockfile --ignore-scripts'; do",
    '  if ! grep -Fq -- "$required" "$builder"; then',
    '    echo "::error::missing required pnpm builder contract fragment: $required"',
    '    exit 1',
    '  fi',
    'done',
    'for forbidden in \\',
    "  'lockfile-only' \\",
    "  'pnpm add pnpm@'; do",
    '  if grep -Fq -- "$forbidden" "$builder"; then',
    '    echo "::error::forbidden pnpm builder contract fragment present: $forbidden"',
    '    exit 1',
    '  fi',
    'done',
  ].join('\n'),
})

/**
 * Resolve the devenv binary and do a fast store-path validity check.
 *
 * Previously ran `devenv info` (~25s) as an eager canary to detect any store
 * corruption before tasks run. Now uses `nix-store --check-validity` (~1-2s)
 * which only verifies the devenv store path itself. If the store path is
 * invalid, runs a targeted repair on just that path and re-resolves.
 *
 * Still captures diagnostics dir + runner fingerprint for #272 instrumentation.
 *
 * @see https://github.com/namespacelabs/nscloud-setup/issues/8
 * @see https://github.com/overengineeringstudio/effect-utils/issues/272
 */
export const validateNixStoreStep = {
  name: 'Resolve devenv',
  run: `${resolveDevenvRevScript}

${resolveDevenvFnScript}

# Temporary: capture diagnostics dir for #272 root-cause analysis.
DIAG_ROOT="${'${RUNNER_TEMP:-/tmp}'}/nix-store-diagnostics-${'${GITHUB_JOB:-job}'}-${'${RUNNER_OS:-unknown}'}-${'${GITHUB_RUN_ATTEMPT:-0}'}"
mkdir -p "$DIAG_ROOT"
echo "NIX_STORE_DIAGNOSTICS_DIR=$DIAG_ROOT" >> "$GITHUB_ENV"

{
  echo "timestamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "runner_name=${'${RUNNER_NAME:-unknown}'}"
  echo "runner_os=${'${RUNNER_OS:-unknown}'}"
  echo "runner_arch=${'${RUNNER_ARCH:-unknown}'}"
  echo "github_job=${'${GITHUB_JOB:-unknown}'}"
  echo "github_run_id=${'${GITHUB_RUN_ID:-unknown}'}"
  echo "nix_user_conf_files=${'${NIX_USER_CONF_FILES:-}'}"
  nix --version || true
} > "$DIAG_ROOT/environment.txt" 2>&1

if ! DEVENV_OUT=$(resolve_devenv 2> >(tee "$DIAG_ROOT/resolve-devenv.log" >&2)); then
  echo "::error::resolve_devenv failed. Last 30 lines of log:"
  tail -30 "$DIAG_ROOT/resolve-devenv.log" || true
  exit 1
fi
DEVENV_BIN="$DEVENV_OUT/bin/devenv"

# Fast validity check on the devenv store path (~1-2s vs ~25s for devenv info).
if ! nix-store --check-validity "$DEVENV_OUT" 2>/dev/null; then
  echo "::warning::devenv store path invalid, repairing targeted path..."
  nix-store --repair-path "$DEVENV_OUT" > "$DIAG_ROOT/nix-store-verify-repair.log" 2>&1 || true
  rm -rf "${'${XDG_CACHE_HOME:-$HOME/.cache}'}"/nix/eval-cache-* ~/.cache/nix/eval-cache-*
  if ! DEVENV_OUT=$(resolve_devenv 2> >(tee "$DIAG_ROOT/resolve-devenv-post-repair.log" >&2)); then
    echo "::error::resolve_devenv failed after repair. Last 30 lines of log:"
    tail -30 "$DIAG_ROOT/resolve-devenv-post-repair.log" || true
    exit 1
  fi
  DEVENV_BIN="$DEVENV_OUT/bin/devenv"
fi

echo "DEVENV_BIN=$DEVENV_BIN" >> "$GITHUB_ENV"
"$DEVENV_BIN" version | tee "$DIAG_ROOT/devenv-version.txt"`,
  shell: 'bash',
} as const

/**
 * Upload diagnostics captured by `validateNixStoreStep` as a CI artifact.
 * Add this step after validation/task steps so failure-path data is retained.
 */
export const nixDiagnosticsArtifactStep = (opts?: { if?: string; retentionDays?: number }) => ({
  name: 'Upload Nix diagnostics artifact',
  if: opts?.if ?? "failure() && env.NIX_STORE_DIAGNOSTICS_DIR != ''",
  uses: 'actions/upload-artifact@v4' as const,
  with: {
    name: 'nix-store-diagnostics-${{ github.job }}-${{ runner.os }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}',
    path: '${{ env.NIX_STORE_DIAGNOSTICS_DIR }}',
    'if-no-files-found': 'ignore',
    'retention-days': opts?.retentionDays ?? 14,
  },
})
