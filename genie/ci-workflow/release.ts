/**
 * Reusable Changesets-based supervised release workflow generator.
 *
 * Produces a `githubWorkflow({...})` value with the canonical job layout used
 * by LiveStore (and future adopters like molty / openclaw): an optional
 * `source-policy` job, a `create-release-pr` job that opens the reviewable
 * release-plan PR, a `validate-release-plan` job that dry-runs publish on
 * the PR, and a `publish-release` job that runs on the post-merge push.
 *
 * The helper owns the job skeletons — triggers, permissions, `if:` gates,
 * exported env vars, GitHub Release creation, optional auto-merge wiring —
 * so consumers only configure typed inputs and pass the repo-specific
 * `validateSteps` / `publishSteps`.
 *
 * See `context/workflows/release-workflow.md` for the design document.
 */

import {
  githubWorkflow,
  type ActionlintConfig,
  type GitHubWorkflowArgs,
} from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { bashShellDefaults, linuxX64Runner } from './shared.ts'

type WorkflowJob = GitHubWorkflowArgs['jobs'][string]
type WorkflowStep = WorkflowJob['steps'][number]

// =============================================================================
// Types
// =============================================================================

/**
 * Per-npm-tag policy.
 *
 * `manualGate: true` keeps the release-plan PR human-merged (stable releases).
 * `manualGate: false` enables GitHub auto-merge for the generated PR
 * (prerelease / dev releases).
 *
 * `deployTarget` drives the exported `LIVESTORE_RELEASE_DEPLOY_TARGET`
 * (or generally `<workspaceName>_RELEASE_DEPLOY_TARGET`) env var and gates
 * `postPublishSteps` per channel without forcing consumers to re-derive
 * prod-vs-dev from `npmTag` in bash.
 */
export type ReleaseChannel = {
  readonly manualGate: boolean
  readonly deployTarget: 'prod' | 'dev' | 'none'
}

/**
 * Inputs to `releaseWorkflow`.
 *
 * Shape choices:
 *
 * - LiveStore-specific concerns (devtools repack, prod docs deploy, search
 *   sync) plug in as `validateSteps` / `publishSteps` / `postPublishSteps`.
 * - The `create-release-pr` body is rendered from typed inputs (no
 *   consumer-owned bash heredoc). `${var}` substitution into the templates
 *   is enough; consumers that need richer templating can render a string
 *   themselves and pass it as `prBodyTemplate`.
 */
