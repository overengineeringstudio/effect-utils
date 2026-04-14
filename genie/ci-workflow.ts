/**
 * Shared CI workflow building blocks for GitHub Actions.
 *
 * Provides composable step atoms and job configuration helpers
 * that peer repos import to avoid CI template duplication.
 *
 * @example
 * ```ts
 * import {
 *   checkoutStep, installNixStep, cachixStep,
 *   preparePinnedDevenvStep, validateNixStoreStep, nixDiagnosticsArtifactStep,
 *   runDevenvTasksBefore, standardCIEnv,
 * } from '../../repos/effect-utils/genie/ci-workflow.ts'
 *
 * const baseSteps = [
 *   checkoutStep(),
 *   installNixStep(),
 *   cachixStep({ name: 'my-cache' }),
 *   preparePinnedDevenvStep,
 *   validateNixStoreStep,
 *   nixDiagnosticsArtifactStep(),
 * ]
 * ```
 */

import { readFileSync } from 'node:fs'

import {
  githubWorkflow,
  type ActionlintConfig,
  type GitHubWorkflowArgs,
} from '../packages/@overeng/genie/src/runtime/mod.ts'
import { RUNNER_PROFILES, type RunnerProfile } from './ci.ts'
import {
  netlifyDeployStep as buildNetlifyDeployStep,
  netlifyStorybookCommentStep as buildNetlifyStorybookCommentStep,
} from './deploy-preview/netlify.ts'
import {
  type VercelProject,
  vercelDeployJobs as buildVercelDeployJobs,
  vercelDeployStep as buildVercelDeployStep,
} from './deploy-preview/vercel.ts'

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
 * Cancel superseded CI workflow runs for the same PR or branch.
 *
 * The group key intentionally does not include the job name so a new push
 * cancels the entire older workflow run rather than letting stale sibling jobs
 * continue consuming runner capacity.
 */
export const ciWorkflowConcurrency = {
  group: '${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
  'cancel-in-progress': true,
} as const

/**
 * Standard wrapper for composed CI workflows.
 *
 * This keeps cancellation policy centralized in `effect-utils` instead of
 * making each consumer remember to wire `concurrency` by hand. Repos can still
 * override the policy by passing an explicit `concurrency` field.
 */
export const ciWorkflow = (args: GitHubWorkflowArgs) =>
  (({ concurrency, actionlint, ...rest }) =>
    githubWorkflow({
      concurrency: concurrency ?? ciWorkflowConcurrency,
      actionlint: actionlint ?? defaultActionlintConfig,
      ...rest,
    }))(args)

