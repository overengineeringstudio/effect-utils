import { describe, expect, it } from 'vitest'

import { githubWorkflow, type GenieContext, type GitHubWorkflowArgs } from '../mod.ts'

const mockGenieContext: GenieContext = {
  location: '.github/workflows/ci.yml',
  cwd: '/workspace',
}

/** Helper that only checks the built-in TS validators (actionlint disabled) */
const getValidationIssues = (runsOn: unknown) =>
  githubWorkflow({
    actionlint: false,
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

/** Helper that only checks the built-in TS validators (actionlint disabled) */
const getWorkflowValidationIssues = (args: GitHubWorkflowArgs) =>
  githubWorkflow({ actionlint: false, ...args }).validate?.(mockGenieContext) ?? []

/** Helper that includes actionlint validation */
const getFullValidationIssues = (args: GitHubWorkflowArgs) =>
  githubWorkflow(args).validate?.(mockGenieContext) ?? []

const hasActionlint = (() => {
  try {
    const bin = process.env.GENIE_ACTIONLINT_BIN
    return bin !== undefined && bin !== ''
  } catch {
    return false
  }
})()

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

describe('GitHub expression validation', () => {
  it('rejects nested GitHub expressions inside a single expression string', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            {
              name: 'Save pnpm store',
              uses: 'actions/cache/save@v4',
              with: {
                key: "${{ steps.restore.outputs.cache-primary-key || 'pnpm-store-${{ runner.os }}' }}",
                path: '/tmp/pnpm-store',
              },
            },
          ],
        },
      },
    })

    expect(issues).toContainEqual({
      severity: 'error',
      packageName: '.github/workflows/ci.yml',
      dependency: 'jobs.build.steps[0].with.key',
      message: expect.stringContaining('contains a nested GitHub Actions expression'),
      rule: 'github-workflow-expression-nesting',
    })
  })

  it('allows plain strings that concatenate multiple top-level GitHub expressions', () => {
    const issues = getWorkflowValidationIssues({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            {
              name: 'Restore pnpm store',
              uses: 'actions/cache/restore@v4',
              with: {
                key: "pnpm-store-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('**/pnpm-lock.yaml') }}",
                path: '/tmp/pnpm-store',
              },
            },
          ],
        },
      },
    })

    expect(issues.filter((i) => i.rule === 'github-workflow-expression-nesting')).toEqual([])
  })

  it('stringifies valid cache keys with multiple top-level expressions unchanged', () => {
    const workflow = githubWorkflow({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            {
              name: 'Restore pnpm store',
              uses: 'actions/cache/restore@v4',
              with: {
                key: "pnpm-store-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('**/pnpm-lock.yaml') }}",
                path: '${{ runner.temp }}/pnpm-store/${{ github.job }}',
              },
            },
          ],
        },
      },
    })

    const yaml = workflow.stringify(mockGenieContext)

    expect(yaml).toContain(
      `key: "pnpm-store-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles('**/pnpm-lock.yaml') }}"`,
    )
    expect(yaml).toContain(`path: '\${{ runner.temp }}/pnpm-store/\${{ github.job }}'`)
  })
})

describe.runIf(hasActionlint)('actionlint integration', () => {
  it('passes a clean workflow', () => {
    const issues = getFullValidationIssues({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: 'actions/checkout@v4' }, { run: 'echo hello' }],
        },
      },
    })

    expect(issues.filter((i) => i.rule.startsWith('actionlint-'))).toEqual([])
  })

  it('catches script injection via untrusted input in run step', () => {
    const issues = getFullValidationIssues({
      name: 'CI',
      on: { pull_request: null },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ run: 'echo ${{ github.event.pull_request.title }}' }],
        },
      },
    })

    const actionlintErrors = issues.filter(
      (i) => i.rule.startsWith('actionlint-') && i.severity === 'error',
    )
    expect(actionlintErrors.length).toBeGreaterThan(0)
    expect(actionlintErrors[0]!.message).toContain('untrusted')
  })

  it('accepts custom self-hosted runner labels via config', () => {
    const issues = getFullValidationIssues({
      actionlint: { selfHostedRunnerLabels: ['my-custom-runner', 'nix'] },
      name: 'CI',
      on: { push: null },
      jobs: {
        build: {
          'runs-on': ['my-custom-runner', 'nix'],
          steps: [{ run: 'echo hello' }],
        },
      },
    })

    expect(issues.filter((i) => i.rule === 'actionlint-runner-label')).toEqual([])
  })

  it('reports unknown runner labels without config', () => {
    const issues = getFullValidationIssues({
      name: 'CI',
      on: { push: null },
      jobs: {
        build: {
          'runs-on': ['my-unknown-runner'],
          steps: [{ run: 'echo hello' }],
        },
      },
    })

    expect(issues.filter((i) => i.rule === 'actionlint-runner-label').length).toBeGreaterThan(0)
  })

  it('can be disabled with actionlint: false', () => {
    const issues = getFullValidationIssues({
      actionlint: false,
      name: 'CI',
      on: { pull_request: null },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ run: 'echo ${{ github.event.pull_request.title }}' }],
        },
      },
    })

    expect(issues.filter((i) => i.rule.startsWith('actionlint-'))).toEqual([])
  })

  it('strips actionlint config from generated YAML', () => {
    const workflow = githubWorkflow({
      actionlint: { selfHostedRunnerLabels: ['my-runner'] },
      name: 'CI',
      on: { push: null },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ run: 'echo hello' }],
        },
      },
    })

    const yaml = workflow.stringify(mockGenieContext)
    expect(yaml).not.toContain('actionlint')
    expect(yaml).not.toContain('selfHostedRunnerLabels')
  })
})
