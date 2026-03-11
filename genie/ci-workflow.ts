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
  [...(opts.unrestrictedEval ? ['restrict-eval = false'] : []), ...(opts.extraLines ?? [])].join(
    '\n',
  )

const withAppendedNixConfig = (command: string, opts: NixConfigOptions = {}) => {
  const extraConf = nixExtraConf(opts)
  if (extraConf === '') {
    return command
  }

  const quotedExtraConf = shellSingleQuote(extraConf)
  return `if [ -n "${'${NIX_CONFIG:-}'}" ]; then NIX_CONFIG_WITH_APPEND=$(printf '%s\\n%s' "$NIX_CONFIG" ${quotedExtraConf}); else NIX_CONFIG_WITH_APPEND=${quotedExtraConf}; fi; NIX_CONFIG="$NIX_CONFIG_WITH_APPEND" ${command}`
}

const runDevenvTasksBeforeWithOptions = (opts: NixConfigOptions, ...args: [string, ...string[]]) =>
  withAppendedNixConfig(`${devenvBinRef} tasks run ${args.join(' ')} --mode before`, opts)

/**
 * Shell snippet that wraps a compound command with lazy Nix store repair on failure.
 * On first failure, runs `nix-store --verify --check-contents --repair`,
 * clears eval cache, and retries once. Uses subshells so multi-statement
 * commands (like withAppendedNixConfig output) are treated as a single unit.
 *
 * Tradeoff: genuine task failures (e.g. type errors, test failures) pay a one-time
 * ~30-60s penalty for the unnecessary repair attempt before re-failing. This is
 * acceptable because store corruption is the rarer failure mode and saving ~25s on
 * every successful run across all jobs outweighs the occasional false retry.
 *
 * Safe to embed in if/elif branches.
 *
 * @see https://github.com/overengineeringstudio/effect-utils/issues/201
 */
const withStoreRepairRetry = (command: string) =>
  `(${command}) || { echo "::warning::Task failed, attempting Nix store repair and retry..."; DIAG_DIR="${'${NIX_STORE_DIAGNOSTICS_DIR:-${RUNNER_TEMP:-/tmp}}'}"; nix-store --verify --check-contents --repair > "$DIAG_DIR/nix-store-verify-repair.log" 2>&1 || true; rm -rf ~/.cache/nix/eval-cache-*; (${command}); }`

/** Build a command that runs one or more devenv tasks with `--mode before`. */
export const runDevenvTasksBefore = (...args: [string, ...string[]]) =>
  withStoreRepairRetry(runDevenvTasksBeforeWithOptions({ unrestrictedEval: true }, ...args))

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
 * Resolve the devenv binary and do a fast store-path validity check.
 *
 * Previously ran `devenv info` (~25s) as an eager canary to detect any store
 * corruption before tasks run. Now uses `nix-store --check-validity` (~1-2s)
 * which only verifies the devenv store path itself — not its full transitive
 * closure. Corruption in deeper deps is caught lazily at task time by
 * `withStoreRepairRetry`, which retries after repair.
 *
 * Still captures diagnostics dir + runner fingerprint for #272 instrumentation.
 *
 * @see https://github.com/namespacelabs/nscloud-setup/issues/8
 * @see https://github.com/overengineeringstudio/effect-utils/issues/201
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

DEVENV_OUT=$(resolve_devenv 2>"$DIAG_ROOT/resolve-devenv.log")
DEVENV_BIN="$DEVENV_OUT/bin/devenv"

# Fast validity check on the devenv store path (~1-2s vs ~25s for devenv info).
# Deeper transitive-dep corruption is caught lazily at task time via retry wrapper.
if ! nix-store --check-validity "$DEVENV_OUT" 2>/dev/null; then
  echo "::warning::devenv store path invalid, repairing..."
  nix-store --verify --check-contents --repair > "$DIAG_ROOT/nix-store-verify-repair.log" 2>&1 || true
  rm -rf ~/.cache/nix/eval-cache-*
  DEVENV_OUT=$(resolve_devenv 2>"$DIAG_ROOT/resolve-devenv-post-repair.log")
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

