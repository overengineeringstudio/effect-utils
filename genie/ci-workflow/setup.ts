import { pinnedAction } from '../../packages/@overeng/genie/src/runtime/github-workflow/action-pins.ts'

import { pipelineDevenvStepName } from '../../packages/@overeng/ci-tools/src/pipeline-job-names.ts'
import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { renderBinaryCachesExtraConf } from './binary-cache-composition.ts'
import type { BinaryCacheDescriptor } from './binary-cache-descriptors.ts'
import {
  jobCacheDescriptors,
  trustedCacheWriterGuardedSecret,
  publisherWriteSecret,
  CachePublisherJobError,
} from './cache-policy.ts'
import { applyMegarepoLockStep } from './megarepo.ts'
import type { RunnerProfile } from './runners.ts'
import {
  bashShellDefaults,
  defaultCiRuntimeScriptsDir,
  jobLocalCiDiagnosticsDir,
  githubTokenEnv,
  resolveDevenvRevScriptFor,
  linuxX64Runner,
  runDevenvTasksBefore,
  shellSingleQuote,
  withGcRaceRetry,
  preparedCiRuntimeScriptsDir,
  ciNixCachePath,
  ciNixCacheRoot,
  ciPnpmHome,
  ciPnpmStore,
  ciCompositionStateRoot,
  withCiSourceRoot,
  linuxNixSandboxFallbackConf,
  linuxSandboxAdmissionStepId,
  namespacePrivilegeTrustedPredicate,
} from './shared.ts'

type WorkflowJob = GitHubWorkflowArgs['jobs'][string]
type WorkflowStep = WorkflowJob['steps'][number]

const evictPnpmDepsCachedOutputsScript = `${preparedCiRuntimeScriptsDir}/evict-pnpm-deps-cached-outputs.sh`

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
  env: githubTokenEnv(),
  run: withCiSourceRoot(
    `bash ${shellSingleQuote(evictPnpmDepsCachedOutputsScript)} ${shellSingleQuote(flakeRef)}`,
  ),
})

export type NamespacePrivilege = 'always' | 'trusted' | 'never'

/**
 * Namespace runner with run ID-based affinity to prevent queue jumping, so
 * runners spawned for one workflow run don't steal jobs from other runs.
 *
 * Namespace accepts the `namespace-features:` label only next to a
 * `-with-features` machine label; runner profiles take features appended as
 * `;key=value` to the profile label itself.
 * Privilege is an explicit per-job choice, never a profile-wide default.
 * Namespace isolates Linux privilege inside each ephemeral per-job VM.
 * Priority is opt-in: omitting it preserves labels for downstream consumers.
 * @see https://namespace.so/docs/solutions/github-actions/runner-controls
 */
export const namespaceRunner = ({
  profile,
  runId,
  privileged,
  priority,
}: {
  profile: RunnerProfile | (string & {})
  runId: string
  privileged: NamespacePrivilege
  priority?: number | string
}): readonly [string] | readonly [string, string] => {
  if (privileged !== 'always' && privileged !== 'trusted' && privileged !== 'never') {
    throw new Error('namespaceRunner requires explicit privileged: always, trusted or never')
  }
  const profileExpression = /^\$\{\{([\s\S]+)\}\}$/.exec(profile)?.[1]?.trim()
  const isLinux = profile.includes('linux') || profile.startsWith('nscloud-ubuntu-')
  const linuxPredicate =
    profileExpression === undefined
      ? undefined
      : `(contains(${profileExpression}, 'linux') || startsWith(${profileExpression}, 'nscloud-ubuntu-'))`
  const trustedPredicate = `(${namespacePrivilegeTrustedPredicate})`
  const privilegePredicate =
    linuxPredicate === undefined
      ? trustedPredicate
      : privileged === 'trusted'
        ? `${linuxPredicate} && ${trustedPredicate}`
        : linuxPredicate
  const privilegeFeature =
    privileged === 'never' || (isLinux === false && linuxPredicate === undefined)
      ? ''
      : privileged === 'always' && linuxPredicate === undefined
        ? ';container.privileged=true'
        : `\${{ ${privilegePredicate} && ';container.privileged=true' || '' }}`
  const priorityFeature = priority === undefined ? '' : `;job.priority=${priority}`
  const features = `github.run-id=${runId}${privilegeFeature}`
  return profile.endsWith('-with-features') === true
    ? [`${profile}${priorityFeature}`, `namespace-features:${features}`]
    : [`${profile};${features}${priorityFeature}`]
}

