/**
 * Reusable Changesets-based supervised release workflow generator.
 *
 * Skeleton in-progress: this module captures the shape and contract that
 * `effect-utils` will codify for the LiveStore release flow so downstream
 * megarepo members (molty, openclaw, …) can adopt the same workflow
 * structure by configuration instead of copy-paste.
 *
 * See `context/workflows/release-workflow.md` for the design document.
 *
 * Status: STUB. The function returns a `githubWorkflow({...})` value with the
 * correct triggers, permissions, and job ids/conditions, but the job bodies
 * are intentionally placeholders. The next iteration wires the real
 * `create-release-pr` / `validate-release-plan` / `publish-release` step
 * sequences once the input shape and option naming have been reviewed.
 */

import {
  githubWorkflow,
  type ActionlintConfig,
  type GitHubWorkflowArgs,
} from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { bashShellDefaults, linuxX64Runner } from './shared.ts'

type WorkflowJob = GitHubWorkflowArgs['jobs'][string]
type WorkflowStep = WorkflowJob['steps'][number]

const placeholderRun = (label: string) =>
  `echo "TODO: ${label} — wired in follow-up; see context/workflows/release-workflow.md"\nexit 1`

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
 * Tag-specific deploy targets and validation overrides are intentionally
 * left out of the skeleton; the spec doc tracks them as open questions.
 */
export type ReleaseChannel = {
  readonly manualGate: boolean
}

/**
 * Inputs to `releaseWorkflow`.
 *
 * The shape intentionally mirrors the existing LiveStore release.yml so the
 * first migration is a faithful encode-then-decode. Options that look
 * LiveStore-specific (e.g. devtools artifact repack, prod docs deploy) are
 * pushed out to `validateSteps` / `publishSteps` so the helper does not need
 * to model them directly.
 */
export type ReleaseWorkflowOptions = {
  /**
   * Workflow `name:` field. Defaults to `'Release'`.
   */
  readonly name?: string

  /**
   * Workspace identifier used in branch names and commit messages.
   * For LiveStore this is `'livestore'`; the generated branch is
   * `automation/release-<version>` and the commit subject is
   * `Prepare <Workspace> <version> release`.
   *
   * Open question: should this carry a separate `releaseBranchPrefix` /
   * `commitSubject` override, or always derive from `workspaceName`?
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
   * Files whose change should trigger the `validate-release-plan` job via
   * `pull_request`. This is intentionally broader than `releasePlanPath`
   * alone because release tooling changes also need to exercise the
   * dry-run before they land.
   */
  readonly releasePlanPaths: readonly string[]

  /**
   * Per-npm-tag release policy. Keys are the npm dist-tags surfaced in the
   * workflow_dispatch `npm_tag` input (`latest`, `dev`, `next`, …).
   *
   * The keys here drive the `choice` options of the `npm_tag` input.
   */
  readonly releaseChannels: Record<string, ReleaseChannel>

  /**
   * Default `npm_tag` for the workflow_dispatch input.
   * Must be a key in `releaseChannels`. Defaults to `'latest'`.
   */
  readonly defaultNpmTag?: string

  /**
   * Steps run at the start of each job after `actions/checkout@v4`.
   *
   * Typically this is the repo's `standardSelfHostedPnpmCiPrepSteps(...)`
   * (or `livestoreSetupSteps`) — devenv setup, nix cache restore, pnpm
   * install, etc. The helper keeps this opaque on purpose; the release
   * workflow only needs *some* working devenv to run `dt` tasks.
   */
  readonly setupSteps: readonly WorkflowStep[]

  /**
   * Steps that perform the `validate-release-plan` payload. These run after
   * `setupSteps` inside the `validate-release-plan` job and must:
   *
   * - dry-run the actual npm publish (no token writes), and
   * - exercise any additional release-time repackaging the repo performs
   *   (LiveStore: DevTools artifact repack-dryrun).
   *
   * The helper appends a "select release plan for validation" step before
   * this, and a "read release plan" step after, so this list can focus on
   * the dry-run substance.
   */
  readonly validateSteps: readonly WorkflowStep[]

  /**
   * Steps that perform the `publish-release` payload. These run after
   * `setupSteps` inside the `publish-release` job and must:
   *
   * - publish the npm package set, and
   * - perform any post-publish hooks (docs deploy, search sync, GitHub
   *   release upload, …).
   *
   * The helper appends the "read release plan" + npm-token fallback steps
   * before this; consumers do not need to repeat them.
   */
  readonly publishSteps: readonly WorkflowStep[]

  /**
   * If `true`, the publish job skips the explicit `NPM_TOKEN` fallback and
   * relies on npm OIDC trusted publishing. LiveStore currently keeps the
   * fallback as a safety net; new repos should default to `true`.
   *
   * Open question: should this be `true` by default for new repos and
   * `false` by default for repos that opt-in via `legacyNpmToken: true`?
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
}

// =============================================================================
// Implementation (skeleton)
// =============================================================================

/**
 * Build a Changesets-based supervised release workflow.
 *
 * The shape is fixed across consumers:
 *
 * - Jobs: `source-policy` (optional), `create-release-pr`,
 *   `validate-release-plan`, `publish-release`.
 * - Triggers: `workflow_dispatch` (mode input), `pull_request` on
 *   `releasePlanPaths`, `push` to `main` on `releasePlanPath`.
 * - Job `if` conditions wire each job to the right subset of triggers.
 *
 * The job bodies are intentionally minimal in this skeleton; see the design
 * doc for the planned content and the LiveStore reference implementation at
 * `livestorejs/livestore:.github/workflows/release.yml.genie.ts` for the
 * shape this generator will eventually produce.
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

  // PLACEHOLDER job bodies. The next iteration replaces these `run` blocks
  // with the real step sequence from the LiveStore reference workflow:
  //  - create-release-pr: changeset:version + open/refresh PR + dispatch
  //    validate workflow + (auto-merge based on channel.manualGate).
  //  - validate-release-plan: synthetic-plan selection + dryrun publish +
  //    repo-supplied validateSteps.
  //  - publish-release: read release plan + (optional) npm token fallback +
  //    repo-supplied publishSteps.

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
      ...opts.setupSteps,
      { name: 'Create release plan PR (placeholder)', run: placeholderRun('create-release-pr') },
    ],
  }

  const validateReleasePlanJob: WorkflowJob = {
    if: "github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'validate-release-plan')",
    'runs-on': linuxX64Runner as unknown as string[],
    defaults: bashShellDefaults,
    steps: [
      ...opts.setupSteps,
      { name: 'Select release plan for validation (placeholder)', run: placeholderRun('select release plan') },
      ...opts.validateSteps,
    ],
  }

  const publishReleaseJob: WorkflowJob = {
    if: "github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'publish-release')",
    'runs-on': linuxX64Runner as unknown as string[],
    permissions: {
      contents: 'write',
      'id-token': 'write',
    },
    env: {
      GH_TOKEN: '${{ github.token }}',
      ...(opts.trustedPublishing === false ? { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' } : {}),
    },
    defaults: bashShellDefaults,
    steps: [
      ...opts.setupSteps,
      { name: 'Read release plan (placeholder)', run: placeholderRun('read release plan') },
      ...opts.publishSteps,
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