export type ReleaseWorkflowOptions = {
  /**
   * Workflow `name:` field. Defaults to `'Release'`.
   */
  readonly name?: string

  /**
   * Workspace identifier used in branch names, env var prefixes, and the
   * default PR title template. For LiveStore this is `'livestore'`, which
   * produces the env vars `LIVESTORE_RELEASE_VERSION`, `LIVESTORE_NPM_TAG`,
   * and `LIVESTORE_RELEASE_DEPLOY_TARGET`.
   */
  readonly workspaceName: string

  /**
   * Workspace display name used in PR titles and bodies. Defaults to
   * `workspaceName` with the first letter uppercased.
   */
  readonly workspaceDisplayName?: string

  /**
   * Path to the canonical release-plan JSON file relative to the repo root.
   * Defaults to `'release/release-plan.json'`.
   */
  readonly releasePlanPath?: string

  /**
   * Files whose change should trigger `validate-release-plan` via
   * `pull_request`. Broader than `releasePlanPath` alone because release
   * tooling changes also need to exercise the dry-run before they land.
   */
  readonly releasePlanPaths: readonly string[]

  /**
   * Path to the release notes markdown artifact that the release PR stages
   * and the publish job uploads as the GitHub Release body via
   * `gh release create --notes-file`. Defaults to
   * `'release/release-notes.md'`.
   */
  readonly releaseNotesPath?: string

  /**
   * Per-npm-tag release policy. Keys are the npm dist-tags surfaced in the
   * `workflow_dispatch` `npm_tag` input (`latest`, `dev`, `next`, …).
   */
  readonly releaseChannels: Record<string, ReleaseChannel>

  /**
   * Default `npm_tag` for the workflow_dispatch input.
   * Must be a key in `releaseChannels`. Defaults to `'latest'`.
   */
  readonly defaultNpmTag?: string

  /**
   * Prefix for the automation branch created by `create-release-pr`.
   * Defaults to `'automation/release-'`. The version is appended.
   */
  readonly releaseBranchPrefix?: string

  /**
   * Template for the release PR title. `${workspaceDisplayName}` and
   * `${version}` are substituted at render time.
   *
   * Defaults to `'Prepare ${workspaceDisplayName} ${version} release'`.
   */
  readonly prTitleTemplate?: string

  /**
   * Template for the release PR body. `${workspaceDisplayName}` and
   * `${version}` are substituted at render time. A reasonable default
   * covers the rationale and the validate-then-publish handoff.
   */
  readonly prBodyTemplate?: string

  /**
   * Files to `git add` before committing the release plan PR. Consumers
   * specify their full staged file set (release artifacts, package
   * manifests, lockfiles, generated docs/examples manifests, …).
   */
  readonly stagedFiles: readonly string[]

  /**
   * Steps run at the start of each job after `actions/checkout@v4`.
   *
   * When provided, this fully **replaces** the default empty setup. Use this
   * if you want full control over the setup (devenv, nix cache restore,
   * pnpm install, …). For LiveStore this is `livestoreSetupSteps`.
   */
  readonly setupSteps?: readonly WorkflowStep[]

  /**
   * Extra steps appended after `setupSteps` (or after the empty default)
   * but before the job's substance. Useful for repo-wide hooks like a
   * single extra `actions/cache` call without redefining the entire
   * setup sequence.
   */
  readonly extraSetupSteps?: readonly WorkflowStep[]

  /**
   * Steps that perform the `validate-release-plan` payload. These run after
   * the setup steps and the synthetic-plan selection step. Must:
   *
   * - dry-run the actual npm publish (no token writes), and
   * - exercise any additional release-time repackaging the repo performs
   *   (LiveStore: DevTools artifact repack-dryrun).
   *
   * The helper appends a "read release plan" step **after** these so the
   * exported env vars are visible to anything that runs later.
   */
  readonly validateSteps: readonly WorkflowStep[]

  /**
   * Steps that perform the npm publish payload in `publish-release`. These
   * run after the setup steps, the "read release plan" step, and the
   * (optional) npm token fallback.
   *
   * Things specific to particular deploy targets (prod docs deploy,
   * production search sync) belong in `postPublishSteps`, not here.
   */
  readonly publishSteps: readonly WorkflowStep[]

  /**
   * Optional post-publish hooks (docs deploy, search index sync, …). Each
   * step is automatically gated by the channel's `deployTarget`:
   *
   * - Steps in `postPublishSteps` only run when the channel's
   *   `deployTarget !== 'none'`.
   * - Repos that need finer per-target gating (prod-only, dev-only) can
   *   still set an explicit `if:` on individual steps.
   *
   * The helper exports `<WORKSPACE>_RELEASE_DEPLOY_TARGET` so step-level
   * `if:` conditions like `env.LIVESTORE_RELEASE_DEPLOY_TARGET == 'prod'`
   * keep working.
   */
  readonly postPublishSteps?: readonly WorkflowStep[]

  /**
   * Additional step appended right before the "Open release plan PR" step
   * runs. Useful for consumers that need to materialize a release artifact
   * (e.g. extract release notes from the changelog) into the staged file
   * set before the commit / push.
   */
  readonly preCreatePrSteps?: readonly WorkflowStep[]

  /**
   * If `true`, the publish job skips the explicit `NPM_TOKEN` fallback and
   * relies on npm OIDC trusted publishing. New repos should default to
   * `true`. LiveStore currently keeps the fallback as a safety net.
   */
  readonly trustedPublishing?: boolean

  /**
   * Optional first-party policy job to run alongside the release jobs
   * (`livestoreDefaultRefPolicyJob`-equivalent). Pass `false` to omit.
   */
  readonly sourcePolicyJob?: WorkflowJob | false

  /**
   * Optional `actionlint` config. Defaults to the workflow's parent default
   * (see `ciWorkflow` / `defaultActionlintConfig`). Most repos can omit it.
   */
  readonly actionlint?: ActionlintConfig | false

  /**
   * Additional workflow-level env. Merged with the standard release env.
   */
  readonly env?: Record<string, string>

  /**
   * Runner labels for the `validate-release-plan` and `publish-release`
   * jobs. `create-release-pr` always runs on `ubuntu-latest` because it
   * only needs `git` + `gh`. Defaults to `linuxX64Runner`.
   */
  readonly runner?: GitHubWorkflowJobRunsOn
}

type GitHubWorkflowJobRunsOn = WorkflowJob['runs-on']

// =============================================================================
// Implementation
// =============================================================================

