# Release Workflow Helper (`releaseWorkflow`)

Status: **draft / skeleton in `genie/ci-workflow/release.ts`**.

This document captures the intended shape of a shared
`releaseWorkflow({...})` helper that codifies the Changesets-based
supervised release flow LiveStore just shipped, so other megarepo
members (`molty`, `openclaw`, …) can adopt the same structure via config
instead of copying `release.yml.genie.ts` wholesale.

The reference implementation it abstracts from is
`livestorejs/livestore:.github/workflows/release.yml.genie.ts` plus the
human-readable description at
`livestorejs/livestore:contributor-docs/release-workflows.md`. See
`Refs livestorejs/livestore#1269` for the immediate motivation (the
stable-release auto-merge gate).

## Goals

- One `releaseWorkflow({...})` call per repo produces a complete
  `.github/workflows/release.yml`.
- Same job ids and `if` conditions across consumers so operators can
  navigate any repo's release workflow without re-learning the layout.
- Per-npm-tag policy is config, not branching code. In particular the
  stable-vs-prerelease auto-merge distinction is one boolean per tag.
- Repo-specific work (publish task names, devtools repack, prod docs
  deploy, search sync, …) plugs in as `validateSteps` / `publishSteps`.
  The helper does not try to model those directly.

## Non-goals

The first iteration intentionally does **not** cover:

- Snapshot releases. Those have a separate workflow and lifecycle
  (per-commit, `0.0.0-snapshot-<sha>`, no release plan) and do not
  benefit from the supervised release-plan PR shape.
- Devtools-style artifact repackaging. This is LiveStore-specific
  glue; repos that need it pass extra steps into `validateSteps` /
  `publishSteps`.
- Docs / examples deploy and search-index sync. Same reasoning —
  these are repo-specific post-publish hooks.
- `release/version.json` / `release/devtools-artifact.json`
  generation. LiveStore's release PR generator stages those files
  before opening the PR. The skeleton names only the canonical
  `release/release-plan.json` location and leaves the broader staged
  file set to the repo (probably via a follow-up `stagedFiles` option).
- A migration of LiveStore's own `release.yml.genie.ts` to consume the
  helper. The intention is to land the skeleton, iterate on the
  interface against a second adopter (molty or openclaw), and only
  then migrate LiveStore so we get one round of real-world feedback
  on the API before committing to it.

## Input shape

```ts
import { releaseWorkflow } from '<effect-utils>/genie/ci-workflow.ts'

export default releaseWorkflow({
  workspaceName: 'livestore',
  workspaceDisplayName: 'LiveStore',

  releasePlanPath: 'release/release-plan.json',
  releasePlanPaths: [
    '.github/workflows/release.yml',
    '.github/workflows/release.yml.genie.ts',
    'genie/repo.ts',
    'release/release-plan.json',
    'release/version.json',
    'release/devtools-artifact.json',
    'scripts/src/commands/release.ts',
    'scripts/src/commands/changesets.ts',
  ],

  // Per-npm-tag policy. `manualGate: true` keeps the release-plan PR
  // human-merged. `manualGate: false` enables GitHub auto-merge for
  // dev / prerelease PRs.
  releaseChannels: {
    latest: { manualGate: true },
    dev: { manualGate: false },
    next: { manualGate: false },
  },
  defaultNpmTag: 'latest',

  // Per-job setup (devenv, nix cache, pnpm install, ...). The helper
  // does not assume a particular CI prep contract; pass whatever the
  // repo uses for the rest of its workflows. For LiveStore today this
  // is `livestoreSetupSteps`.
  setupSteps: livestoreSetupSteps,

  // Dry-run + repack-dryrun substance for the release-plan PR.
  validateSteps: [
    devenvTaskStep('Dry-run stable package publish', 'release:stable:dryrun'),
    devenvTaskStep(
      'Repack DevTools artifact (dryrun)',
      'release:devtools-artifact:repack-dryrun:no-install',
    ),
  ],

  // Publish substance after the release-plan PR merges to main.
  publishSteps: [
    devenvTaskStep('Publish stable package release', 'release:stable:publish'),
    devenvTaskStep(
      'Publish DevTools artifact release',
      'release:devtools-artifact:publish:no-install',
    ),
    // ...optional prod docs deploy, search sync, etc. — repo-specific.
  ],

  trustedPublishing: true, // OIDC, no NPM_TOKEN
  sourcePolicyJob: livestoreDefaultRefPolicyJob,
})
```

