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
 *   preparePinnedDevenvStep, validateNixStoreStep, runDevenvTasksBefore, standardCIEnv,
 * } from '../../repos/effect-utils/genie/ci-workflow.ts'
 *
 * const baseSteps = [
 *   checkoutStep(),
 *   installNixStep(),
 *   cachixStep({ name: 'my-cache' }),
 *   preparePinnedDevenvStep,
 *   validateNixStoreStep,
 * ]
 * ```
 */

import { RUNNER_PROFILES, type RunnerProfile } from './ci.ts'

export { RUNNER_PROFILES, type RunnerProfile }

// =============================================================================
// Shared Config
// =============================================================================

/** Self-hosted NixOS runner labels */
export const selfHostedRunner = ['self-hosted', 'nix'] as const

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

const devenvBinRef = '"${DEVENV_BIN:?DEVENV_BIN not set}"'

const resolveDevenvRevScript = `DEVENV_REV=$(jq -r .nodes.devenv.locked.rev devenv.lock)
if [ -z "$DEVENV_REV" ] || [ "$DEVENV_REV" = "null" ]; then
  echo '::error::devenv.lock missing .nodes.devenv.locked.rev'
  exit 1
fi`

const resolveDevenvFnScript = `resolve_devenv() {
  nix build --no-link --print-out-paths "github:cachix/devenv/$DEVENV_REV#devenv"
}`

/** Build a command that runs one or more devenv tasks with `--mode before`. */
export const runDevenvTasksBefore = (...args: [string, ...string[]]) =>
  `if [ -n "${'${NIX_CONFIG:-}'}" ]; then NIX_CONFIG_WITH_UNRESTRICTED_EVAL="$NIX_CONFIG"$'\\n''restrict-eval = false'; else NIX_CONFIG_WITH_UNRESTRICTED_EVAL='restrict-eval = false'; fi; NIX_CONFIG="$NIX_CONFIG_WITH_UNRESTRICTED_EVAL" ${devenvBinRef} tasks run ${args.join(' ')} --mode before`

/**
 * Namespace runner with run ID-based affinity to prevent queue jumping.
 * Adds a run ID label so runners spawned for one workflow run
 * don't steal jobs from other runs.
 */
export const namespaceRunner = (profile: RunnerProfile | (string & {}), runId: string) =>
  [profile, `namespace-features:github.run-id=${runId}`] as const

// =============================================================================
// Step Atoms
// =============================================================================

/** Checkout repository via actions/checkout@v4 */
export const checkoutStep = (opts?: { repository?: string; ref?: string; path?: string }) => ({
  uses: 'actions/checkout@v4' as const,
  ...(opts && Object.keys(opts).length > 0 ? { with: opts } : {}),
})

/**
 * Install Nix via DeterminateSystems/determinate-nix-action@v3.
 * Includes devenv.cachix.org as extra substituter and github.com access-tokens
 * by default. On self-hosted where Nix is pre-installed, this action is a no-op
 * and extra-conf is silently skipped — the runner's nix wrapper handles
 * access-tokens there by reading GITHUB_TOKEN from the environment.
 */
export const installNixStep = (opts?: { extraConf?: string }) => ({
  name: 'Install Nix',
  uses: 'DeterminateSystems/determinate-nix-action@v3' as const,
  with: {
    'extra-conf': [
      'extra-substituters = https://devenv.cachix.org',
      'extra-trusted-public-keys = devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=',
      'access-tokens = github.com=${{ github.token }}',
      ...(opts?.extraConf ? [opts.extraConf] : []),
    ].join('\n'),
  },
})

/** Enable a Cachix binary cache */
export const cachixStep = (opts: { name: string; authToken?: string }) => ({
  name: 'Enable Cachix cache',
  uses: 'cachix/cachix-action@v16' as const,
  with: {
    name: opts.name,
    ...(opts.authToken ? { authToken: opts.authToken } : {}),
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

/** Install megarepo CLI from effect-utils */
export const installMegarepoStep = {
  name: 'Install megarepo CLI',
  run: 'nix profile install github:overengineeringstudio/effect-utils#megarepo',
  shell: 'bash',
} as const

/** Sync megarepo dependencies */
export const syncMegarepoStep = (opts?: { frozen?: boolean; skip?: string[] }) => {
  const args = ['mr', 'sync']
  if (opts?.frozen !== false) args.push('--frozen')
  if (opts?.skip) for (const s of opts.skip) args.push('--skip', s)
  return {
    name: 'Sync megarepo dependencies',
    run: args.join(' '),
    shell: 'bash',
  }
}

/**
 * Sync megarepo dependencies using the locked effect-utils commit from megarepo.lock.
 * Resolves the commit inline and uses `nix run` to avoid `nix profile install`
 * (which can conflict on self-hosted).
 */
export const syncMegarepoFromLockStep = (opts?: { skip?: string[] }) => {
  const skipArgs = opts?.skip?.flatMap((s) => ['--skip', s]).join(' ') ?? ''
  return {
    name: 'Sync megarepo dependencies',
    run: `EU_REV=$(jq -r '.members["effect-utils"].commit' megarepo.lock)
