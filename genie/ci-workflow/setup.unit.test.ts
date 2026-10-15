import { describe, expect, it } from 'bun:test'

import { Glob } from 'bun'

import autoReviewWorkflow from '../../.github/workflows/auto-review.yml.genie.ts'
import ciWorkflow, { empiricalProofJobs } from '../../.github/workflows/ci.yml.genie.ts'
import compiledWorkflow from '../../.github/workflows/compiled-products.yml.genie.ts'
import storybookPlaysWorkflow from '../../.github/workflows/storybook-plays.yml.genie.ts'
import previewBuildWorkflow from '../../.github/workflows/storybook-preview-build.yml.genie.ts'
import previewDeployWorkflow from '../../.github/workflows/storybook-preview-deploy.yml.genie.ts'
import buck2TestAuthority from '../../buck2-test-authority.json' with { type: 'json' }
import {
  linuxSandboxPrerequisitesStep,
  namespacePrivilegeTrustedPredicate,
  namespaceRunner,
} from './setup.ts'
import testPlatforms from './test-platforms.json' with { type: 'json' }

describe('namespaceRunner', () => {
  const linux = 'namespace-profile-linux-x86-64'
  const trustedSuffix = `\${{ (${namespacePrivilegeTrustedPredicate}) && ';container.privileged=true' || '' }}`

  it('keeps priority on the machine label in both label formats', () => {
    expect(
      namespaceRunner({ profile: linux, runId: '42', privileged: 'always', priority: 2 }),
    ).toEqual([`${linux};github.run-id=42;container.privileged=true;job.priority=2`])
    const profile = 'nscloud-ubuntu-24.04-amd64-16x64-with-features'
    expect(namespaceRunner({ profile, runId: '42', privileged: 'always', priority: 3 })).toEqual([
      `${profile};job.priority=3`,
      'namespace-features:github.run-id=42;container.privileged=true',
    ])
  })

  it('preserves expression-valued priorities as an interpolated feature value', () => {
    const priority = "${{ github.event_name == 'merge_group' && 1 || 2 }}"
    for (const profile of [linux, 'nscloud-ubuntu-24.04-amd64-16x64-with-features']) {
      const labels = namespaceRunner({
        profile,
        runId: '${{ github.run_id }}',
        privileged: 'never',
        priority,
      })
      expect(labels[0]).toContain(`;job.priority=${priority}`)
      if (labels.length === 2) {
        expect(labels[1]).toBe('namespace-features:github.run-id=${{ github.run_id }}')
        expect(labels[1]).not.toContain('job.priority')
      }
    }
  })

  it('leaves absent priority byte-identical to the previous labels', () => {
    for (const privileged of ['never', 'always', 'trusted'] as const) {
      const suffix =
        privileged === 'never'
          ? ''
          : privileged === 'always'
            ? ';container.privileged=true'
            : trustedSuffix
      expect(JSON.stringify(namespaceRunner({ profile: linux, runId: '42', privileged }))).toBe(
        JSON.stringify([`${linux};github.run-id=42${suffix}`]),
      )
      const profile = 'nscloud-ubuntu-24.04-amd64-16x64-with-features'
      expect(JSON.stringify(namespaceRunner({ profile, runId: '42', privileged }))).toBe(
        JSON.stringify([profile, `namespace-features:github.run-id=42${suffix}`]),
      )
    }
  })

  it('prioritizes generated merge-group producers and required PR checks', () => {
    expect(ciWorkflow.data.jobs['build-products']!['runs-on']).toEqual([
      `${linux};github.run-id=\${{ github.run_id }};container.privileged=true;job.priority=1`,
    ])
    expect(storybookPlaysWorkflow.data.jobs['test-storybook-plays']!['runs-on']).toEqual([
      `${linux};github.run-id=\${{ github.run_id }};container.privileged=true;job.priority=1`,
    ])
    expect(ciWorkflow.data.jobs.quality!['runs-on']).toEqual([
      `${linux};github.run-id=\${{ github.run_id }}${trustedSuffix};job.priority=1`,
    ])
  })

  it('classifies every Namespace product and empirical job by its delivery result', () => {
    const background = new Set([
      'devenv-perf',
      'nix-closure-sizes',
      'main-source-shape',
      'ci-measurements-report',
      'notify-alignment',
      'pipeline-traces',
    ])
    const jobs = { ...ciWorkflow.data.jobs, ...empiricalProofJobs }
    let namespaceJobs = 0
    for (const [id, job] of Object.entries(jobs)) {
      const labels = JSON.stringify(job['runs-on'])
      if (labels.includes('namespace-profile-') === true || labels.includes('nscloud-') === true) {
        namespaceJobs++
        expect(labels).toContain(`;job.priority=${background.has(id) === true ? 4 : 1}`)
        expect(labels).not.toContain('job.priority=2')
        expect(labels).not.toContain('job.priority=3')
      }
    }
    expect(namespaceJobs).toBeGreaterThan(20)
  })

  it('keeps preview build and publication prerequisites in the delivery tier', () => {
    for (const workflow of [previewBuildWorkflow, previewDeployWorkflow, storybookPlaysWorkflow]) {
      for (const job of Object.values(workflow.data.jobs)) {
        expect(JSON.stringify(job['runs-on'])).toContain(';job.priority=1')
      }
    }
    expect(compiledWorkflow.data.jobs['publish-compiled-products']?.strategy?.matrix).toEqual({
      include: [
        {
          runner: 'namespace-profile-linux-x86-64',
          runnerLabel:
            'namespace-profile-linux-x86-64;github.run-id={0};container.privileged=true;job.priority=1',
        },
        {
          runner: 'namespace-profile-macos-arm64',
          runnerLabel: 'namespace-profile-macos-arm64;github.run-id={0};job.priority=1',
        },
      ],
    })
    expect(JSON.stringify(autoReviewWorkflow.data.jobs['request-review']['runs-on'])).toContain(
      ';job.priority=4',
    )
  })

  it('requires an explicit privilege choice, even when invoked by an untyped generator', () => {
    for (const profile of [linux, 'nscloud-ubuntu-24.04-amd64-16x64-with-features']) {
      expect(() => Reflect.apply(namespaceRunner, undefined, [{ profile, runId: '42' }])).toThrow(
        'namespaceRunner requires explicit privileged: always, trusted or never',
      )
    }
  })

  it('selects never, always and trusted explicitly for Linux', () => {
    expect(namespaceRunner({ profile: linux, runId: '42', privileged: 'never' })).toEqual([
      `${linux};github.run-id=42`,
    ])
    expect(namespaceRunner({ profile: linux, runId: '42', privileged: 'always' })).toEqual([
      `${linux};github.run-id=42;container.privileged=true`,
    ])
    expect(namespaceRunner({ profile: linux, runId: '42', privileged: 'trusted' })).toEqual([
      `${linux};github.run-id=42${trustedSuffix}`,
    ])
  })

  it('isolates the pending fork policy and shares it with TS admission', () => {
    expect(namespacePrivilegeTrustedPredicate).toBe(
      "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
    )
    const step = linuxSandboxPrerequisitesStep({ privileged: 'trusted' })
    expect(step.env.BUCK2_TS_PRIVILEGE_ALLOWED).toBe(
      `\${{ ${namespacePrivilegeTrustedPredicate} }}`,
    )
    const script = step.run
    expect(script).toContain('untrusted pull_request runs on an unprivileged Namespace runner')
    expect(script.indexOf('exit 1')).toBeLessThan(script.indexOf('nix config show'))
  })

  it('does not read PR identity for always or never prerequisite policies', () => {
    for (const privileged of ['always', 'never'] as const) {
      const step = linuxSandboxPrerequisitesStep({ privileged })
      expect(step.env.BUCK2_TS_PRIVILEGE_ALLOWED).toBe(privileged === 'always' ? 'true' : 'false')
      expect(JSON.stringify(step)).not.toContain('github.event.pull_request')
      expect(JSON.stringify(step)).not.toContain('pull_request.head')
    }
  })

  it('keeps the separate features label for -with-features machine labels', () => {
    const profile = 'nscloud-ubuntu-24.04-amd64-16x64-with-features'
    expect(namespaceRunner({ profile, runId: '42', privileged: 'trusted' })).toEqual([
      profile,
      `namespace-features:github.run-id=42${trustedSuffix}`,
    ])
    expect(namespaceRunner({ profile, runId: '42', privileged: 'never' })).toEqual([
      profile,
      'namespace-features:github.run-id=42',
    ])
  })

  it('never privileges Darwin, regardless of the job flag', () => {
    for (const privileged of ['never', 'always', 'trusted'] as const) {
      expect(
        namespaceRunner({ profile: 'namespace-profile-macos-arm64', runId: '42', privileged }),
      ).toEqual(['namespace-profile-macos-arm64;github.run-id=42'])
    }
  })

  it('keeps matrix profiles dynamic without granting Darwin privilege', () => {
    expect(
      namespaceRunner({
        profile: '${{ matrix.runner }}',
        runId: '${{ github.run_id }}',
        privileged: 'always',
      }),
    ).toEqual([
      "${{ matrix.runner }};github.run-id=${{ github.run_id }}${{ (contains(matrix.runner, 'linux') || startsWith(matrix.runner, 'nscloud-ubuntu-')) && ';container.privileged=true' || '' }}",
    ])
    expect(
      namespaceRunner({
        profile: '${{ matrix.runner }}',
        runId: '${{ github.run_id }}',
        privileged: 'trusted',
      }),
    ).toEqual([
      `\${{ matrix.runner }};github.run-id=\${{ github.run_id }}\${{ (contains(matrix.runner, 'linux') || startsWith(matrix.runner, 'nscloud-ubuntu-')) && (${namespacePrivilegeTrustedPredicate}) && ';container.privileged=true' || '' }}`,
    ])
  })
})

