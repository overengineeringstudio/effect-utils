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
 * them via `pnpmStoreSetupStep` yet. This keeps `runDevenvTasksBefore` safe for
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
 * Includes devenv.cachix.org as extra substituter and github.com access-tokens
 * by default. On self-hosted where Nix is pre-installed, this action is a no-op
 * and extra-conf is silently skipped — the runner's nix wrapper handles
 * access-tokens there by reading GITHUB_TOKEN from the environment.
 */
export const installNixStep = (opts?: {
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
      /** Trust flake-level nixConfig (e.g. devenv's extra-substituters for devenv.cachix.org) */
      'accept-flake-config = true',
      'extra-substituters = https://devenv.cachix.org',
      'extra-trusted-public-keys = devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=',
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
 * Export the canonical CI pnpm paths once so every later shell step shares the
 * same writable store and the same workspace-relative GVS projection.
 */
export const pnpmStoreSetupStep = {
  name: 'Isolate pnpm state',
  shell: 'bash',
  run: [
    `echo "PNPM_STORE_DIR=${jobLocalPnpmStore}" >> "$GITHUB_ENV"`,
    `echo "PNPM_HOME=${jobLocalPnpmHome}" >> "$GITHUB_ENV"`,
  ].join('\n'),
} as const

const pnpmStoreCachePrimaryKey = (keyPrefix: string) =>
  `${keyPrefix}-${'${{ runner.os }}'}-${'${{ runner.arch }}'}-${"${{ hashFiles('**/pnpm-lock.yaml') }}"}`

const pnpmStoreCacheRestorePrefix = (keyPrefix: string) =>
  `${keyPrefix}-${'${{ runner.os }}'}-${'${{ runner.arch }}'}-`

/**
 * Restore the job-local pnpm home snapshot before any install work runs.
 *
 * This is intentionally separate from the save step so a job can still publish
 * a freshly populated store even if the main task fails later. The trade-off is
 * slightly more workflow boilerplate in consumers, but it avoids cold-starting
 * every failing PR until one fully green run happens to save the cache.
 */
export const restorePnpmStoreStep = (opts?: {
  keyPrefix?: string
  stepId?: string
  path?: string
}) => {
  const keyPrefix = opts?.keyPrefix ?? 'pnpm-home'
  const path = opts?.path ?? jobLocalPnpmHome

  return {
    id: opts?.stepId ?? 'restore-pnpm-store',
    name: 'Restore pnpm home',
    uses: 'actions/cache/restore@v4' as const,
    with: {
      path,
      // The fetched store contents are platform-specific, so the cache must
      // isolate both OS and CPU architecture to avoid cross-platform corruption.
      key: pnpmStoreCachePrimaryKey(keyPrefix),
      'restore-keys': pnpmStoreCacheRestorePrefix(keyPrefix),
    },
  }
}

/**
 * Save the job-local pnpm home after the main task graph runs.
 *
 * We only upload when the restore step missed the exact key. A restore-key hit
 * still saves the new primary key so lockfile changes warm later runs, while an
 * exact hit skips the redundant upload.
 */
export const savePnpmStoreStep = (opts?: {
  keyPrefix?: string
  restoreStepId?: string
  path?: string
}) => {
  const keyPrefix = opts?.keyPrefix ?? 'pnpm-home'
  const restoreStepId = opts?.restoreStepId ?? 'restore-pnpm-store'
  const path = opts?.path ?? jobLocalPnpmHome

  return {
    name: 'Save pnpm home',
    if: `\${{ always() && !cancelled() && steps.${restoreStepId}.outputs.cache-hit != 'true' }}`,
    uses: 'actions/cache/save@v4' as const,
    with: {
      path,
      // Reuse the same primary key expression as restore. GitHub Actions does
      // not allow nesting `${{ ... }}` inside a fallback string of another
      // expression, so deriving the key once in TypeScript keeps the emitted
      // workflow expression valid.
      key: pnpmStoreCachePrimaryKey(keyPrefix),
    },
  }
}

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

const deployTargetEnvSuffix = (name: string) =>
  name
    .toUpperCase()
    .replaceAll('-', '_')
    .replaceAll(/[^A-Z0-9_]/g, '')

const deployPreviewManagedMarker = '<!-- deploy-preview-comment:managed -->'
const deployPreviewStatePrefix = '<!-- deploy-preview-comment:state\n'
const deployPreviewStateSuffix = '\n-->'

const vercelDeployCommentStep = (opts: {
  commentTitle: string
  noRowsMessage: string
  projects: readonly Pick<VercelProject, 'name' | 'label'>[]
}) => {
  const projects = opts.projects.map((project) => ({
    name: project.name,
    displayName: project.label ?? project.name,
    envSuffix: deployTargetEnvSuffix(project.name),
  }))

  const renderCommentScript = [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    '',
    `const commentTitle = ${JSON.stringify(opts.commentTitle)}`,
    `const noRowsMessage = ${JSON.stringify(opts.noRowsMessage)}`,
    `const projects = ${JSON.stringify(projects)}`,
    `const managedMarker = ${JSON.stringify(deployPreviewManagedMarker)}`,
    `const statePrefix = ${JSON.stringify(deployPreviewStatePrefix)}`,
    `const stateSuffix = ${JSON.stringify(deployPreviewStateSuffix)}`,
    `const stateTag = 'deploy-preview-comment-state'`,
    `const schemaVersion = 1`,
    `const timeZone = 'Europe/Berlin'`,
    `const maxCommits = 50`,
    '',
    'const [commentsPath, commentBodyPath, summaryPath, commentIdPath] = process.argv.slice(2)',
    '',
    'const fail = (message) => {',
    '  throw new Error(message)',
    '}',
    '',
    'const expectObject = (value, path) => {',
    "  if (typeof value !== 'object' || value === null || Array.isArray(value)) {",
    '    fail(`${path} must be an object`)',
    '  }',
    '  return value',
    '}',
    '',
    'const expectArray = (value, path) => {',
    '  if (!Array.isArray(value)) {',
    '    fail(`${path} must be an array`)',
    '  }',
    '  return value',
    '}',
    '',
    'const expectString = (value, path) => {',
    "  if (typeof value !== 'string' || value.length === 0) {",
    '    fail(`${path} must be a non-empty string`)',
    '  }',
    '  return value',
    '}',
    '',
    'const expectExactKeys = (record, keys, path) => {',
    '  const actualKeys = Object.keys(record).sort()',
    '  const expectedKeys = [...keys].sort()',
    '  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {',
    '    fail(`${path} keys must be exactly: ${expectedKeys.join(", ")}`)',
    '  }',
    '}',
    '',
    'const expectUrl = (value, path) => {',
    '  const string = expectString(value, path)',
    "  if (!string.startsWith('https://')) {",
    '    fail(`${path} must start with https://`)',
    '  }',
    '  return string',
    '}',
    '',
    'const expectIsoUtc = (value, path) => {',
    '  const string = expectString(value, path)',
    '  if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$/.test(string) || Number.isNaN(Date.parse(string))) {',
    '    fail(`${path} must be a valid UTC ISO timestamp`)',
    '  }',
    '  return string',
    '}',
    '',
    'const validateTarget = (value, path) => {',
    '  const record = expectObject(value, path)',
    "  expectExactKeys(record, ['target', 'displayName', 'finalUrl', 'rawDeployUrl', 'deployedAtUtc'], path)",
    '  return {',
    '    target: expectString(record.target, `${path}.target`),',
    '    displayName: expectString(record.displayName, `${path}.displayName`),',
    '    finalUrl: expectUrl(record.finalUrl, `${path}.finalUrl`),',
    '    rawDeployUrl: expectUrl(record.rawDeployUrl, `${path}.rawDeployUrl`),',
    '    deployedAtUtc: expectIsoUtc(record.deployedAtUtc, `${path}.deployedAtUtc`),',
    '  }',
    '}',
    '',
    'const validateCommit = (value, path) => {',
    '  const record = expectObject(value, path)',
    "  expectExactKeys(record, ['commitSha', 'modeLabel', 'targets'], path)",
    '  const targets = expectArray(record.targets, `${path}.targets`).map((target, index) =>',
    '    validateTarget(target, `${path}.targets[${index}]`),',
    '  )',
    '  return {',
    '    commitSha: expectString(record.commitSha, `${path}.commitSha`),',
    '    modeLabel: expectString(record.modeLabel, `${path}.modeLabel`),',
    '    targets,',
    '  }',
    '}',
    '',
    'const validateState = (value) => {',
    "  const record = expectObject(value, 'state')",
    "  expectExactKeys(record, ['_tag', 'schemaVersion', 'timeZone', 'targetOrder', 'commits'], 'state')",
    '  if (record._tag !== stateTag) fail(`state._tag must be ${stateTag}`)',
    '  if (record.schemaVersion !== schemaVersion) fail(`state.schemaVersion must be ${schemaVersion}`)',
    '  if (record.timeZone !== timeZone) fail(`state.timeZone must be ${timeZone}`)',
    '  const targetOrder = expectArray(record.targetOrder, "state.targetOrder").map((target, index) =>',
    '    expectString(target, `state.targetOrder[${index}]`),',
    '  )',
    '  const commits = expectArray(record.commits, "state.commits").map((commit, index) =>',
    '    validateCommit(commit, `state.commits[${index}]`),',
    '  )',
    '  return { _tag: stateTag, schemaVersion, timeZone, targetOrder, commits }',
    '}',
    '',
    'const formatBerlin = (isoUtc) => {',
    "  const formatter = new Intl.DateTimeFormat('en-GB', {",
    '    timeZone,',
    "    year: 'numeric',",
    "    month: '2-digit',",
    "    day: '2-digit',",
    "    hour: '2-digit',",
    "    minute: '2-digit',",
    '    hour12: false,',
    "    timeZoneName: 'short',",
    '  })',
    '  const parts = Object.fromEntries(',
    '    formatter.formatToParts(new Date(isoUtc)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),',
    '  )',
    '  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`',
    '}',
    '',
    'const extractState = (body) => {',
    '  const start = body.indexOf(statePrefix)',
    '  if (start === -1) return undefined',
    '  const end = body.indexOf(stateSuffix, start + statePrefix.length)',
    '  if (end === -1) fail("existing managed comment is missing the state suffix marker")',
    '  const raw = body.slice(start + statePrefix.length, end)',
    '  return validateState(JSON.parse(raw))',
    '}',
    '',
    'const renderHistoryUrl = (target) =>',
    '  target.finalUrl === target.rawDeployUrl',
    '    ? target.rawDeployUrl',
    '    : `${target.rawDeployUrl}<br><sub>Alias: ${target.finalUrl}</sub>`',
    '',
    'const currentTargets = projects.flatMap((project) => {',
    '  const finalUrl = process.env[`DEPLOY_FINAL_URL_${project.envSuffix}`] ?? ""',
    '  const rawDeployUrl = process.env[`DEPLOY_RAW_DEPLOY_URL_${project.envSuffix}`] ?? finalUrl',
    '  const deployedAtUtc = process.env[`DEPLOYED_AT_UTC_${project.envSuffix}`] ?? ""',
    '  if (finalUrl.length === 0 || deployedAtUtc.length === 0) return []',
    '  return [{',
    '    target: project.name,',
    '    displayName: project.displayName,',
    '    finalUrl,',
    '    rawDeployUrl: rawDeployUrl.length === 0 ? finalUrl : rawDeployUrl,',
    '    deployedAtUtc,',
    '  }]',
    '})',
    '',
    'const dedupedCurrentTargets = [...new Map(currentTargets.map((target) => [target.target, target])).values()]',
    'dedupedCurrentTargets.forEach((target, index) => validateTarget(target, `currentTargets[${index}]`))',
    '',
    'if (dedupedCurrentTargets.length === 0) {',
    '  writeFileSync(summaryPath, `## ${commentTitle}\\n\\n${noRowsMessage}\\n`)',
    "  writeFileSync(commentBodyPath, '')",
    "  writeFileSync(commentIdPath, '')",
    '  process.exit(0)',
    '}',
    '',
    "const comments = JSON.parse(readFileSync(commentsPath, 'utf8'))",
    'if (!Array.isArray(comments)) fail("comments response must be an array")',
    '',
    'const existingComment = comments',
    '  .filter((comment) => typeof comment?.body === "string" && comment.body.includes(managedMarker))',
    '  .at(-1)',
    '',
    'const existingState = existingComment ? extractState(existingComment.body) : undefined',
    'const priorState = existingState ?? { _tag: stateTag, schemaVersion, timeZone, targetOrder: [], commits: [] }',
    '',
    'const commitSha = expectString(process.env.DEPLOY_COMMIT_SHA, "DEPLOY_COMMIT_SHA")',
    'const modeLabel = expectString(process.env.DEPLOY_LABEL, "DEPLOY_LABEL")',
    '',
    'const nextTargetOrder = [...new Set([...dedupedCurrentTargets.map((target) => target.target), ...priorState.targetOrder])]',
    'const nextState = {',
    '  _tag: stateTag,',
    '  schemaVersion,',
    '  timeZone,',
    '  targetOrder: nextTargetOrder,',
    '  commits: [',
    '    { commitSha, modeLabel, targets: dedupedCurrentTargets },',
    '    ...priorState.commits.filter((commit) => commit.commitSha !== commitSha),',
    '  ].slice(0, maxCommits),',
    '}',
    '',
    'const latestByTarget = new Map()',
    'for (const commit of nextState.commits) {',
    '  for (const target of commit.targets) {',
    '    if (!latestByTarget.has(target.target)) {',
    '      latestByTarget.set(target.target, target)',
    '    }',
    '  }',
    '}',
    '',
    'const renderCommitTimestamp = (commit) => {',
    '  const latestIso = commit.targets.reduce((currentLatest, target) =>',
    '    Date.parse(target.deployedAtUtc) > Date.parse(currentLatest) ? target.deployedAtUtc : currentLatest,',
    '  commit.targets[0]?.deployedAtUtc ?? new Date(0).toISOString())',
    '  return formatBerlin(latestIso)',
    '}',
    '',
    'const visibleLines = [',
    '  `## ${commentTitle}`,',
    "  '',",
    '  `| Target | Latest URL | Last Deploy (Europe/Berlin) |`,',
    '  `| --- | --- | --- |`,',
    '  ...nextState.targetOrder.flatMap((targetName) => {',
    '    const target = latestByTarget.get(targetName)',
    '    return target === undefined',
    '      ? []',
    '      : [`| ${target.displayName} | ${target.finalUrl} | ${formatBerlin(target.deployedAtUtc)} |`]',
    '  }),',
    ']',
    '',
    'if (nextState.commits.length > 0) {',
    "  visibleLines.push('', '<details>', '<summary>Per-Commit Deploy History</summary>', '')",
    '  for (const commit of nextState.commits) {',
    '    visibleLines.push(`### Commit \\`${commit.commitSha.slice(0, 7)}\\` · ${renderCommitTimestamp(commit)}`)',
    "    visibleLines.push('')",
    '    visibleLines.push(`| Target | URL |`) ',
    '    visibleLines.push(`| --- | --- |`)',
    '    for (const targetName of nextState.targetOrder) {',
    '      const target = commit.targets.find((entry) => entry.target === targetName)',
    '      if (target !== undefined) {',
    '        visibleLines.push(`| ${target.displayName} | ${renderHistoryUrl(target)} |`)',
    '      }',
    '    }',
    "    visibleLines.push('')",
    '  }',
    "  visibleLines.push('</details>')",
    '}',
    '',
    'const visibleBody = `${visibleLines.join("\\n")}\\n`',
    'const hiddenState = `${managedMarker}\\n${statePrefix}${JSON.stringify(nextState, undefined, 2)}${stateSuffix}`',
    'const fullBody = `${visibleBody}\\n${hiddenState}\\n`',
    '',
    'writeFileSync(summaryPath, visibleBody)',
    'writeFileSync(commentBodyPath, fullBody)',
    "writeFileSync(commentIdPath, existingComment ? String(existingComment.id) : '')",
    '',
  ].join('\n')

  return {
    name: 'Post deploy URLs',
    if: 'always() && !cancelled()',
    shell: 'bash' as const,
    env: {
      GH_TOKEN: '${{ github.token }}',
      GH_REPO: '${{ github.repository }}',
      ...Object.fromEntries(
        projects.flatMap((project) => [
          [
            `DEPLOY_FINAL_URL_${project.envSuffix}`,
            `\${{ needs.deploy-${project.name}.outputs.final_url }}`,
          ],
          [
            `DEPLOY_RAW_DEPLOY_URL_${project.envSuffix}`,
            `\${{ needs.deploy-${project.name}.outputs.raw_deploy_url }}`,
          ],
          [
            `DEPLOYED_AT_UTC_${project.envSuffix}`,
            `\${{ needs.deploy-${project.name}.outputs.deployed_at_utc }}`,
          ],
        ]),
      ),
    },
    run: [
      deployModeScript,
      'if [ "${{ github.event_name }}" = "pull_request" ]; then',
      '  commit_sha="${{ github.event.pull_request.head.sha }}"',
      'else',
      '  commit_sha="${{ github.sha }}"',
      'fi',
      'export DEPLOY_LABEL="$label"',
      'export DEPLOY_COMMIT_SHA="$commit_sha"',
      'comments_json="/tmp/deploy-comments.json"',
      'if [ "${{ github.event_name }}" = "pull_request" ]; then',
      '  export NIX_CONFIG="${NIX_CONFIG:+$NIX_CONFIG$\'\\n\'}access-tokens = github.com=${GH_TOKEN}"',
      '  nix run nixpkgs#gh -- api "repos/$GH_REPO/issues/${{ github.event.pull_request.number }}/comments" --paginate > "$comments_json"',
      'else',
      '  printf \'[]\' > "$comments_json"',
      'fi',
      "cat > /tmp/render-deploy-comment.mjs <<'EOF'",
      renderCommentScript,
      'EOF',
      'nix run nixpkgs#nodejs_24 -- /tmp/render-deploy-comment.mjs "$comments_json" /tmp/comment.md /tmp/summary.md /tmp/comment-id.txt',
      'cat /tmp/summary.md >> "$GITHUB_STEP_SUMMARY"',
      'if [ "${{ github.event_name }}" = "pull_request" ]; then',
      '  comment_id="$(cat /tmp/comment-id.txt)"',
      '  if [ -n "$comment_id" ]; then',
      '    nix run nixpkgs#gh -- api "repos/$GH_REPO/issues/comments/$comment_id" --method PATCH --field body="$(cat /tmp/comment.md)" > /dev/null',
      '  else',
      '    nix run nixpkgs#gh -- api "repos/$GH_REPO/issues/${{ github.event.pull_request.number }}/comments" --method POST --field body="$(cat /tmp/comment.md)" > /dev/null',
      '  fi',
      'fi',
    ].join('\n'),
  }
}

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
export const vercelDeployStep = (project: { name: string; urlEnvKey?: string }) => {
  const urlEnvKey =
    project.urlEnvKey ??
    `VERCEL_DEPLOY_URL_${project.name
      .toUpperCase()
      .replaceAll('-', '_')
      .replaceAll(/[^A-Z0-9_]/g, '')}`

  return {
    id: 'deploy',
    name: `Deploy ${project.name} to Vercel`,
    shell: 'bash' as const,
    run: [
      'if [ -z "${VERCEL_TOKEN:-}" ]; then',
      '  echo "::error::VERCEL_TOKEN is not set"',
      '  exit 1',
      'fi',
      'tmp_log="$(mktemp)"',
      'if [ "${{ github.event_name }}" = "pull_request" ]; then',
      `  ${runDevenvTasksBefore(`vercel:deploy:${project.name}`, '--show-output', '--input', 'type=pr', '--input', 'pr=${{ github.event.pull_request.number }}')} 2>&1 | tee "$tmp_log"`,
      'else',
      `  ${runDevenvTasksBefore(`vercel:deploy:${project.name}`, '--show-output', '--input', 'type=prod')} 2>&1 | tee "$tmp_log"`,
      'fi',
      'deploy_exit=${PIPESTATUS[0]}',
      'if [ "$deploy_exit" -ne 0 ]; then exit "$deploy_exit"; fi',
      `final_url=$(grep -Eo 'Vercel deploy URL: https://[^[:space:]"]+' "$tmp_log" | sed 's/^Vercel deploy URL: //' | tail -n 1 || true)`,
      `raw_deploy_url=$(grep -Eo 'Vercel raw deploy URL: https://[^[:space:]"]+' "$tmp_log" | sed 's/^Vercel raw deploy URL: //' | tail -n 1 || true)`,
      'if [ -z "$final_url" ]; then',
      `  final_url=$(grep -oE 'https://[^[:space:]"]+' "$tmp_log" | grep -E 'vercel\\.(app|com)' | tail -n 1 || true)`,
      'fi',
      'if [ -z "$raw_deploy_url" ]; then',
      '  raw_deploy_url="$final_url"',
      'fi',
      'deployed_at_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
      'if [ -n "$final_url" ]; then',
      `  echo "${urlEnvKey}=$final_url" >> "$GITHUB_ENV"`,
      '  echo "final_url=$final_url" >> "$GITHUB_OUTPUT"',
      '  echo "deploy_url=$final_url" >> "$GITHUB_OUTPUT"',
      'fi',
      'if [ -n "$raw_deploy_url" ]; then',
      '  echo "raw_deploy_url=$raw_deploy_url" >> "$GITHUB_OUTPUT"',
      'fi',
      'echo "deployed_at_utc=$deployed_at_utc" >> "$GITHUB_OUTPUT"',
      'rm -f "$tmp_log"',
    ].join('\n'),
  }
}

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

type VercelProject = {
  name: string
  urlEnvKey?: string
  projectIdEnv: string
  label?: string
  stepsBeforeDeploy?: readonly Record<string, unknown>[]
}

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
}): Record<string, Record<string, unknown>> => {
  const deployCondition =
    opts.deployCondition ??
    [
      'always()',
      `(github.event_name == 'schedule' || (${(opts.needs ?? []).map((j) => `needs.${j}.result == 'success'`).join(' && ')}))`,
    ].join(' && ')

  const deployJobNames = opts.projects.map((p) => `deploy-${p.name}`)

  const deployJobs = Object.fromEntries(
    opts.projects.map((project) => [
      `deploy-${project.name}`,
      {
        ...(opts.needs !== undefined && opts.needs.length > 0 ? { needs: [...opts.needs] } : {}),
        if: deployCondition,
        'runs-on': [...opts.runner],
        defaults: bashShellDefaults,
        outputs: {
          final_url: '${{ steps.deploy.outputs.final_url }}',
          raw_deploy_url: '${{ steps.deploy.outputs.raw_deploy_url }}',
          deployed_at_utc: '${{ steps.deploy.outputs.deployed_at_utc }}',
          deploy_url: '${{ steps.deploy.outputs.deploy_url }}',
        },
        env: {
          ...opts.env,
          [project.projectIdEnv]:
            opts.env[project.projectIdEnv] ?? `\${{ secrets.${project.projectIdEnv} }}`,
        },
        steps: [
          ...opts.baseSteps,
          ...(project.stepsBeforeDeploy ?? []),
          vercelDeployStep(project),
          ...(opts.extraSteps ?? []),
        ],
      },
    ]),
  )

  if (opts.includeComment === false) {
    return deployJobs
  }

  /** Collect URLs from parallel deploy jobs and post one combined comment. */
  const commentJob = {
    needs: deployJobNames,
    if: 'always() && !cancelled()',
    permissions: deployCommentPermissions,
    'runs-on': linuxX64Runner,
    steps: [
      vercelDeployCommentStep({
        commentTitle: opts.commentTitle ?? 'Deploy Preview',
        projects: opts.projects,
        noRowsMessage: opts.noRowsMessage ?? 'No deploy URLs detected.',
      }),
    ],
  }

  return {
    ...deployJobs,
    'post-deploy-comment': commentJob,
  }
}