// =============================================================================
// Step Atoms
// =============================================================================

/** Checkout repository via the pinned actions/checkout release. */
export const checkoutStep = (opts?: { repository?: string; ref?: string; path?: string }) => ({
  ...pinnedAction({ name: 'checkout' }),
  with: { 'persist-credentials': false, ...opts },
})

export const prepareCiScriptsStep = {
  name: 'Prepare CI helper scripts',
  shell: 'bash',
  run: withCiSourceRoot(
    [
      'set -euo pipefail',
      `scripts_src=${shellSingleQuote(defaultCiRuntimeScriptsDir)}`,
      `scripts_dst=${shellSingleQuote(preparedCiRuntimeScriptsDir)}`,
      'if [ ! -d "$scripts_src" ]; then',
      '  echo "::error::CI helper script directory is missing: $scripts_src"',
      '  exit 1',
      'fi',
      'rm -rf "$scripts_dst"',
      'mkdir -p "$scripts_dst"',
      'cp -R "$scripts_src/." "$scripts_dst/"',
      'rm -f "$scripts_dst"/*.genie.ts',
      'chmod +x "$scripts_dst"/*.sh',
    ].join('\n'),
  ),
} as const

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
  ...pinnedAction({ name: 'createGithubAppToken' }),
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
  ...githubTokenEnv(tokenExpression),
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
>({
  step,
  tokenExpression,
}: {
  step: TStep
  tokenExpression: string
}): TStep => ({
  ...step,
  env: {
    ...step.env,
    ...githubAccessTokenEnv(tokenExpression),
  },
})

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
  binaryCaches?: readonly BinaryCacheDescriptor[]
  extraConf?: string
  githubAccessTokenExpression?: string
  summarize?: boolean
}) => ({
  [jobCacheDescriptors]: opts?.binaryCaches ?? [],
  name: 'Install Nix',
  ...pinnedAction({ name: 'determinateNix' }),
  env: githubTokenEnv(opts?.githubAccessTokenExpression),
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
      renderBinaryCachesExtraConf(opts?.binaryCaches ?? []),
      `access-tokens = github.com=${opts?.githubAccessTokenExpression ?? '${{ github.token }}'}`,
      ...(opts?.extraConf !== undefined ? [opts.extraConf] : []),
      linuxNixSandboxFallbackConf,
    ].join('\n'),
    summarize: opts?.summarize ?? true,
  },
})

/**
 * Linux namespace prerequisites behind Nix's build sandbox and nested TS
 * Bubblewrap. Only the trusted policy reads PR identity; always jobs do not.
 */
export const linuxSandboxPrerequisitesStep = ({ privileged }: { privileged: NamespacePrivilege }) =>
  ({
    id: linuxSandboxAdmissionStepId,
    name: 'Log Linux sandbox prerequisites',
    if: "${{ runner.os == 'Linux' }}",
    shell: 'bash',
    env: {
      BUCK2_TS_PRIVILEGE_ALLOWED:
        privileged === 'trusted'
          ? `\${{ ${namespacePrivilegeTrustedPredicate} }}`
          : privileged === 'always'
            ? 'true'
            : 'false',
    },
    run: [
      'set -euo pipefail',
      'if [ "$BUCK2_TS_PRIVILEGE_ALLOWED" != true ]; then',
      '  echo "::error::Buck TypeScript lane refused: untrusted pull_request runs on an unprivileged Namespace runner; privileged Nix/Bubblewrap execution is not admitted (fork policy Q49 pending)." >&2',
      '  exit 1',
      'fi',
      "nix config show | grep -E '^sandbox'",
      'for key in kernel.apparmor_restrict_unprivileged_userns user.max_user_namespaces; do',
      '  if sysctl "$key"; then :; else printf "Unavailable sysctl: %s\\n" "$key"; fi',
      'done',
      'unshare -Ur true',
      'echo "unshare -Ur true: passed"',
    ].join('\n'),
  }) as const

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
  env: githubTokenEnv(),
  run: [
    'set -euo pipefail',
    'out=$(nix build --no-link --print-out-paths nixpkgs#cachix)',
    'echo "$out/bin" >> "$GITHUB_PATH"',
  ].join('\n'),
} as const