type NixConfigOptions = {
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

const cachixHostsFromBinaryCaches = (caches: readonly NixBinaryCache[]) => [
  ...new Set(
    caches.flatMap((cache) => {
      const host = new URL(cache.uri).host
      return host.endsWith('.cachix.org') ? [host] : []
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

const devenvBinRef = '"${DEVENV_BIN:?DEVENV_BIN not set}"'

const resolveDevenvRevScript = `DEVENV_REV=$(jq -r .nodes.devenv.locked.rev devenv.lock)
if [ -z "$DEVENV_REV" ] || [ "$DEVENV_REV" = "null" ]; then
  echo '::error::devenv.lock missing .nodes.devenv.locked.rev'
  exit 1
fi`

const resolveDevenvFnScript = `resolve_devenv() {
  nix build --no-link --print-out-paths "github:cachix/devenv/$DEVENV_REV#devenv"
}`

const shellSingleQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

/** Build extra-conf / NIX_CONFIG content for common Nix feature flags. */
export const nixExtraConf = (opts: NixConfigOptions = {}) =>
  [
    ...(opts.unrestrictedEval === true ? ['restrict-eval = false'] : []),
    ...(opts.extraLines ?? []),
  ].join('\n')

const withAppendedNixConfig = ({
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

/**
 * Fall back to the standard CI pnpm paths when a workflow has not exported
 * them via `pnpmStateSetupStep` yet. This keeps `runDevenvTasksBefore` safe for
 * downstream callers while effect-utils centralizes the preferred setup step.
 */
const withCiPnpmState = (command: string) =>
  `PNPM_HOME="\${PNPM_HOME:-${jobLocalPnpmHome}}" PNPM_STORE_DIR="\${PNPM_STORE_DIR:-${jobLocalPnpmStore}}" ${command}`

const runDevenvTasksBeforeWithOptions = (opts: NixConfigOptions, ...args: [string, ...string[]]) =>
  withAppendedNixConfig({
    command: withCiPnpmState(
      `DT_PASSTHROUGH=1 ${devenvBinRef} tasks run ${args.join(' ')} --mode before`,
    ),
    opts,
  })

const readCiHelperScript = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8').trim()

const nixGcRaceRetryScript = readCiHelperScript('./ci-scripts/nix-gc-race-retry.sh')

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
 * TODO: Remove once NixOS/nix#15469 and DeterminateSystems/nix-src#395 are released
 * @see https://github.com/NixOS/nix/pull/15469
 * @see https://github.com/DeterminateSystems/nix-src/issues/395
 */
const withGcRaceRetry = ({ command, label }: { command: string; label: string }) => {
  const quotedCommand = shellSingleQuote(command)
  const quotedLabel = shellSingleQuote(label)
  return [
    '__nix_gc_retry_helper=$(mktemp)',
    'cat > "$__nix_gc_retry_helper" <<\'EOF\'',
    nixGcRaceRetryScript,
    'EOF',
    '. "$__nix_gc_retry_helper"',
    'rm -f "$__nix_gc_retry_helper"',
    `run_nix_gc_race_retry ${quotedLabel} ${quotedCommand}`,
  ].join('\n')
}

/** Build a command that runs one or more devenv tasks with `--mode before`. */
export const runDevenvTasksBefore = (...args: [string, ...string[]]) =>
  withGcRaceRetry({
    command: runDevenvTasksBeforeWithOptions({ unrestrictedEval: true }, ...args),
    label: `devenv tasks run ${args.join(' ')} --mode before`,
  })

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

/** Enable a Cachix binary cache */
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

/**
 * Export the canonical CI pnpm paths once so every later shell step shares the
 * same writable store and the same workspace-relative GVS projection.
 */
export const pnpmStateSetupStep = {
  name: 'Isolate pnpm state',
  shell: 'bash',
  run: [
    `echo "PNPM_STORE_DIR=${jobLocalPnpmStore}" >> "$GITHUB_ENV"`,
    `echo "PNPM_HOME=${jobLocalPnpmHome}" >> "$GITHUB_ENV"`,
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
  '  else',
  '    cat /proc/meminfo',
  '  fi',
  '  echo',
  '  if [ -r /proc/pressure/memory ]; then',
  '    cat /proc/pressure/memory',
  '  fi',
  '  echo',
  '  df -h /',
  '  echo',
  '  ps -eo pid,ppid,user,%cpu,%mem,etime,stat,command --sort=-%cpu | head -15',
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
export const pnpmInstallWithDiagnosticsStep = {
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
} as const

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

    return [
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
 * silently reintroduce package-manager self-bootstrap or non-frozen lockfile
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
    "  'pnpm install --frozen-lockfile --ignore-scripts'; do",
    '  if ! grep -Fq -- "$required" "$builder"; then',
    '    echo "::error::missing required pnpm builder contract fragment: $required"',
    '    exit 1',
    '  fi',
    'done',
    'for forbidden in \\',
    "  '--no-frozen-lockfile' \\",
    "  'lockfile-only' \\",
    "  'pnpm add pnpm@'; do",
    '  if grep -Fq -- "$forbidden" "$builder"; then',
    '    echo "::error::forbidden pnpm builder contract fragment present: $forbidden"',
    '    exit 1',
    '  fi',
    'done',
  ].join('\n'),
})

/** Ephemeral per-job megarepo store path scoped to the CI run/attempt/job */
export const jobLocalMegarepoStore =
  '${{ runner.temp }}/megarepo-store/${{ github.run_id }}/${{ github.run_attempt }}/${{ github.job }}'

/** Install megarepo CLI from effect-utils */
export const installMegarepoStep = {
  name: 'Install megarepo CLI',
  run: 'nix profile install github:overengineeringstudio/effect-utils#megarepo',
  shell: 'bash',
} as const

/** Fetch latest refs and apply megarepo workspace. */
export const syncMegarepoWorkspaceStep = (opts?: { skip?: string[] }) => {
  const args = ['mr', 'fetch', '--apply']
  if (opts?.skip !== undefined) for (const s of opts.skip) args.push('--skip', s)
  return {
    name: 'Sync megarepo dependencies',
    env: { MEGAREPO_STORE: jobLocalMegarepoStore },
    run: `mkdir -p "$MEGAREPO_STORE"
echo "Using job-local megarepo store: $MEGAREPO_STORE"
${args.join(' ')}`,
    shell: 'bash',
  }
}

/**
 * Sync megarepo state using the locked effect-utils commit from megarepo.lock.
 * CI must use `apply --all` so the workspace stays on the checked-in lock
 * shape instead of silently drifting to newer branch heads during job setup.
 * Resolves the CLI inline with `nix run` to avoid `nix profile install`
 * conflicts on self-hosted runners.
 */
export const applyMegarepoLockStep = (opts?: { skip?: string[] }) => {
  const skipArgs = opts?.skip?.flatMap((s) => ['--skip', s]).join(' ') ?? ''
  return {
    name: 'Sync megarepo dependencies',
    env: { MEGAREPO_STORE: jobLocalMegarepoStore },
    run: `EU_REV=$(jq -r '.members["effect-utils"].commit' megarepo.lock)
if [ -z "$EU_REV" ] || [ "$EU_REV" = "null" ]; then
  echo '::error::megarepo.lock missing members["effect-utils"].commit'
  exit 1
fi
mkdir -p "$MEGAREPO_STORE"
echo "Using job-local megarepo store: $MEGAREPO_STORE"
nix run "github:overengineeringstudio/effect-utils/$EU_REV#megarepo" -- apply --all${skipArgs !== '' ? ` ${skipArgs}` : ''}`,
    shell: 'bash',
  }
}

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
  run: `if [ -z "${'${DEVENV_REV:-}'}" ]; then
  ${resolveDevenvRevScript}
fi

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
  rm -rf ~/.cache/nix/eval-cache-*
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

/** Job-level permissions required by `deployCommentStep` to post/edit PR comments. */
export const deployCommentPermissions = {
  contents: 'read',
  'pull-requests': 'write',
} as const

/** Shared mode detection script for deploy comments. Sets `label` based on event type. */
export const deployModeScript = [
  'if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then',
  '  label="prod"',
  'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
  '  label="PR #${{ github.event.pull_request.number }}"',
  'else',
  '  exit 0',
  'fi',
].join('\n')

/**
 * Reusable step that writes a deployment summary and upserts a PR comment.
 *
 * The consuming job must include `permissions: deployCommentPermissions` (or equivalent)
 * so that `github.token` can read/write PR comments.
 *
 * The provided scripts run in order and must:
 * - `modeScript`: set `label` (or `exit 0` for unsupported events)
 * - `rowsScript`: set `rows` as markdown table rows (`| a | b |\n`)
 */
export const deployCommentStep = (opts: {
  summaryTitle: string
  tableHeaders: readonly [string, string]
  modeScript: string
  rowsScript: string
  noRowsMessage: string
  commentTitle?: string
  if?: string
}) => ({
  name: 'Post deploy URLs',
  if: opts.if ?? 'always() && !cancelled()',
  shell: 'bash' as const,
  env: {
    GH_TOKEN: '${{ github.token }}',
    GH_REPO: '${{ github.repository }}',
  },
  run: [
    opts.modeScript,
    '',
    opts.rowsScript,
    '',
    'if [ -z "$rows" ]; then',
    `  echo "${opts.noRowsMessage}" >> "$GITHUB_STEP_SUMMARY"`,
    '  exit 0',
    'fi',
    '',
    '# Write job summary',
    '{',
    `  echo "## ${opts.summaryTitle} ($label)"`,
    '  echo ""',
    `  echo "| ${opts.tableHeaders[0]} | ${opts.tableHeaders[1]} |"`,
    '  echo "| --- | --- |"',
    '  echo -e "$rows"',
    '} >> "$GITHUB_STEP_SUMMARY"',
    '',
    '# Post/update PR comment',
    'if [ "${{ github.event_name }}" = "pull_request" ]; then',
    '  {',
    `    echo "## ${opts.commentTitle ?? opts.summaryTitle}"`,
    '    echo ""',
    `    echo "| ${opts.tableHeaders[0]} | ${opts.tableHeaders[1]} |"`,
    '    echo "| --- | --- |"',
    '    echo -e "$rows"',
    '  } > /tmp/comment.md',
    '  export NIX_CONFIG="${NIX_CONFIG:+$NIX_CONFIG$\'\\n\'}access-tokens = github.com=${GH_TOKEN}"',
    '  nix run nixpkgs#gh -- pr comment "${{ github.event.pull_request.number }}" --body-file /tmp/comment.md --edit-last 2>/dev/null \\',
    '    || nix run nixpkgs#gh -- pr comment "${{ github.event.pull_request.number }}" --body-file /tmp/comment.md',
    'fi',
  ].join('\n'),
})

/**
 * Step that dispatches `upstream-changed` repository_dispatch to a target repo.
 * Add this to upstream CI workflows so merges to main trigger downstream alignment.
 *
 * Uses `nix run nixpkgs#gh` since self-hosted runners have Nix installed.
 *
 * Requires `MEGAREPO_ALIGNMENT_TOKEN` secret (fine-grained PAT with Contents + Pull Requests write).
 */
export const dispatchAlignmentStep = (opts: {
  /** Target repo that receives the dispatch (e.g. 'schickling/megarepo-all') */
  targetRepo: string
  /** Event type sent in the dispatch (default: 'upstream-changed') */
  eventType?: string
}) => ({
  name: 'Dispatch alignment to coordinator',
  env: { GH_TOKEN: '${{ secrets.MEGAREPO_ALIGNMENT_TOKEN }}' },
  run: [
    `export NIX_CONFIG="${"${NIX_CONFIG:+$NIX_CONFIG$'\\n'}"}access-tokens = github.com=${'${GH_TOKEN}'}"`,
    `printf '{"event_type":"${opts.eventType ?? 'upstream-changed'}","client_payload":{"source_repo":"%s","source_sha":"%s"}}' "${'${{ github.repository }}'}" "${'${{ github.sha }}'}" | nix run nixpkgs#gh -- api repos/${opts.targetRepo}/dispatches --input -`,
  ].join(' && '),
  shell: 'bash',
})

/**
 * Complete notify-alignment job definition.
 * Runs on self-hosted runner after CI passes, dispatches `upstream-changed` to the coordinator.
 */
export const notifyAlignmentJob = (opts: {
  targetRepo: string
  needs: readonly string[]
  /** Branches that trigger notification (default: main only) */
  branches?: readonly string[]
}) => ({
  'runs-on': linuxX64Runner,
  needs: [...opts.needs],
  if: `(${(opts.branches ?? ['main']).map((b) => `github.ref == 'refs/heads/${b}'`).join(' || ')}) && github.event_name == 'push'`,
  steps: [dispatchAlignmentStep({ targetRepo: opts.targetRepo })],
})

// =============================================================================
// Vercel Deploy Helpers
// =============================================================================

/**
 * Deploy a single Vercel project via devenv task.
 * Prod on push-to-main/schedule/dispatch, preview on PRs.
 * Captures final/raw deploy URLs plus deploy completion time and exports them
 * to both GITHUB_ENV and GITHUB_OUTPUT.
 */
export const vercelDeployStep = (project: { name: string; urlEnvKey?: string }) =>
  buildVercelDeployStep(project, runDevenvTasksBefore)

/**
 * Configure git author so Vercel Deployment Protection
 * associates the deploy with a team member.
 */
export const vercelGitAuthorStep = (opts: { name: string; email: string }) => ({
  name: 'Configure git author for Vercel',
  shell: 'bash' as const,
  run: [
    `git config user.name "${opts.name}"`,
    `git config user.email "${opts.email}"`,
    'git commit --amend --no-edit --reset-author',
  ].join('\n'),
})

/**
 * Generate Vercel deploy jobs and optionally a combined comment collector job.
 *
 * Returns a flat record of GitHub Actions jobs:
 * - `deploy-<name>` — one per project, runs `vercelDeployStep`, exposes structured deploy metadata
 * - `post-deploy-comment` — optional lightweight job that collects URLs from all
 *   deploy jobs and posts a stateful deploy preview comment
 *
 * The helper is deployment-mode agnostic. The unified `vercel.nix` task module
 * decides whether a project runs build mode or static mode based on `cwd` vs
 * `staticDir`; CI only needs to invoke `vercel:deploy:<name>`.
 */
export const vercelDeployJobs = (opts: {
  projects: readonly VercelProject[]
  /** CI job names that deploy jobs depend on */
  needs?: readonly string[]
  runner: readonly string[]
  baseSteps: readonly Record<string, unknown>[]
  env: Record<string, string>
  /** Extra steps to add after deploy */
  extraSteps?: readonly Record<string, unknown>[]
  /** Deploy condition override. Default: always after CI passes, or directly on schedule. */
  deployCondition?: string
  /** Whether to add a combined deploy comment job. Default: true. */
  includeComment?: boolean
  commentTitle?: string
  noRowsMessage?: string
  deployStepDecorator?: (
    step: Record<string, unknown>,
    project: VercelProject,
  ) => Record<string, unknown>
}): Record<string, Record<string, unknown>> => {
  return buildVercelDeployJobs({
    ...opts,
    runDevenvTasksBefore,
    deployModeScript,
    deployCommentPermissions,
    bashShellDefaults,
    commentRunner: linuxX64Runner,
  })
}

// =============================================================================
// Netlify Deploy Helpers
// =============================================================================

/**
 * Deploy step for Netlify storybooks via devenv tasks.
 * Runs `netlify:deploy` with prod/PR mode based on the event trigger.
 * Gracefully skips if NETLIFY_AUTH_TOKEN is not available.
 */
export const netlifyDeployStep = () => buildNetlifyDeployStep(runDevenvTasksBefore)

/**
 * Combined deploy comment step for Netlify storybook previews.
 *
 * When `packages` is provided, constructs preview URLs directly from the known package list.
 * This works regardless of whether the deploy task emits metadata markers, making it suitable
 * for repos that pin an older effect-utils version for Nix while using the latest for genie.
 *
 * When omitted, uses the metadata-based approach that reads deploy output from the deploy step.
 *
 * The `packages` shape matches the Nix `taskModules.netlify` / `taskModules.storybook` config:
 * `{ path: "flakes/oi", name: "flakes-oi" }` where `name` is the Netlify deploy alias.
 */
export const netlifyStorybookCommentStep = (
  site: string,
  opts?: { packages?: ReadonlyArray<{ path: string; name: string }> },
) => {
  if (!opts?.packages) {
    return buildNetlifyStorybookCommentStep(site, deployModeScript)
  }

  return deployCommentStep({
    summaryTitle: 'Storybook Previews',
    tableHeaders: ['Package', 'URL'],
    noRowsMessage: 'No storybooks were deployed.',
    modeScript: [
      `site="${site}"`,
      deployModeScript,
      '# Set Netlify branch-deploy suffix based on mode',
      'if [ "$label" = "prod" ]; then suffix=""; else suffix="-pr-${{ github.event.pull_request.number }}"; fi',
    ].join('\n'),
    rowsScript: [
      'rows=""',
      ...opts.packages.map((pkg) =>
        [
          `if [ -d "${pkg.path}/storybook-static" ]; then`,
          `  rows="\${rows}| ${pkg.name} | https://${pkg.name}\${suffix}--\${site}.netlify.app |\\n"`,
          'fi',
        ].join('\n'),
      ),
    ].join('\n'),
  })
}
