import { describe, expect, it } from 'vitest'

import { githubWorkflow, type GenieContext, type GitHubWorkflowArgs } from '../mod.ts'

const mockGenieContext: GenieContext = {
  location: '.github/workflows/ci.yml',
  cwd: '/workspace',
}

const getValidationIssues = (runsOn: unknown) =>
  githubWorkflow({
    name: 'CI',
    on: {
      pull_request: { branches: ['main'] },
    },
    jobs: {
      test: {
        'runs-on': runsOn as any,
        steps: [{ run: 'echo ok' }],
      },
    },
  }).validate?.(mockGenieContext) ?? []

const getWorkflowValidationIssues = (args: GitHubWorkflowArgs) =>
  githubWorkflow(args).validate?.(mockGenieContext) ?? []

describe('githubWorkflow', () => {
  it('accepts valid string runner labels', () => {
    expect(getValidationIssues(['ubuntu-latest', 'nix'])).toEqual([])
  })

  it('rejects empty runs-on arrays', () => {
    expect(getValidationIssues([])).toContainEqual({
      severity: 'error',
      packageName: '.github/workflows/ci.yml',
      dependency: 'jobs.test.runs-on',
      message: 'jobs.test.runs-on must include at least one runner label.',
      rule: 'github-workflow-runs-on-empty',
    })
  })

  it('rejects non-string runner labels', () => {
    expect(getValidationIssues([null])).toContainEqual({
      severity: 'error',
      packageName: '.github/workflows/ci.yml',
      dependency: 'jobs.test.runs-on[0]',
      message: 'jobs.test.runs-on must serialize to string labels, got null.',
      rule: 'github-workflow-runs-on-non-string',
    })
  })

  it('rejects empty runner labels', () => {
    expect(getValidationIssues(['  '])).toContainEqual({
      severity: 'error',
      packageName: '.github/workflows/ci.yml',
      dependency: 'jobs.test.runs-on[0]',
      message: 'jobs.test.runs-on labels must not be empty.',
      rule: 'github-workflow-runs-on-empty-label',
    })
  })

  it('rejects placeholder runner labels', () => {
    expect(getValidationIssues(['namespace-features:github.run-id=undefined'])).toContainEqual({
      severity: 'error',
      packageName: '.github/workflows/ci.yml',
      dependency: 'jobs.test.runs-on[0]',
      message:
        'jobs.test.runs-on contains a stale placeholder label (namespace-features:github.run-id=undefined). This usually means a CI helper API drifted and serialized undefined/null into the workflow.',
      rule: 'github-workflow-runs-on-placeholder',
    })
  })
})

describe('determinate-nix-action extra-conf validation', () => {
  it('no warning when determinate-nix-action has experimental-features in extra-conf', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            {
              uses: 'DeterminateSystems/determinate-nix-action@v3',
              with: { 'extra-conf': 'experimental-features = nix-command flakes' },
            },
            { run: 'nix build' },
          ],
        },
      },
    })

    expect(issues.filter((i) => i.rule === 'github-workflow-determinate-nix-extra-conf')).toEqual(
      [],
    )
  })

  it('warns when determinate-nix-action is missing experimental-features in extra-conf', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            {
              uses: 'DeterminateSystems/determinate-nix-action@v3',
              with: { 'extra-conf': 'some-other-setting = true' },
            },
            { run: 'nix build' },
          ],
        },
      },
    })

    expect(issues).toContainEqual({
      severity: 'warning',
      packageName: '.github/workflows/ci.yml',
      dependency: 'jobs.build.steps[0]',
      message: expect.stringContaining(
        'uses DeterminateSystems/determinate-nix-action without "experimental-features" in extra-conf',
      ),
      rule: 'github-workflow-determinate-nix-extra-conf',
    })
  })

  it('no warning when workflow does not use determinate-nix-action', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: 'actions/checkout@v4' }, { run: 'npm test' }],
        },
      },
    })

    expect(issues.filter((i) => i.rule === 'github-workflow-determinate-nix-extra-conf')).toEqual(
      [],
    )
  })
})