/** Read-only Cachix action. Publishing requires the protected publisher constructor. */
export const cachixStep = (opts: { name: string }) => ({
  name: 'Enable Cachix cache',
  ...pinnedAction({ name: 'cachix' }),
  with: { name: opts.name, skipPush: true },
})

type CachePublisherScope = {
  jobIf: string
  triggers: readonly ('push' | 'workflow_dispatch' | 'schedule')[]
}

const protectedPublisherIf = (opts: CachePublisherScope) => {
  if (
    opts.jobIf.includes("github.ref == 'refs/heads/main'") === false ||
    opts.triggers.length === 0 ||
    opts.triggers.some(
      (trigger) => opts.jobIf.includes(`github.event_name == '${trigger}'`) === false,
    ) === true
  ) {
    throw new CachePublisherJobError('publisher')
  }
  return `github.ref == 'refs/heads/main' && (${opts.triggers.map((trigger) => `github.event_name == '${trigger}'`).join(' || ')})`
}

const publisherSecretName = (authToken: string) =>
  /\bsecrets\.([A-Za-z_][A-Za-z_0-9]*)\b/.exec(authToken)?.[1] ?? 'CACHIX_AUTH_TOKEN'

/** Guard an explicit `cachix push` shell step; only this step receives the write secret. */
export const cachixPushStep = <TStep extends { if?: string; env?: Record<string, string> }>(
  opts: CachePublisherScope & { step: TStep; authToken: string },
) => {
  const condition = protectedPublisherIf(opts)
  return {
    [publisherWriteSecret]: publisherSecretName(opts.authToken),
    ...opts.step,
    if: opts.step.if === undefined ? condition : `${condition} && (${opts.step.if})`,
    env: { ...opts.step.env, CACHIX_AUTH_TOKEN: opts.authToken },
  }
}

/** Public Buck2 writer credential, supplied only to protected publisher steps. */
export const buck2PublicCacheWriteSecret = 'BUCK2_PUBLIC_CACHE_WRITE_AUTH'

/**
 * Publish gating results on protected main pushes and merge groups, never PRs.
 * The trusted-writer posture makes opportunistic uploads fail open (q10/q11/q14),
 * unlike the dedicated trusted proof. Only the masked Base64 header reaches Buck.
 */
export const buck2TrustedCacheWriterStep = <
  TStep extends { env?: Record<string, string>; run: string },
>(
  step: TStep,
) => ({
  ...step,
  [publisherWriteSecret]: buck2PublicCacheWriteSecret,
  env: {
    ...step.env,
    BUCK2_PUBLIC_CACHE_WRITE_AUTH: trustedCacheWriterGuardedSecret(buck2PublicCacheWriteSecret),
  },
  run: [
    'if [ -n "${BUCK2_PUBLIC_CACHE_WRITE_AUTH:-}" ]; then',
    '  BUCK2_CACHE_WRITE_BASIC_AUTH="$(printf \'%s\' "$BUCK2_PUBLIC_CACHE_WRITE_AUTH" | base64 | tr -d \'\\n\')"',
    '  echo "::add-mask::$BUCK2_CACHE_WRITE_BASIC_AUTH"',
    '  export BUCK2_CACHE_WRITE_BASIC_AUTH',
    'fi',
    'unset BUCK2_PUBLIC_CACHE_WRITE_AUTH',
    step.run,
  ].join('\n'),
})