The full TypeScript type is at `genie/ci-workflow/release.ts`:

```ts
export type ReleaseChannel = {
  readonly manualGate: boolean
}

export type ReleaseWorkflowOptions = {
  readonly name?: string
  readonly workspaceName: string
  readonly workspaceDisplayName?: string
  readonly releasePlanPath?: string
  readonly releasePlanPaths: readonly string[]
  readonly releaseChannels: Record<string, ReleaseChannel>
  readonly defaultNpmTag?: string
  readonly setupSteps: readonly WorkflowStep[]
  readonly validateSteps: readonly WorkflowStep[]
  readonly publishSteps: readonly WorkflowStep[]
  readonly trustedPublishing?: boolean
  readonly sourcePolicyJob?: WorkflowJob | false
  readonly actionlint?: ActionlintConfig | false
  readonly env?: Record<string, string>
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
the only job that writes contents and pull-requests.

### Jobs

- `source-policy` — optional first-party ref policy job (LiveStore
  uses `livestoreDefaultRefPolicyJob`). Omitted when
  `sourcePolicyJob: false`.
- `create-release-pr` — runs only on `workflow_dispatch` with
  `mode == create-release-pr`. Runs `setupSteps`, generates the
  release plan from Changesets, opens or refreshes the
  `automation/release-<version>` branch + PR, dispatches the
  `validate-release-plan` workflow against the branch, and (per
  channel) either enables GitHub auto-merge (prerelease) or leaves
  the PR for a human reviewer (stable). The stable manual-gate is the
  behaviour introduced by livestorejs/livestore#1269.
- `validate-release-plan` — runs on `pull_request` (against any of
  `releasePlanPaths`) and on `workflow_dispatch` with
  `mode == validate-release-plan`. Runs `setupSteps`, synthesizes a
  release plan when the PR did not include one, then runs
  `validateSteps`.
- `publish-release` — runs on `push` to `main` touching
  `releasePlanPath`, and on `workflow_dispatch` with
  `mode == publish-release`. Runs `setupSteps`, reads the release
  plan, (optionally) configures the npm token fallback, then runs
  `publishSteps`.

## What the skeleton does today

`genie/ci-workflow/release.ts` returns a workflow with the correct
triggers, permissions, env, and job ids / `if` conditions, but the job
bodies are placeholders (each substantive step is replaced by an
`echo TODO ... ; exit 1` so a partial migration cannot silently
publish). The next iteration replaces those placeholders with the real
step sequence from the LiveStore reference workflow, factored against
the option surface above.

## Open questions

The following choices still want a human review before the helper goes
beyond skeleton:

1. **Granularity of `releaseChannels`.** Today every channel is just
   `{ manualGate: boolean }`. The LiveStore reference workflow also
   varies the deploy target (`prod` vs `dev`) per channel. Should the
   channel record carry that, or should it stay opaque and live in
   `publishSteps` per repo?
2. **`setupSteps` vs structured prep.** `setupSteps` is currently a
   flat `readonly WorkflowStep[]`, which means each repo can stay on
   its existing setup helper. An alternative is to require
   `standardSelfHostedPnpmCiPrepSteps(...)` and surface its options
   instead, which would unify the four jobs but tie the helper to one
   specific CI prep contract.
3. **Release PR shell ownership.** The `create-release-pr` body is a
   ~60-line bash script today (branch fork, `gh pr edit`/`create`,
   workflow dispatch, auto-merge toggle). The skeleton keeps it as
   one step in the helper. Alternatives: split into named composite
   actions, or have the helper render the shell from typed inputs
   (workspace name, branch prefix, etc.) so repos cannot accidentally
   diverge on the PR body markup.

## Worked example: LiveStore

The shape above is the LiveStore release workflow re-expressed in the
helper's vocabulary. The full migration is intentionally out of scope
for the first PR — once the inputs above are signed off, the
follow-up replaces the placeholder job bodies, then LiveStore swaps
its hand-written `release.yml.genie.ts` for a `releaseWorkflow({...})`
call and the diff should be a near-pure deletion.
