# Release Workflow Helper (`releaseWorkflow`)

Status: **adoption-ready in `genie/ci-workflow/release.ts`**.

This document captures the shape of the shared `releaseWorkflow({...})`
helper that codifies the Changesets-based supervised release flow first
shipped in LiveStore, so other megarepo members (`molty`, `openclaw`, …)
can adopt the same structure via config instead of copying
`release.yml.genie.ts` wholesale.

The reference implementation it abstracts from is
`livestorejs/livestore:.github/workflows/release.yml.genie.ts` plus the
human-readable description at
`livestorejs/livestore:contributor-docs/release-workflows.md`. See
`Refs livestorejs/livestore#1269` for the immediate motivation (the
stable-release auto-merge gate) and
`Refs livestorejs/livestore#1281` for the release-notes artifact that
the helper now hands to `gh release create --notes-file`.

## Goals

- One `releaseWorkflow({...})` call per repo produces a complete
  `.github/workflows/release.yml`.
- Same job ids and `if` conditions across consumers so operators can
  navigate any repo's release workflow without re-learning the layout.
- Per-channel policy (stable-vs-prerelease auto-merge, prod-vs-dev
  deploy target) is config, not branching code.
- Repo-specific work (publish task names, devtools repack, prod docs
  deploy, search sync, …) plugs in as `validateSteps` / `publishSteps`
  / `postPublishSteps`. The helper does not try to model those directly.
- The release PR's bash body is owned by the helper and rendered from
  typed inputs so consumers cannot accidentally diverge on the PR
  markup, branch naming, or auto-merge wiring.

## Non-goals

- **Snapshot releases.** Per-commit `0.0.0-snapshot-<sha>` publishing has
  no release plan and does not benefit from the supervised PR shape.
  Snapshot publishing stays in `ci.yml`.
- **Migrating effect-utils' own usage.** Effect-utils does not consume the
  helper; LiveStore (and future molty/openclaw) do.
- A turing-complete template engine for `prTitleTemplate` /
  `prBodyTemplate`. Substitution is `${workspaceName}`,
  `${workspaceDisplayName}`, `${version}` only. Consumers that need
  richer markup can render a string themselves and pass it as the
  template.

## Input shape

```ts
import { releaseWorkflow } from '<effect-utils>/genie/ci-workflow.ts'

export default releaseWorkflow({
  workspaceName: 'livestore',
  workspaceDisplayName: 'LiveStore',

  releasePlanPaths: [
    '.github/workflows/release.yml',
    '.github/workflows/release.yml.genie.ts',
    'genie/repo.ts',
    'nix/devenv-modules/tasks/local/mono-wrappers.nix',
    'release/release-plan.json',
    'release/version.json',
    'release/devtools-artifact.json',
    'scripts/src/commands/release.ts',
    'scripts/src/commands/devtools-artifact.ts',
    'scripts/src/commands/changesets.ts',
  ],

  // Per-npm-tag policy. `manualGate` drives auto-merge; `deployTarget`
  // gates `postPublishSteps` per channel and is exported as
  // LIVESTORE_RELEASE_DEPLOY_TARGET.
  releaseChannels: {
    latest: { manualGate: true, deployTarget: 'prod' },
    dev: { manualGate: false, deployTarget: 'dev' },
    next: { manualGate: false, deployTarget: 'none' },
  },
  defaultNpmTag: 'latest',

  // Files staged into the release plan commit by `create-release-pr`.
  stagedFiles: [
    '.changeset',
    'package.json',
    'pnpm-lock.yaml',
    'release/devtools-artifact.json',
    'release/release-notes.md',
    'release/release-plan.json',
    'release/version.json',
    'docs/package.json',
    'docs/src/content/_assets/code/package.json',
    'examples',
    'packages',
    'tests',
  ],

  // Per-job setup (devenv, nix cache, pnpm install, ...). When provided,
  // fully replaces the default empty setup. Effect-utils does not assume
  // a particular CI prep contract.
  setupSteps: livestoreSetupSteps,

  // Materialize the release-notes artifact into the staged file set
  // before commit/push.
  preCreatePrSteps: [
    devenvTaskStep('Generate release plan from Changesets', 'release:changeset:version'),
    devenvTaskStep('Extract release notes', 'release:notes:extract'),
  ],

  // Dry-run + repack-dryrun substance for the release-plan PR.
  validateSteps: [
    devenvTaskStep('Dry-run stable package publish', 'release:stable:dryrun'),
    devenvTaskStep(
      'Dry-run DevTools artifact repack',
      'release:devtools-artifact:repack-dryrun:no-install',
    ),
  ],

  // npm publish substance after the release-plan PR merges to main.
  publishSteps: [
    devenvTaskStep('Publish stable package release', 'release:stable:publish'),
    devenvTaskStep(
      'Publish DevTools artifact release',
      'release:devtools-artifact:publish:no-install',
    ),
  ],

  // Per-deploy-target post-publish hooks. Each step is auto-gated by
  // the channel's `deployTarget !== 'none'`; consumers can add an
  // explicit `if:` for finer prod-vs-dev gating.
  postPublishSteps: [
    {
      name: 'Deploy production docs',
      if: "env.LIVESTORE_RELEASE_DEPLOY_TARGET == 'prod'",
      run: runDevenvTasksBefore('docs:deploy:prod'),
      env: { NETLIFY_AUTH_TOKEN: '${{ secrets.NETLIFY_AUTH_TOKEN }}' },
    },
    {
      name: 'Deploy production examples',
      if: "env.LIVESTORE_RELEASE_DEPLOY_TARGET == 'prod'",
      run: runDevenvTasksBefore('examples:deploy:prod'),
      env: {
        CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
        CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
      },
    },
  ],

  trustedPublishing: false, // LiveStore keeps the NPM_TOKEN fallback
  sourcePolicyJob: livestoreDefaultRefPolicyJob,
})
```