export const cachixPublisherStep = (
  opts: CachePublisherScope & {
    name: string
    authToken: string
  },
) => ({
  [publisherWriteSecret]: publisherSecretName(opts.authToken),
  name: 'Publish to Cachix',
  if: protectedPublisherIf(opts),
  ...pinnedAction({ name: 'cachix' }),
  with: { name: opts.name, authToken: opts.authToken },
})

/**
 * Prepare lock-pinned devenv metadata from devenv.lock.
 */
export const preparePinnedDevenvStepFor = (lockFile = 'devenv.lock') =>
  ({
    name: 'Use pinned devenv from lock',
    run: withCiSourceRoot(`${resolveDevenvRevScriptFor(lockFile)}
echo "DEVENV_REV=$DEVENV_REV" >> "$GITHUB_ENV"
echo "Pinned devenv rev: $DEVENV_REV"`),
    shell: 'bash',
  }) as const

export const preparePinnedDevenvStep = preparePinnedDevenvStepFor()

/**
 * Export the canonical CI pnpm paths once so every later shell step shares the
 * same job-local home and content store. Writable virtual topology stays under
 * the workspace root.
 */
export const pnpmStateSetupStep = {
  name: 'Isolate pnpm state',
  shell: 'bash',
  run: withCiSourceRoot(
    [
      'set -euo pipefail',
      `mkdir -p "${ciPnpmStore}" "${ciPnpmHome}" .devenv`,
      'member_store=.devenv/pnpm-store-pure-v1',
      'if [ -L "$member_store" ]; then',
      `  if [ "$(readlink "$member_store")" != "${ciPnpmStore}" ]; then`,
      '    echo "::error::owned member pnpm store symlink has the wrong target: $member_store" >&2',
      '    exit 1',
      '  fi',
      'elif [ -e "$member_store" ]; then',
      '  echo "::error::refusing non-symlink owned member pnpm store path: $member_store" >&2',
      '  exit 1',
      'else',
      `  ln -s "${ciPnpmStore}" "$member_store"`,
      'fi',
      `echo "PNPM_STORE_DIR=${ciPnpmStore}" >> "$GITHUB_ENV"`,
      `echo "PNPM_CONFIG_STORE_DIR=${ciPnpmStore}" >> "$GITHUB_ENV"`,
      `echo "PNPM_HOME=${ciPnpmHome}" >> "$GITHUB_ENV"`,
    ].join('\n'),
  ),
} as const

/**
 * Export the canonical workspace-local Nix cache root so later steps share the
 * same mutable client cache surface across one CI job.
 */
