import { describe, expect, it } from 'vitest'

import { githubWorkflow, type GenieContext } from '../mod.ts'

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