The full TypeScript type is in `genie/ci-workflow/release.ts`:

```ts
export type ReleaseChannel = {
  readonly manualGate: boolean
  readonly deployTarget: 'prod' | 'dev' | 'none'
}

export type ReleaseWorkflowOptions = {
  readonly name?: string
  readonly workspaceName: string
  readonly workspaceDisplayName?: string

  readonly releasePlanPath?: string // default: 'release/release-plan.json'
  readonly releasePlanPaths: readonly string[] // PR trigger paths
  readonly releaseNotesPath?: string // default: 'release/release-notes.md'

  readonly releaseChannels: Record<string, ReleaseChannel>
  readonly defaultNpmTag?: string

  readonly releaseBranchPrefix?: string // default: 'automation/release-'
  readonly prTitleTemplate?: string // default: 'Prepare ${workspaceDisplayName} ${version} release'
  readonly prBodyTemplate?: string // default covers rationale + handoff
  readonly stagedFiles: readonly string[]

  readonly setupSteps?: readonly WorkflowStep[] // replaces empty default
  readonly extraSetupSteps?: readonly WorkflowStep[] // appended to setupSteps
  readonly preCreatePrSteps?: readonly WorkflowStep[]

  readonly validateSteps: readonly WorkflowStep[]
  readonly publishSteps: readonly WorkflowStep[]
  readonly postPublishSteps?: readonly WorkflowStep[]

  readonly trustedPublishing?: boolean
  readonly sourcePolicyJob?: WorkflowJob | false
  readonly actionlint?: ActionlintConfig | false
  readonly env?: Record<string, string>
  readonly runner?: GitHubWorkflowJob['runs-on']
}
```

## Generated workflow shape

`releaseWorkflow({...})` returns a `githubWorkflow({...})` value with:

### Triggers

- `workflow_dispatch` with two `choice` inputs:
  - `npm_tag` — populated from `Object.keys(releaseChannels)`.
  - `mode` — fixed to `['create-release-pr', 'validate-release-plan',
'publish-release']`.
- `pull_request` on `releasePlanPaths` (validates release tooling
  changes even when they do not carry a real release plan).
- `push` to `main` on `releasePlanPath` (the merge of the release-plan
  PR is the publish trigger).