if [ -z "$EU_REV" ] || [ "$EU_REV" = "null" ]; then
  echo '::error::megarepo.lock missing members["effect-utils"].commit'
  exit 1
fi
nix run "github:overengineeringstudio/effect-utils/$EU_REV#megarepo" -- sync --frozen${skipArgs ? ` ${skipArgs}` : ''}`,
    shell: 'bash',
  }
}

/**
 * Validate Nix store on namespace runners.
 * Runs `${devenvBinRef} info` to evaluate the devenv expression without entering shell hooks.
 * On failure, repairs the store AND clears the Nix eval cache (which may
 * reference GC'd paths), then retries.
 *
 * Temporary diagnostics instrumentation for #272:
 * - Captures full verify/repair/eval logs and runner fingerprint into a temp directory.
 * - Exports `NIX_STORE_DIAGNOSTICS_DIR` for failure-only summary/artifact steps.
 *
 * Cleanup plan:
 * - Once #201/#272 root cause is confirmed and flake rate is stable near zero,
 *   remove the diagnostics capture + upload wiring and keep only the minimal
 *   validation/repair flow for a simpler CI setup again.
 *
 * @see https://github.com/namespacelabs/nscloud-setup/issues/8
 * @see https://github.com/overengineeringstudio/effect-utils/issues/201
 * @see https://github.com/overengineeringstudio/effect-utils/issues/272
 */
export const validateNixStoreStep = {
  name: 'Validate Nix store',
  run: `if [ -z "${'${DEVENV_REV:-}'}" ]; then
  ${resolveDevenvRevScript}
fi

${resolveDevenvFnScript}

# Always append restrict-eval=false so caller-provided NIX_CONFIG keeps its settings.
if [ -n "${'${NIX_CONFIG:-}'}" ]; then
  NIX_CONFIG_WITH_UNRESTRICTED_EVAL="$NIX_CONFIG"$'\\n''restrict-eval = false'
else
  NIX_CONFIG_WITH_UNRESTRICTED_EVAL='restrict-eval = false'
fi

# Temporary: capture complete diagnostics for #272 root-cause analysis.
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
  echo "github_run_attempt=${'${GITHUB_RUN_ATTEMPT:-unknown}'}"
  echo "nix_user_conf_files=${'${NIX_USER_CONF_FILES:-}'}"
  echo ""
  echo "== uname -a =="
  uname -a || true
  if command -v sw_vers > /dev/null 2>&1; then
    echo ""
    echo "== sw_vers =="
    sw_vers || true
  fi
  echo ""
  echo "== nix --version =="
  nix --version || true
} > "$DIAG_ROOT/environment.txt" 2>&1

pre_resolve_log="$DIAG_ROOT/resolve-devenv-pre-repair.log"
pre_info_log="$DIAG_ROOT/devenv-info-pre-repair.log"
verify_log="$DIAG_ROOT/nix-store-verify-pre-repair.log"
repair_log="$DIAG_ROOT/nix-store-verify-repair.log"
post_resolve_log="$DIAG_ROOT/resolve-devenv-post-repair.log"
post_info_log="$DIAG_ROOT/devenv-info-post-repair.log"

if DEVENV_OUT=$(resolve_devenv 2>"$pre_resolve_log") && DEVENV_BIN="$DEVENV_OUT/bin/devenv" && NIX_CONFIG="$NIX_CONFIG_WITH_UNRESTRICTED_EVAL" "$DEVENV_BIN" info > "$pre_info_log" 2>&1; then
  echo "Nix store OK"
else
  echo "::warning::Nix store validation failed, collecting diagnostics and repairing..."
  if ! nix-store --verify --check-contents > "$verify_log" 2>&1; then
    echo "::warning::nix-store --verify --check-contents reported issues (see diagnostics artifact)"
  fi
  if ! nix-store --verify --check-contents --repair > "$repair_log" 2>&1; then
    echo "::warning::nix-store --verify --check-contents --repair reported issues (see diagnostics artifact)"
  fi
  rm -rf ~/.cache/nix/eval-cache-*
  DEVENV_OUT=$(resolve_devenv 2>"$post_resolve_log")
  DEVENV_BIN="$DEVENV_OUT/bin/devenv"
  NIX_CONFIG="$NIX_CONFIG_WITH_UNRESTRICTED_EVAL" "$DEVENV_BIN" info > "$post_info_log" 2>&1
fi

echo "DEVENV_BIN=$DEVENV_BIN" >> "$GITHUB_ENV"
"$DEVENV_BIN" version | tee "$DIAG_ROOT/devenv-version.txt"`,
  shell: 'bash',
} as const