describe('required platform test classification', () => {
  it('classifies every aggregate source task exactly once with a rationale', () => {
    const suites = [...testPlatforms.darwin, ...testPlatforms.neutral]
    const tasks = suites.map(({ task }) => task)
    const aggregateTasks = [
      'test:buck2:unit',
      'test:run',
      'devenv-modules:test',
      'genie:buck2:test',
      'genie:ci-workflow:test',
      'buck2:rust:generators:test',
      'test:buck2-tools',
      ...buck2TestAuthority.lanes.flatMap((lane) =>
        'unboundedTaskName' in lane ? [lane.unboundedTaskName] : [],
      ),
    ]
    expect(tasks.toSorted()).toEqual(aggregateTasks.toSorted())
    expect(new Set(tasks).size).toBe(tasks.length)
    expect(suites.every(({ rationale }) => rationale.trim().length > 0)).toBe(true)
    expect(testPlatforms.darwin.map(({ task }) => task)).toContain('test:buck2:unit')
    expect(testPlatforms.darwin.map(({ task }) => task)).toContain('test:run')
    expect(testPlatforms.neutral.map(({ task }) => task)).toContain('buck2:rust:generators:test')
    for (const task of [
      'test:ci-tools:unbounded',
      'test:notion-cli:unbounded',
      'test:ci-tools:test_pipeline_report_local_api:unbounded',
      'test:tui-stories:unbounded',
      'test:otel-contract:unbounded',
    ]) {
      expect(testPlatforms.neutral.map(({ task }) => task)).toContain(task)
    }
  })

  it('classifies every bounded lane exactly once, independently of its source complement', () => {
    const suites = [...testPlatforms.bounded.darwin, ...testPlatforms.bounded.neutral]
    const tasks = suites.map(({ task }) => task)
    expect(tasks.toSorted()).toEqual(
      buck2TestAuthority.lanes.map(({ taskName }) => taskName).toSorted(),
    )
    expect(new Set(tasks).size).toBe(tasks.length)
    expect(suites.every(({ rationale }) => rationale.trim().length > 0)).toBe(true)
    expect(testPlatforms.bounded.darwin.map(({ task }) => task)).toContain('test:effect-iroh')
    expect(testPlatforms.bounded.neutral.map(({ task }) => task)).toContain('test:pty-effect')
    expect(testPlatforms.darwin.map(({ task }) => task)).toContain('test:pty-effect:unbounded')
  })

  it('classifies every discovered module script exactly once, retaining neutral coverage on Linux', () => {
    const suites = [...testPlatforms.moduleScripts.darwin, ...testPlatforms.moduleScripts.neutral]
    const scripts = suites.map(({ script }) => script)
    const discovered = [
      ...new Glob('*.test.sh').scanSync({
        cwd: `${import.meta.dir}/../../nix/devenv-modules/tasks/shared/tests`,
        onlyFiles: true,
      }),
    ]
    expect(scripts.toSorted()).toEqual(discovered.toSorted())
    expect(new Set(scripts).size).toBe(scripts.length)
    expect(suites.every(({ rationale }) => rationale.trim().length > 0)).toBe(true)
    expect(testPlatforms.moduleScripts.neutral.map(({ script }) => script)).toContain(
      'pnpm-task-smoke.test.sh',
    )
    expect(testPlatforms.moduleScripts.darwin.map(({ script }) => script)).toContain(
      'buck2-capability-publish.test.sh',
    )
  })
})