### Permissions

Workflow-level: `contents: read`, `id-token: write` (for npm OIDC).
Per-job permissions tighten or widen as needed; `create-release-pr` is
the only job that writes contents and pull-requests; `publish-release`
gains `contents: write` so `gh release create` can upload the release
body.

### Jobs

- **`source-policy`** — optional first-party ref policy job (LiveStore
  uses `livestoreDefaultRefPolicyJob`). Omitted when
  `sourcePolicyJob: false`.
- **`create-release-pr`** — runs only on `workflow_dispatch` with
  `mode == create-release-pr`. Checks out `main`, runs `setupSteps`
  - `preCreatePrSteps` (typically: `changeset version` + extract
    release notes), then runs the helper-owned "Open release plan PR"
    step which:
  1. derives the version from `release/release-plan.json`,
  2. force-pushes `automation/release-<version>` with the configured
     `stagedFiles`,
  3. opens or refreshes the PR with the rendered title/body templates,
  4. dispatches the validate workflow,
  5. enables GitHub auto-merge when the channel's `manualGate` is
     `false`.
- **`validate-release-plan`** — runs on `pull_request` (against any of
  `releasePlanPaths`) and on `workflow_dispatch` with
  `mode == validate-release-plan`. Runs `setupSteps`, synthesizes a
  release plan when the PR did not include one, runs `validateSteps`,
  then exports `<WORKSPACE>_RELEASE_VERSION`, `<WORKSPACE>_NPM_TAG`,
  and `<WORKSPACE>_RELEASE_DEPLOY_TARGET` (the deploy target is looked
  up from `releaseChannels[npmTag].deployTarget`).
- **`publish-release`** — runs on `push` to `main` touching
  `releasePlanPath`, and on `workflow_dispatch` with
  `mode == publish-release`. Runs `setupSteps`, reads the release
  plan (same env-export step as above), optionally configures the
  NPM_TOKEN fallback (`trustedPublishing: false`), runs `publishSteps`,
  creates / updates the GitHub Release with
  `--notes-file <releaseNotesPath>`, then runs `postPublishSteps`
  with each step auto-gated on `<WORKSPACE>_RELEASE_DEPLOY_TARGET != 'none'`.

## Migration notes for consumers

The helper assumes the canonical job-id layout and trigger set listed
above. Consumers replacing a hand-written `release.yml.genie.ts`
should:

1. Move bash heredocs from the `create-release-pr` body into
   `stagedFiles`, `releaseBranchPrefix`, and (if needed) custom
   `prTitleTemplate` / `prBodyTemplate` strings.
2. Move the "read release plan + derive deploy target" bash into
   `releaseChannels[*].deployTarget`. The helper writes the env
   exports.
3. Move the GitHub Release creation step into the helper's contract by
   ensuring the repo generates `release/release-notes.md` (default
   path) before `create-release-pr` finishes — typically via a
   `preCreatePrSteps` entry that runs `release:notes:extract`.
4. Keep the heavy Nix / cachix / megarepo / pnpm setup in `setupSteps`
   (effect-utils intentionally does not require
   `standardSelfHostedPnpmCiPrepSteps`). Use `extraSetupSteps` when
   you only want to append a single extra step to the standard
   setup.

## Test surface

`packages/@overeng/genie/src/runtime/github-workflow/release-workflow.unit.test.ts`
exercises the helper directly with a LiveStore-shaped input and asserts:

- the canonical job ids + dispatch input options,
- per-channel auto-merge case branches,
- per-channel deploy-target case branches,
- `gh release create --notes-file` wiring with default and custom
  `releaseNotesPath`,
- template substitution for `prTitleTemplate` / `prBodyTemplate`,
- `trustedPublishing` toggling the NPM_TOKEN fallback,
- `postPublishSteps` gating with both no-op and explicit `if:`
  expressions,
- `extraSetupSteps` ordering and the optional `source-policy` job.

The full `.github/workflows/release.yml` comparison stays in the
consumer's own test surface because the exact text depends on the
consumer's `setupSteps` / `validateSteps` / `publishSteps`.