/**
 * Reusable step that writes a deployment summary and upserts a PR comment.
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

// =============================================================================
// Vercel Deploy Helpers
// =============================================================================

export type VercelProject = {
  /** Job key in the workflow (e.g. 'deploy-website') */
  key: string
  /** Human-readable name (e.g. 'website') */
  name: string
  /** Vercel project ID (prj_...) */
  projectId: string
}

/** Configure git author so Vercel associates the deploy with a team member. */
export const vercelGitAuthorStep = (opts: { name: string; email: string }) => ({
  name: 'Configure git author for Vercel',
  run: [
    `git config user.name "${opts.name}"`,
    `git config user.email "${opts.email}"`,
  ].join('\n'),
})

/** Validate the Vercel token works for the given org. Fails fast before attempting a deploy. */
export const vercelTokenValidationStep = (orgId: string) => ({
  name: 'Validate Vercel token',
  run: `npx vercel whoami --token "$VERCEL_TOKEN" --scope "${orgId}"`,
  env: {
    VERCEL_TOKEN: '${{ secrets.VERCEL_TOKEN }}',
  },
})

/** Deploy a single Vercel project. Prod on push-to-main/schedule/dispatch, preview on PRs. */
export const vercelDeployStep = (project: VercelProject, orgId: string) => ({
  name: `Deploy ${project.name} to Vercel`,
  id: 'deploy',
  run: [
    'if [ "${{ github.event_name }}" = "pull_request" ]; then',
    '  DEPLOY_URL=$(npx vercel deploy --token "$VERCEL_TOKEN")',
    'else',
    '  DEPLOY_URL=$(npx vercel deploy --prod --token "$VERCEL_TOKEN")',
    'fi',
    'echo "url=$DEPLOY_URL" >> "$GITHUB_OUTPUT"',
  ].join('\n'),
  env: {
    VERCEL_TOKEN: '${{ secrets.VERCEL_TOKEN }}',
    VERCEL_ORG_ID: orgId,
    VERCEL_PROJECT_ID: project.projectId,
  },
})

type VercelDeployOpts = {
  project: VercelProject
  orgId: string
  /** CI job names that must succeed before deploying */
  needs: readonly string[]
  /** Git author for Vercel team association (Vercel checks git author email) */
  gitAuthor: { name: string; email: string }
}

/** Create a complete Vercel deploy job for a project. */
export const vercelDeployJob = (opts: VercelDeployOpts) => ({
  needs: [...opts.needs],
  if: [
    'always()',
    `(github.event_name == 'schedule' || (${opts.needs.map((j) => `needs.${j}.result == 'success'`).join(' && ')}))`,
  ].join(' && '),
  'runs-on': 'ubuntu-latest',
  steps: [
    checkoutStep(),
    vercelGitAuthorStep(opts.gitAuthor),
    vercelTokenValidationStep(opts.orgId),
    vercelDeployStep(opts.project, opts.orgId),
  ],
})

/** Generate deploy jobs for multiple Vercel projects. Returns object keyed by project.key. */
export const vercelDeployJobs = (opts: {
  projects: readonly VercelProject[]
  orgId: string
  needs: readonly string[]
  gitAuthor: { name: string; email: string }
}) =>
  Object.fromEntries(
    opts.projects.map((p) => [p.key, vercelDeployJob({ ...opts, project: p })]),
  )

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
      'if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then',
      '  suffix=""',
      '  label="prod"',
      'elif [ "${{ github.event_name }}" = "pull_request" ]; then',
      '  suffix="-pr-${{ github.event.pull_request.number }}"',
      '  label="PR #${{ github.event.pull_request.number }}"',
      'else',
      '  exit 0',
      'fi',
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