// =============================================================================
// Netlify Deploy Helpers
// =============================================================================

/**
 * Deploy step for Netlify storybooks via devenv tasks.
 * Runs `netlify:deploy` with prod/PR mode based on the event trigger.
 * Gracefully skips if NETLIFY_AUTH_TOKEN is not available.
 */
export const netlifyDeployStep = () => ({
  name: 'Deploy storybooks to Netlify',
  shell: 'bash' as const,
  run: [
    'if [ -z "${NETLIFY_AUTH_TOKEN:-}" ]; then',
    '  echo "::notice::Skipping Netlify deploy (NETLIFY_AUTH_TOKEN not available)"',
    '  exit 0',
    'fi',
    'if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then',
    `  ${runDevenvTasksBefore('netlify:deploy', '--input', 'type=prod')}`,
    'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
    `  ${runDevenvTasksBefore('netlify:deploy', '--input', 'type=pr', '--input', 'pr=${{ github.event.pull_request.number }}')}`,
    'fi',
  ].join('\n'),
})

/**
 * Combined deploy comment step for Netlify storybook previews.
 * Discovers deployed storybooks by scanning for `storybook-static` build output
 * under `packages/@overeng/` and generates PR comments + job summaries with URLs.
 *
 * @param site - Netlify site name (e.g. 'overeng-utils')
 */
export const netlifyStorybookCommentStep = (site: string) =>
  deployCommentStep({
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
      'for dir in packages/@overeng/*/storybook-static; do',
      '  [ -d "$dir" ] || continue',
      '  name="${dir#packages/@overeng/}"',
      '  name="${name%/storybook-static}"',
      '  url="https://${name}${suffix}--${site}.netlify.app"',
      '  rows="${rows}| ${name} | ${url} |\\n"',
      'done',
    ].join('\n'),
  })