export const nixCacheSetupStep = {
  name: 'Isolate nix cache',
  shell: 'bash',
  run: [
    `mkdir -p "${ciNixCachePath}"`,
    `echo "XDG_CACHE_HOME=${ciNixCacheRoot}" >> "$GITHUB_ENV"`,
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
    env: githubTokenEnv(),
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

const nixCachePrimaryKey = ({
  keyPrefix,
  hashFilesExpression,
}: {
  keyPrefix: string
  hashFilesExpression: string
}) => `${keyPrefix}-${'${{ runner.os }}'}-${'${{ runner.arch }}'}-${hashFilesExpression}`

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
  const path = opts?.path ?? ciNixCachePath
  const hashFilesExpression =
    opts?.hashFilesExpression ?? "${{ hashFiles('devenv.lock', 'flake.lock', 'megarepo.lock') }}"

  return {
    id: opts?.stepId ?? 'restore-nix-cache',
    name: 'Restore nix cache',
    ...pinnedAction({ name: 'cache', subpath: 'restore' }),
    with: {
      path,
      key: nixCachePrimaryKey({ keyPrefix, hashFilesExpression }),
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
  const path = opts?.path ?? ciNixCachePath

  return {
    name: 'Save nix cache',
    if: `\${{ always() && steps.${restoreStepId}.outputs.cache-primary-key != '' }}`,
    ...pinnedAction({ name: 'cache', subpath: 'save' }),
    with: {
      path,
      key: `\${{ steps.${restoreStepId}.outputs.cache-primary-key }}`,
    },
  }
}

/**
 * Shared self-hosted CI setup for repos that prepare a devenv workspace,
 * isolate job-local mutable state, and run `pnpm:install` before the main task.
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
  includeDiagnostics?: boolean
}) =>
  [
    checkoutStep(opts?.checkout),
    installNixStep(opts?.installNix),
    prepareCiScriptsStep,
    preparePinnedDevenvStep,
    nixCacheSetupStep,
    restoreNixCacheStep(opts?.restoreNixCache),
    validateNixStoreStep,
    ...(opts?.applyMegarepoLock === false ? [] : [applyMegarepoLockStep(opts?.applyMegarepoLock)]),
    pnpmStateSetupStep,
    ciDiagnosticsSetupStep,
    ...(opts?.includeDiagnostics === false ? [] : [captureRunnerPressureStep]),
    pnpmInstallWithDiagnosticsStep(),
  ] as const

/**
 * Shared self-hosted CI tail for repos that save the Nix cache and keep
 * pnpm / runner diagnostics attached to the finished job.
 */
export const standardSelfHostedPnpmCiPostSteps = (opts?: {
  saveNixCache?: Parameters<typeof saveNixCacheStep>[0]
  includeDiagnosticsArtifact?: boolean
}) =>
  [
    saveNixCacheStep(opts?.saveNixCache),
    ...(opts?.includeDiagnosticsArtifact === false ? [] : [ciDiagnosticsArtifactStep()]),
  ] as const

/** Enable file-backed OTLP delivery for every traced devenv task in this CI job. */
export const prepareCiOtelSpoolStep = {
  name: 'Prepare CI OpenTelemetry capture',
  shell: 'bash',
  run: [
    'set -euo pipefail',
    `spool_dir="${ciCompositionStateRoot}/otel-spans"`,
    'mkdir -p "$spool_dir"',
    'printf \'OTEL_SPAN_SPOOL_DIR=%s\\n\' "$spool_dir" >> "$GITHUB_ENV"',
    'printf \'OTEL_SPOOL_MULTI_WRITER=1\\n\' >> "$GITHUB_ENV"',
  ].join('\n'),
} as const

/** Render the slowest traced tasks directly in the GitHub job summary. */
export const ciOtelSpansSummaryStep = {
  name: 'Summarize CI OpenTelemetry spans',
  if: "always() && env.OTEL_SPAN_SPOOL_DIR != ''",
  shell: 'bash',
  run: [
    'set -euo pipefail',
    'shopt -s nullglob',
    'span_files=("$OTEL_SPAN_SPOOL_DIR"/*.jsonl)',
    'if [ "${#span_files[@]}" -eq 0 ]; then',
    '  echo "::notice::No CI OpenTelemetry task spans were emitted"',
    '  exit 0',
    'fi',
    '{',
    '  echo "## Slowest devenv tasks"',
    '  echo ""',
    '  echo "| Task | Duration | Status |"',
    '  echo "| --- | ---: | --- |"',
    "  while IFS=$'\\t' read -r duration task status; do",
    '    printf \'| `%s` | %.2fs | %s |\\n\' "$task" "$duration" "$status"',
    '  done < <(',
    "    jq -s -r '",
    '      [.[].resourceSpans[].scopeSpans[].spans[]',
    '        | select(.name == "devenv.task.exec")',
    '        | (.attributes | map({ key, value: (.value.stringValue // .value.intValue // .value.boolValue) }) | from_entries) as $attrs',
    '        | [',
    '            (((.endTimeUnixNano | tonumber) - (.startTimeUnixNano | tonumber)) / 1000000000),',
    '            ($attrs["task.name"] // $attrs["span.label"] // .name),',
    '            (if (.status.code // 0) == 2 then "error" else "ok" end)',
    '          ]',
    '        | @tsv',
    '      ] | .[]',
    "    ' \"${span_files[@]}\" | sort -nr | sed -n '1,20p'",
    '  )',
    '} >> "$GITHUB_STEP_SUMMARY"',
  ].join('\n'),
} as const

/** Preserve each job's OTLP payload so traces remain inspectable without network credentials. */
export const ciOtelSpansArtifactStep = {
  name: 'Upload CI OpenTelemetry spans',
  if: "always() && env.OTEL_SPAN_SPOOL_DIR != ''",
  ...pinnedAction({ name: 'uploadArtifact' }),
  with: {
    name: 'ci-otel-${{ github.job }}-${{ runner.os }}-${{ runner.arch }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}',
    path: '${{ env.OTEL_SPAN_SPOOL_DIR }}',
    'if-no-files-found': 'warn',
    'retention-days': 14,
  },
} as const

export const devenvTaskStep = (name: string, ...args: [string, ...string[]]) => ({
  name,
  env: githubTokenEnv(),
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
  env,
  prepSteps,
  postSteps,
  prep,
  post,
  step,
  ...jobOptions
}: StandardSelfHostedDevenvTaskJobOptions): WorkflowJob => ({
  'runs-on': Array.isArray(runsOn) === true ? [...runsOn] : runsOn,
  defaults,
  ...(env === undefined ? {} : { env }),
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
  ...pinnedAction({ name: 'uploadArtifact' }),
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
  env: githubTokenEnv(),
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

    return withCiSourceRoot(withGcRaceRetry({ command, label: name }))
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
  env: githubTokenEnv(),
  run: withCiSourceRoot(
    [
      `bash ${shellSingleQuote(evictPnpmDepsCachedOutputsScript)} --cold-build ${shellSingleQuote(flakeRef)}`,
      `nix build --no-link ${shellSingleQuote(flakeRef)}${extraArgs.length === 0 ? '' : ` ${extraArgs.map(shellSingleQuote).join(' ')}`} --option substituters "https://cache.nixos.org"`,
    ].join('\n'),
  ),
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
export const validateNixStoreStepFor = (lockFile = 'devenv.lock') =>
  ({
    name: pipelineDevenvStepName,
    env: githubTokenEnv(),
    // Routed through the shared retry wrapper: resolving devenv is the first step that
    // evaluates flake inputs, so it is where a transient store/input-cache failure lands
    // (`path '/nix/store/...' is not valid`, a truncated input tarball, an incompletely
    // cached flake input). Its own in-script repair covers only the devenv store path, so
    // without the wrapper any other transient signature fails the job outright.
    run: withGcRaceRetry({
      command: withCiSourceRoot(
        `${shellSingleQuote(`${preparedCiRuntimeScriptsDir}/resolve-devenv.sh`)} ${shellSingleQuote(lockFile)}`,
      ),
      label: `resolve devenv (${lockFile})`,
    }),
    shell: 'bash',
  }) as const

export const validateNixStoreStep = validateNixStoreStepFor()

/**
 * Upload diagnostics captured by `validateNixStoreStep` as a CI artifact.
 * Add this step after validation/task steps so failure-path data is retained.
 */
export const nixDiagnosticsArtifactStep = (opts?: { if?: string; retentionDays?: number }) => ({
  name: 'Upload Nix diagnostics artifact',
  if: opts?.if ?? "failure() && env.NIX_STORE_DIAGNOSTICS_DIR != ''",
  ...pinnedAction({ name: 'uploadArtifact' }),
  with: {
    name: 'nix-store-diagnostics-${{ github.job }}-${{ runner.os }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}',
    path: '${{ env.NIX_STORE_DIAGNOSTICS_DIR }}',
    'if-no-files-found': 'ignore',
    'retention-days': opts?.retentionDays ?? 14,
  },
})
