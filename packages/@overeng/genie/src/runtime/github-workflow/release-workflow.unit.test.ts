/**
 * Structural tests for the shared `releaseWorkflow` helper in
 * `genie/ci-workflow/release.ts`.
 *
 * The helper is the consumer-facing seam for the Changesets-based
 * supervised release flow; downstream repos like LiveStore (and future
 * molty / openclaw) call it directly. These tests read the helper's source
 * (`readFileSync`-style, the same pattern as `ci-workflow-helpers.unit.test.ts`)
 * so they can run inside the `@overeng/genie` package's `rootDir` while still
 * asserting structural invariants on the cross-package source. Behavioral
 * end-to-end coverage of the rendered `release.yml` lives in the consumer's
 * own test surface, where the consumer's `setupSteps` / `validateSteps` /
 * `publishSteps` are concrete.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const releaseSource = readFileSync(
  new URL('../../../../../../genie/ci-workflow/release.ts', import.meta.url),
  'utf8',
)
const releaseDocSource = readFileSync(
  new URL('../../../../../../context/workflows/release-workflow.md', import.meta.url),
  'utf8',
)

describe('releaseWorkflow input shape', () => {
  it('extends ReleaseChannel with deployTarget for prod/dev/none', () => {
    expect(releaseSource).toContain('export type ReleaseChannel = {')
    expect(releaseSource).toContain('readonly manualGate: boolean')
    expect(releaseSource).toContain("readonly deployTarget: 'prod' | 'dev' | 'none'")
  })

  it('adds typed inputs for the create-release-pr body (no consumer-owned bash heredoc)', () => {
    expect(releaseSource).toContain('readonly stagedFiles: readonly string[]')
    expect(releaseSource).toContain('readonly releaseBranchPrefix?: string')
    expect(releaseSource).toContain('readonly prTitleTemplate?: string')
    expect(releaseSource).toContain('readonly prBodyTemplate?: string')
    expect(releaseSource).toContain('readonly releaseNotesPath?: string')
  })

  it('keeps setupSteps as a fully-replacing default and extraSetupSteps as additive', () => {
    expect(releaseSource).toContain('readonly setupSteps?: readonly WorkflowStep[]')
    expect(releaseSource).toContain('readonly extraSetupSteps?: readonly WorkflowStep[]')
  })

  it('separates per-channel postPublishSteps via deployTarget gating', () => {
    expect(releaseSource).toContain('readonly postPublishSteps?: readonly WorkflowStep[]')
    expect(releaseSource).toContain('gateStepByDeployTarget')
  })
})

describe('releaseWorkflow generated workflow shape', () => {
  it('emits the canonical job ids', () => {
    expect(releaseSource).toContain("jobs['create-release-pr']")
    expect(releaseSource).toContain("jobs['validate-release-plan']")
    expect(releaseSource).toContain("jobs['publish-release']")
  })

  it('drives the npm_tag dispatch choices from releaseChannels keys', () => {
    expect(releaseSource).toContain('options: npmTagOptions')
    expect(releaseSource).toContain('Object.keys(opts.releaseChannels)')
  })

  it('exports workspace-prefixed release env vars', () => {
    expect(releaseSource).toContain('const versionEnv = `${envPrefix}_RELEASE_VERSION`')
    expect(releaseSource).toContain('const npmTagEnv = `${envPrefix}_NPM_TAG`')
    expect(releaseSource).toContain('const deployTargetEnv = `${envPrefix}_RELEASE_DEPLOY_TARGET`')
  })

  it('renders per-channel auto-merge case branches in the open-pr step', () => {
    expect(releaseSource).toContain('autoMergeCaseBranches')
    expect(releaseSource).toContain("manualGate === true ? 'manual' : 'auto'")
    expect(releaseSource).toContain('gh pr merge "$branch"')
    expect(releaseSource).toContain('--auto --merge')
  })

  it('renders per-channel deploy-target case branches for the read-plan step', () => {
    expect(releaseSource).toContain('deployTargetCaseBranches')
    expect(releaseSource).toContain('deploy_target=${channel.deployTarget}')
    expect(releaseSource).toContain('echo "${deployTargetEnv}=$deploy_target" >> "$GITHUB_ENV"')
  })

  it('creates / refreshes a GitHub Release with --notes-file', () => {
    expect(releaseSource).toContain('createGitHubReleaseStep')
    expect(releaseSource).toContain('gh release create')
    expect(releaseSource).toContain('gh release edit')
    expect(releaseSource).toContain('--notes-file')
    expect(releaseSource).toContain("opts.releaseNotesPath ?? 'release/release-notes.md'")
  })

  it('toggles the NPM_TOKEN fallback off when trustedPublishing is true', () => {
    expect(releaseSource).toContain('opts.trustedPublishing === true ? [] : [npmTokenFallbackStep]')
    expect(releaseSource).toContain(
      "opts.trustedPublishing === true ? {} : { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' }",
    )
  })

  it('keeps the create-release-pr job on ubuntu-latest (needs only git + gh)', () => {
    expect(releaseSource).toContain("'runs-on': 'ubuntu-latest'")
  })

  it('preserves consumer if: when wrapping postPublishSteps with the deploy-target gate', () => {
    expect(releaseSource).toContain('gateStepByDeployTarget')
    expect(releaseSource).toContain('`(${existing}) && (${gate})`')
  })

  it('skips the leading checkout in setupSteps for create-release-pr (already checked out main)', () => {
    expect(releaseSource).toContain('setupStepsStartsWithCheckout')
    expect(releaseSource).toContain("uses.startsWith('actions/checkout@')")
  })

  it('renders ${workspaceDisplayName} / ${version} into the PR templates with simple substitution', () => {
    expect(releaseSource).toContain('renderTemplate')
    expect(releaseSource).toContain("replaceAll('${workspaceDisplayName}', workspaceDisplayName)")
    expect(releaseSource).toContain("replaceAll('${version}', version)")
  })

  it('validates inputs upfront', () => {
    expect(releaseSource).toContain('at least one releaseChannels entry is required')
    expect(releaseSource).toContain("defaultNpmTag '${defaultNpmTag}' is not present")
    expect(releaseSource).toContain('stagedFiles must include at least the release plan path')
  })
})

describe('release-workflow design doc', () => {
  it('declares the helper adoption-ready (no longer skeleton-only)', () => {
    expect(releaseDocSource).toMatch(/Status:\s*\*\*adoption-ready/)
    expect(releaseDocSource).not.toMatch(/Status:\s*\*\*draft \/ skeleton/)
  })

  it('documents the new deployTarget channel field', () => {
    expect(releaseDocSource).toContain("readonly deployTarget: 'prod' | 'dev' | 'none'")
  })

  it('documents stagedFiles + releaseNotesPath in the input shape', () => {
    expect(releaseDocSource).toContain('readonly stagedFiles: readonly string[]')
    expect(releaseDocSource).toContain('readonly releaseNotesPath?: string')
  })

  it('documents the migration notes for consumers', () => {
    expect(releaseDocSource).toContain('## Migration notes for consumers')
  })
})
