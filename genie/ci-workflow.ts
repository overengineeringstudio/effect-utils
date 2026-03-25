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

import {
  githubWorkflow,
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
  PNPM_HOME:
    '${{ runner.temp }}/pnpm-home/${{ github.run_id }}/${{ github.run_attempt }}/${{ github.job }}',
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
  (({ concurrency, ...rest }) =>
    githubWorkflow({
      concurrency: concurrency ?? ciWorkflowConcurrency,
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

const runDevenvTasksBeforeWithOptions = (opts: NixConfigOptions, ...args: [string, ...string[]]) =>
  withAppendedNixConfig({
    command: `DT_PASSTHROUGH=1 ${devenvBinRef} tasks run ${args.join(' ')} --mode before`,
    opts,
  })

/**
 * Retry wrapper for the Nix GC race condition where `derivationStrict` fails with
 * `path '/nix/store/...' is not valid`. On each retry, fetches the missing path
 * and clears the eval cache.
 *
 * TODO: Remove once NixOS/nix#15469 and DeterminateSystems/nix-src#395 are released
 * @see https://github.com/NixOS/nix/pull/15469
 * @see https://github.com/DeterminateSystems/nix-src/issues/395
 */
const withGcRaceRetry = (command: string) => {
  const quoted = shellSingleQuote(command)
  return `__nix_gc_retry() {
  local __max=${'${NIX_GC_RACE_MAX_RETRIES:-10}'} __n=1 __log __rc __path
  while [ "$__n" -le "$__max" ]; do
    __log=$(mktemp)
    set +e; eval "$1" 2> >(tee "$__log" >&2); __rc=$?; set -e
    [ $__rc -eq 0 ] && { rm -f "$__log"; return 0; }
    __path=$(grep -oP "path '\\K/nix/store/[^']*" "$__log" 2>/dev/null | head -1 || true)
    rm -f "$__log"
    [ -z "$__path" ] && return $__rc
    echo "::warning::Nix GC race detected (attempt $__n/$__max): $__path"
    nix-store --realise "$__path" 2>/dev/null || true
    rm -rf ~/.cache/nix/eval-cache-*
    __n=$((__n + 1))
  done
  echo "::error::Nix GC race retry exhausted ($__max attempts)"
  return 1
}; __nix_gc_retry ${quoted}`
}

/** Build a command that runs one or more devenv tasks with `--mode before`. */
export const runDevenvTasksBefore = (...args: [string, ...string[]]) =>
  withGcRaceRetry(runDevenvTasksBeforeWithOptions({ unrestrictedEval: true }, ...args))

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
  run: [
    `topDrv=$(nix path-info --derivation ${shellSingleQuote(flakeRef)} 2>/dev/null || true)`,
    'if [ -n "$topDrv" ]; then',
    '  while IFS= read -r drv; do',
    '    [ -n "$drv" ] || continue',
    '    while IFS= read -r outPath; do',
    '      [ -n "$outPath" ] || continue',
    '      if [ -e "$outPath" ]; then',
    '        echo "evicting cached: $(basename "$outPath")"',
    '        nix store delete "$outPath" 2>/dev/null || true',
    '      fi',
    '    done < <(nix-store -q --outputs "$drv" 2>/dev/null || true)',
    '  done < <(nix-store -qR "$topDrv" 2>/dev/null | grep "pnpm-deps.*\\.drv$" || true)',
    'fi',
  ].join('\n'),
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

/** Checkout repository via actions/checkout@v4 */
export const checkoutStep = (opts?: { repository?: string; ref?: string; path?: string }) => ({
  uses: 'actions/checkout@v4' as const,
  ...(opts !== undefined && Object.keys(opts).length > 0 ? { with: opts } : {}),
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
      'access-tokens = github.com=${{ github.token }}',
      ...(opts?.extraConf !== undefined ? [opts.extraConf] : []),
    ].join('\n'),
  },
})

/** Enable a Cachix binary cache */
export const cachixStep = (opts: { name: string; authToken?: string }) => ({
  name: 'Enable Cachix cache',
  uses: 'cachix/cachix-action@v16' as const,
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

/** Ephemeral per-job pnpm home path scoped to the CI run/attempt/job */
export const jobLocalPnpmHome = standardCIEnv.PNPM_HOME

/** Ephemeral per-job pnpm store path derived from PNPM_HOME */
export const jobLocalPnpmStore = `${jobLocalPnpmHome}/store`

/** Restore/save the pnpm store via actions/cache without sharing a live store between jobs */
export const cachePnpmStoreStep = (opts?: { keyPrefix?: string }) => {
  const keyPrefix = opts?.keyPrefix ?? 'pnpm-store'

  return {
    name: 'Cache pnpm store',
    uses: 'actions/cache@v4' as const,
    with: {
      path: jobLocalPnpmStore,
      key: `${keyPrefix}-${'${{ runner.os }}'}-${"${{ hashFiles('**/pnpm-lock.yaml') }}"}`,
      'restore-keys': `${keyPrefix}-${'${{ runner.os }}'}-`,
    },
  }
}

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
 * Apply megarepo.lock using the locked effect-utils commit from megarepo.lock.
 * Resolves the commit inline and uses `nix run` to avoid `nix profile install`
 * (which can conflict on self-hosted).
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
}) =>
  ({
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
}) =>
  ({
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
 * Captures deploy URL and exports it to both GITHUB_ENV and GITHUB_OUTPUT
 * (the latter enables cross-job URL collection via `vercelDeployJobs`).
 */
export const vercelDeployStep = (project: { name: string; urlEnvKey: string }) => ({
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
    `url=$(grep -oE 'https://[^[:space:]"]+' "$tmp_log" | grep -E 'vercel\\.(app|com)' | tail -n 1 || true)`,
    'if [ -n "$url" ]; then',
    `  echo "${project.urlEnvKey}=$url" >> "$GITHUB_ENV"`,
    '  echo "deploy_url=$url" >> "$GITHUB_OUTPUT"',
    'fi',
    'rm -f "$tmp_log"',
    'if [ "$deploy_exit" -ne 0 ]; then exit "$deploy_exit"; fi',
  ].join('\n'),
})

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

type VercelProject = { name: string; urlEnvKey: string; projectIdEnv: string }

/**
 * Generate all Vercel deploy jobs + a combined comment collector job.
 *
 * Returns a flat record of GitHub Actions jobs:
 * - `deploy-<name>` — one per project, runs `vercelDeployStep`, exposes URL as job output
 * - `post-deploy-comment` — lightweight job that collects URLs from all deploy jobs
 *   and posts a single combined PR comment via `deployCommentStep`
 *
 * This mirrors the Netlify pattern (single combined comment) while preserving
 * parallel deploys. Both use `deployCommentStep` as the shared rendering layer.
 */
export const vercelDeployJobs = (opts: {
  projects: readonly VercelProject[]
  /** CI job names that deploy jobs depend on */
  needs: readonly string[]
  runner: readonly string[]
  baseSteps: readonly Record<string, unknown>[]
  env: Record<string, string>
  gitAuthor: { name: string; email: string }
  /** Extra steps to add after deploy (before comment was posted per-job, now separate) */
  extraSteps?: readonly Record<string, unknown>[]
  /** Deploy condition override. Default: always after CI passes, or directly on schedule. */
  deployCondition?: string
}): Record<string, Record<string, unknown>> => {
  const deployCondition =
    opts.deployCondition ??
    [
      'always()',
      `(github.event_name == 'schedule' || (${opts.needs.map((j) => `needs.${j}.result == 'success'`).join(' && ')}))`,
    ].join(' && ')

  const deployJobNames = opts.projects.map((p) => `deploy-${p.name}`)

  const deployJobs = Object.fromEntries(
    opts.projects.map((project) => [
      `deploy-${project.name}`,
      {
        needs: [...opts.needs],
        if: deployCondition,
        'runs-on': [...opts.runner],
        defaults: bashShellDefaults,
        outputs: {
          deploy_url: '${{ steps.deploy.outputs.deploy_url }}',
        },
        env: {
          ...opts.env,
          [project.projectIdEnv]:
            opts.env[project.projectIdEnv] ?? `\${{ secrets.${project.projectIdEnv} }}`,
        },
        steps: [
          ...opts.baseSteps,
          vercelGitAuthorStep(opts.gitAuthor),
          vercelDeployStep(project),
          ...(opts.extraSteps ?? []),
        ],
      },
    ]),
  )

  /** Collect URLs from parallel deploy jobs and post one combined comment. */
  const commentJob = {
    needs: deployJobNames,
    if: 'always() && !cancelled()',
    permissions: deployCommentPermissions,
    'runs-on': linuxX64Runner,
    steps: [
      deployCommentStep({
        summaryTitle: 'Vercel Deploy',
        tableHeaders: ['Target', 'URL'],
        noRowsMessage: 'No Vercel deploy URLs detected.',
        modeScript: deployModeScript,
        rowsScript: [
          'rows=""',
          ...opts.projects.map((p) =>
            [
              `url="\${{ needs.deploy-${p.name}.outputs.deploy_url }}"`,
              `if [ -n "$url" ]; then`,
              `  rows="\${rows}| ${p.name} | $url |\\n"`,
              'fi',
            ].join('\n'),
          ),
        ].join('\n'),
        commentTitle: 'Vercel Preview',
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