/**
 * Build a Changesets-based supervised release workflow.
 *
 * Job layout:
 *
 * - `source-policy` (optional)
 * - `create-release-pr` — `workflow_dispatch` `mode=create-release-pr`
 * - `validate-release-plan` — `pull_request` + `workflow_dispatch` `mode=validate-release-plan`
 * - `publish-release` — `push` to `main` + `workflow_dispatch` `mode=publish-release`
 *
 * See `context/workflows/release-workflow.md` for the worked LiveStore
 * example and migration notes.
 */
export const releaseWorkflow = (opts: ReleaseWorkflowOptions) => {
  const npmTagOptions = Object.keys(opts.releaseChannels)
  if (npmTagOptions.length === 0) {
    throw new Error('releaseWorkflow: at least one releaseChannels entry is required')
  }

  const defaultNpmTag =
    opts.defaultNpmTag ?? (npmTagOptions.includes('latest') === true ? 'latest' : npmTagOptions[0]!)
  if (npmTagOptions.includes(defaultNpmTag) === false) {
    throw new Error(
      `releaseWorkflow: defaultNpmTag '${defaultNpmTag}' is not present in releaseChannels keys: ${npmTagOptions.join(', ')}`,
    )
  }

  const releasePlanPath = opts.releasePlanPath ?? 'release/release-plan.json'
  const releaseNotesPath = opts.releaseNotesPath ?? 'release/release-notes.md'
  const releaseBranchPrefix = opts.releaseBranchPrefix ?? 'automation/release-'
  const workspaceDisplayName =
    opts.workspaceDisplayName ?? capitalizeFirst(opts.workspaceName)
  const envPrefix = opts.workspaceName.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')
  const versionEnv = `${envPrefix}_RELEASE_VERSION`
  const npmTagEnv = `${envPrefix}_NPM_TAG`
  const deployTargetEnv = `${envPrefix}_RELEASE_DEPLOY_TARGET`

  const prTitleTemplate =
    opts.prTitleTemplate ?? `Prepare ${'${workspaceDisplayName}'} ${'${version}'} release`
  const prBodyTemplate =
    opts.prBodyTemplate ??
    [
      `Prepares a ${'${workspaceDisplayName}'} release group for ${'${version}'} from the pending Changesets.`,
      '',
      `The release workflow dry-runs the npm publish on this PR. After merge into main, the same workflow publishes the release group. The publish job can also be manually dispatched after an operator verifies that the checked-in release plan is still the intended release.`,
      '',
      '## Rationale',
      '',
      `Release cutting is represented as a reviewable data change instead of a local operator action. Changesets provide the release intent and fixed-group version calculation; ${'${workspaceDisplayName}'}'s existing publisher remains responsible for package provenance.`,
    ].join('\n')

  const resolvedSetupSteps = opts.setupSteps ?? []
  const extraSetupSteps = opts.extraSetupSteps ?? []
  const setupSteps: readonly WorkflowStep[] = [...resolvedSetupSteps, ...extraSetupSteps]

  const stagedFiles = opts.stagedFiles
  if (stagedFiles.length === 0) {
    throw new Error('releaseWorkflow: stagedFiles must include at least the release plan path')
  }

  // -- create-release-pr ------------------------------------------------------

  // Channel-policy lookup expressed as bash case branches. Drives the
  // auto-merge toggle without consumers having to re-derive it.
  const autoMergeCaseBranches = npmTagOptions
    .map((tag) => {
      const channel = opts.releaseChannels[tag]!
      const action = channel.manualGate === true ? 'manual' : 'auto'
      return `  ${tag}) policy=${action} ;;`
    })
    .join('\n')

  const renderTemplate = (template: string, version = '$RELEASE_VERSION') =>
    template
      .replaceAll('${workspaceDisplayName}', workspaceDisplayName)
      .replaceAll('${workspaceName}', opts.workspaceName)
      .replaceAll('${version}', version)

  const stagedFilesBlock = stagedFiles.map((f) => `  ${f}`).join(' \\\n')

  const openReleasePrRun = [
    `set -euo pipefail`,
    `RELEASE_VERSION="$(jq -r '.version' ${shQuote(releasePlanPath)})"`,
    `: "\${RELEASE_VERSION:?Missing generated release version}"`,
    `: "\${${npmTagEnv}:?Missing npm tag}"`,
    ``,
    `git config user.name "github-actions[bot]"`,
    `git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`,
    ``,
    `branch="${releaseBranchPrefix}$RELEASE_VERSION"`,
    `git checkout -B "$branch"`,
    `git add \\`,
    `${stagedFilesBlock}`,
    ``,
    `if git diff --cached --quiet; then`,
    `  echo "Release plan already current."`,
    `else`,
    `  git commit -m "Prepare ${workspaceDisplayName} $RELEASE_VERSION release"`,
    `  git fetch origin "refs/heads/$branch:refs/remotes/origin/$branch" || true`,
    `  git push --force-with-lease="refs/heads/$branch" origin "$branch"`,
    `fi`,
    ``,
    `title=${shQuote(renderTemplate(prTitleTemplate))}`,
    `body=$(cat <<'BODY'`,
    `${renderTemplate(prBodyTemplate)}`,
    `BODY`,
    `)`,
    ``,
    `if gh pr view "$branch" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then`,
    `  gh pr edit "$branch" --repo "$GITHUB_REPOSITORY" --title "$title" --body "$body"`,
    `else`,
    `  gh pr create \\`,
    `    --repo "$GITHUB_REPOSITORY" \\`,
    `    --base main \\`,
    `    --head "$branch" \\`,
    `    --title "$title" \\`,
    `    --body "$body"`,
    `fi`,
    ``,
    `gh workflow run ci.yml --repo "$GITHUB_REPOSITORY" --ref "$branch" || true`,
    `gh workflow run release.yml --repo "$GITHUB_REPOSITORY" --ref "$branch" \\`,
    `  -f mode=validate-release-plan \\`,
    `  -f npm_tag="$${npmTagEnv}"`,
    ``,
    `policy=manual`,
    `case "$${npmTagEnv}" in`,
    autoMergeCaseBranches,
    `  *) policy=manual ;;`,
    `esac`,
    ``,
    `if [ "$policy" = "manual" ]; then`,
    `  echo "npm_tag=$${npmTagEnv}: leaving auto-merge disabled; this PR requires a human reviewer."`,
    `elif gh pr view "$branch" --repo "$GITHUB_REPOSITORY" --json autoMergeRequest --jq '.autoMergeRequest != null' | grep -qx true; then`,
    `  echo "Auto-merge already enabled for $branch."`,
    `else`,
    `  gh pr merge "$branch" --repo "$GITHUB_REPOSITORY" --auto --merge`,
    `fi`,
  ].join('\n')

  const createReleasePrJob: WorkflowJob = {
    if: "github.event_name == 'workflow_dispatch' && inputs.mode == 'create-release-pr'",
    'runs-on': 'ubuntu-latest',
    permissions: {
      actions: 'write',
      contents: 'write',
      'id-token': 'write',
      'pull-requests': 'write',
    },
    defaults: bashShellDefaults,
    steps: [
      { name: 'Checkout', uses: 'actions/checkout@v4', with: { ref: 'main' } },
      // setupSteps usually starts with its own checkout; drop it on
      // create-release-pr because we already checked out main above.
      ...setupSteps.slice(setupStepsStartsWithCheckout(setupSteps) ? 1 : 0),
      ...(opts.preCreatePrSteps ?? []),
      {
        name: 'Open release plan PR',
        env: {
          GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
          [npmTagEnv]: '${{ inputs.npm_tag }}',
        },
        run: openReleasePrRun,
      },
    ],
  }

  // -- validate-release-plan --------------------------------------------------

  const deployTargetCaseBranches = npmTagOptions
    .map((tag) => {
      const channel = opts.releaseChannels[tag]!
      return `  ${tag}) deploy_target=${channel.deployTarget} ;;`
    })
    .join('\n')

  const selectReleasePlanRun = [
    `set -euo pipefail`,
    `use_synthetic_plan=false`,
    ``,
    `if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then`,
    `  git fetch origin "\${{ github.base_ref }}" --depth=1`,
    `  if ! git diff --name-only "origin/\${{ github.base_ref }}...HEAD" | grep -qx ${shQuote(releasePlanPath)}; then`,
    `    use_synthetic_plan=true`,
    `  fi`,
    `elif [ ! -f ${shQuote(releasePlanPath)} ]; then`,
    `  use_synthetic_plan=true`,
    `fi`,
    ``,
    `if [ "$use_synthetic_plan" = "false" ]; then`,
    `  exit 0`,
    `fi`,
    ``,
    `mkdir -p "$(dirname ${shQuote(releasePlanPath)})"`,
    `# PRs that touch release machinery but do not carry an actual release plan still`,
    `# need to exercise package publishing. Use a unique, unpublished prerelease`,
    `# version derived from the commit SHA.`,
    `short_sha="\${GITHUB_SHA:0:12}"`,
    `version="0.0.0-ci.release-validation.$short_sha"`,
    `npm_tag=${shQuote(syntheticNpmTag(opts.releaseChannels))}`,
    `jq -n \\`,
    `  --arg version "$version" \\`,
    `  --arg npmTag "$npm_tag" \\`,
    `  '{ schemaVersion: 1, version: $version, npmTag: $npmTag }' > ${shQuote(releasePlanPath)}`,
  ].join('\n')

  const readReleasePlanWithDeployTargetRun = [
    `set -euo pipefail`,
    `release_version="$(jq -r '.version' ${shQuote(releasePlanPath)})"`,
    `npm_tag="$(jq -r '.npmTag' ${shQuote(releasePlanPath)})"`,
    `: "\${release_version:?Missing release version}"`,
    `: "\${npm_tag:?Missing npm tag}"`,
    `echo "${versionEnv}=$release_version" >> "$GITHUB_ENV"`,
    `echo "${npmTagEnv}=$npm_tag" >> "$GITHUB_ENV"`,
    `deploy_target=none`,
    `case "$npm_tag" in`,
    deployTargetCaseBranches,
    `  *) deploy_target=none ;;`,
    `esac`,
    `echo "${deployTargetEnv}=$deploy_target" >> "$GITHUB_ENV"`,
  ].join('\n')

  const validateReleasePlanJob: WorkflowJob = {
    if: "github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'validate-release-plan')",
    'runs-on': opts.runner ?? (linuxX64Runner as unknown as string[]),
    defaults: bashShellDefaults,
    steps: [
      ...setupSteps,
      {
        name: 'Select release plan for validation',
        run: selectReleasePlanRun,
      },
      ...opts.validateSteps,
      {
        name: 'Read release plan',
        run: readReleasePlanWithDeployTargetRun,
      },
    ],
  }

  // -- publish-release --------------------------------------------------------

  const readReleasePlanForPublishRun = [
    `set -euo pipefail`,
    `release_version="$(jq -r '.version' ${shQuote(releasePlanPath)})"`,
    `npm_tag="$(jq -r '.npmTag' ${shQuote(releasePlanPath)})"`,
    `: "\${release_version:?Missing release version}"`,
    `: "\${npm_tag:?Missing npm tag}"`,
    `echo "${versionEnv}=$release_version" >> "$GITHUB_ENV"`,
    `echo "${npmTagEnv}=$npm_tag" >> "$GITHUB_ENV"`,
    `deploy_target=none`,
    `case "$npm_tag" in`,
    deployTargetCaseBranches,
    `  *) deploy_target=none ;;`,
    `esac`,
    `echo "${deployTargetEnv}=$deploy_target" >> "$GITHUB_ENV"`,
  ].join('\n')

  const npmTokenFallbackStep: WorkflowStep = {
    name: 'Configure npm token fallback',
    run: [
      `set -euo pipefail`,
      `: "\${NODE_AUTH_TOKEN:?Missing NPM_TOKEN secret}"`,
      `npmrc="$HOME/.npmrc"`,
      `printf '%s\\n' "always-auth=true" > "$npmrc"`,
      `printf '%s\\n' "//registry.npmjs.org/:_authToken=$NODE_AUTH_TOKEN" >> "$npmrc"`,
      `printf '%s\\n' "NPM_CONFIG_USERCONFIG=$npmrc" >> "$GITHUB_ENV"`,
      `printf '%s\\n' "NPM_CONFIG_REGISTRY=https://registry.npmjs.org/" >> "$GITHUB_ENV"`,
      `NPM_CONFIG_USERCONFIG="$npmrc" NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ npm whoami >/dev/null`,
    ].join('\n'),
  }

  const createGitHubReleaseStep: WorkflowStep = {
    name: 'Create GitHub Release',
    env: { GH_TOKEN: '${{ github.token }}' },
    run: [
      `set -euo pipefail`,
      `: "\${${versionEnv}:?Missing release version}"`,
      `if [ ! -f ${shQuote(releaseNotesPath)} ]; then`,
      `  echo "::warning::release notes file ${releaseNotesPath} not found; creating release without --notes-file"`,
      `  notes_args=()`,
      `else`,
      `  notes_args=(--notes-file ${shQuote(releaseNotesPath)})`,
      `fi`,
      `tag="v$${versionEnv}"`,
      `if gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then`,
      `  gh release edit "$tag" --repo "$GITHUB_REPOSITORY" "\${notes_args[@]}"`,
      `else`,
      `  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --title "$tag" --target "$GITHUB_SHA" "\${notes_args[@]}"`,
      `fi`,
    ].join('\n'),
  }

  const gatedPostPublishSteps: readonly WorkflowStep[] = (opts.postPublishSteps ?? []).map((step) =>
    gateStepByDeployTarget(step, deployTargetEnv),
  )

  const publishReleaseJob: WorkflowJob = {
    if: "github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'publish-release')",
    'runs-on': opts.runner ?? (linuxX64Runner as unknown as string[]),
    permissions: {
      contents: 'write',
      'id-token': 'write',
    },
    env: {
      GH_TOKEN: '${{ github.token }}',
      ...(opts.trustedPublishing === true ? {} : { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' }),
    },
    defaults: bashShellDefaults,
    steps: [
      ...setupSteps,
      {
        name: 'Read release plan',
        run: readReleasePlanForPublishRun,
      },
      ...(opts.trustedPublishing === true ? [] : [npmTokenFallbackStep]),
      ...opts.publishSteps,
      createGitHubReleaseStep,
      ...gatedPostPublishSteps,
    ],
  }

  const jobs: Record<string, WorkflowJob> = {}
  if (opts.sourcePolicyJob !== undefined && opts.sourcePolicyJob !== false) {
    jobs['source-policy'] = opts.sourcePolicyJob
  }
  jobs['create-release-pr'] = createReleasePrJob
  jobs['validate-release-plan'] = validateReleasePlanJob
  jobs['publish-release'] = publishReleaseJob

  return githubWorkflow({
    name: opts.name ?? 'Release',
    ...(opts.actionlint === false ? {} : opts.actionlint !== undefined ? { actionlint: opts.actionlint } : {}),
    on: {
      workflow_dispatch: {
        inputs: {
          npm_tag: {
            description: 'npm dist-tag for the release',
            required: true,
            default: defaultNpmTag,
            type: 'choice',
            options: npmTagOptions,
          },
          mode: {
            description: 'Release workflow mode',
            required: true,
            default: 'create-release-pr',
            type: 'choice',
            options: ['create-release-pr', 'validate-release-plan', 'publish-release'],
          },
        },
      },
      pull_request: {
        paths: [...opts.releasePlanPaths],
      },
      push: {
        branches: ['main'],
        paths: [releasePlanPath],
      },
    },
    permissions: {
      contents: 'read',
      'id-token': 'write',
    },
    env: {
      CI: 'true',
      FORCE_SETUP: '1',
      ...opts.env,
    },
    jobs,
  })
}

// =============================================================================
// Internal helpers
// =============================================================================

const capitalizeFirst = (value: string) =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)

/** Single-quote a value for safe inclusion in bash, escaping embedded quotes. */
const shQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

/**
 * Pick a sensible npm tag for synthesized release plans during PR validation.
 *
 * Prefers a non-`latest` channel so the synthesized plan never collides with
 * the stable release lane. Falls back to whatever channel exists.
 */
const syntheticNpmTag = (channels: Record<string, ReleaseChannel>) => {
  const keys = Object.keys(channels)
  const next = keys.find((k) => k === 'next')
  if (next !== undefined) return next
  const dev = keys.find((k) => k === 'dev')
  if (dev !== undefined) return dev
  const nonLatest = keys.find((k) => k !== 'latest')
  return nonLatest ?? keys[0]!
}

/**
 * If `setupSteps` opens with an `actions/checkout@*` step, the
 * `create-release-pr` job skips it (we already checked out `main` with an
 * explicit ref). This matches the common pattern where shared setup helpers
 * start with `checkoutStep()`.
 */
const setupStepsStartsWithCheckout = (steps: readonly WorkflowStep[]) => {
  const first = steps[0]
  if (first === undefined) return false
  const uses = (first as { uses?: unknown }).uses
  return typeof uses === 'string' && uses.startsWith('actions/checkout@')
}

/**
 * Wrap an `if:` around a step so it only runs when the deploy target is
 * not `none`. Existing `if:` expressions are preserved via `&&`.
 */
const gateStepByDeployTarget = (step: WorkflowStep, deployTargetEnv: string): WorkflowStep => {
  const existing = (step as { if?: unknown }).if
  const gate = `env.${deployTargetEnv} != 'none'`
  const nextIf =
    typeof existing === 'string' && existing.length > 0 ? `(${existing}) && (${gate})` : gate
  return { ...step, if: nextIf } as WorkflowStep
}
