import { describe, expect, it } from 'bun:test'

import { Glob } from 'bun'

import repositoryCiWorkflow from '../../.github/workflows/ci.yml.genie.ts'
import buck2TestAuthority from '../../buck2-test-authority.json' with { type: 'json' }
import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { pipelineCloseJob } from './pipeline-telemetry.ts'
import {
  ciWorkflow,
  linuxNixSandboxFallbackConf,
  linuxNixSandboxFallbackStep,
} from './shared.ts'
import {
  installNixStep,
  linuxSandboxPrerequisitesStep,
  namespacePrivilegeTrustedPredicate,
  namespaceRunner,
} from './setup.ts'
import testPlatforms from './test-platforms.json' with { type: 'json' }

describe('namespaceRunner', () => {
  const linux = 'namespace-profile-linux-x86-64'
  const trustedSuffix = `\${{ (${namespacePrivilegeTrustedPredicate}) && ';container.privileged=true' || '' }}`

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

  it('denies fork PR admission but admits same-repository PRs and non-PR jobs', () => {
    const allowed = new Function('github', `return (${namespacePrivilegeTrustedPredicate})`)
    const repository = 'overengineeringstudio/effect-utils'
    for (const [headRepository, expected] of [
      [repository, true],
      ['external-contributor/effect-utils', false],
    ] as const) {
      expect(
        allowed({
          event_name: 'pull_request',
          repository,
          event: { pull_request: { head: { repo: { full_name: headRepository } } } },
        }),
      ).toBe(expected)
    }
    for (const event_name of ['push', 'merge_group', 'workflow_dispatch', 'workflow_run']) {
      expect(allowed({ event_name, repository, event: {} })).toBe(true)
    }
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

describe('Linux Nix sandbox fallback', () => {
  it('configures fresh installers only on Linux', () => {
    expect(linuxNixSandboxFallbackConf).toBe(
      [
        "${{ runner.os == 'Linux' && 'sandbox = true' || '' }}",
        "${{ runner.os == 'Linux' && 'sandbox-fallback = false' || '' }}",
      ].join('\n'),
    )
    expect(installNixStep().with['extra-conf']).toContain(linuxNixSandboxFallbackConf)
    const hostedInstall = pipelineCloseJob({}).steps.find(
      (step) => step.uses === 'cachix/install-nix-action@v31',
    )
    expect(hostedInstall?.with?.extra_nix_config).toBe(linuxNixSandboxFallbackConf)
  })

  it('configures Linux before any command, preserves inherited config, and skips macOS', () => {
    const macConfig = 'keep-derivations = true'
    const rendered = ciWorkflow({
      trustTier: 'public',
      on: { push: { branches: ['main'] } },
      jobs: {
        linux: { 'runs-on': 'ubuntu-latest', steps: [{ run: 'nix build .#product' }] },
        macos: {
          'runs-on': 'macos-14',
          env: { NIX_CONFIG: macConfig },
          steps: [{ run: 'nix build .#product' }],
        },
        matrix: {
          'runs-on': '${{ matrix.runner }}',
          strategy: { matrix: { runner: ['ubuntu-latest', 'macos-14'] } },
          steps: [{ run: 'nix build .#product' }],
        },
      },
    }).data
    for (const job of Object.values(rendered.jobs)) {
      expect(job.steps[0]).toEqual(linuxNixSandboxFallbackStep)
      expect(job.steps[0]?.if).toBe("${{ runner.os == 'Linux' }}")
    }
    expect(rendered.jobs.macos?.env?.NIX_CONFIG).toBe(macConfig)
    expect(linuxNixSandboxFallbackStep.run).toContain('"${NIX_CONFIG:-}"')
    expect(linuxNixSandboxFallbackStep.run).toContain(
      'sandbox = true\\nsandbox-fallback = false',
    )
    expect(linuxNixSandboxFallbackStep.run).toContain('sandbox-fallback = false')
    const recomposed = ciWorkflow({
      trustTier: 'public',
      on: { push: { branches: ['main'] } },
      jobs: rendered.jobs,
    }).data
    for (const job of Object.values(recomposed.jobs)) {
      expect(job.steps.filter((step) => step.id === linuxNixSandboxFallbackStep.id)).toHaveLength(1)
    }
  })

  it('covers every generated job, including hosted, API-only, and mixed-platform jobs', async () => {
    const cwd = `${import.meta.dir}/../../.github/workflows`
    const paths = [...new Glob('*.yml').scanSync({ cwd, onlyFiles: true })]
    expect(paths.length).toBeGreaterThan(0)
    let linuxJobs = 0
    let macosJobs = 0
    for (const path of paths) {
      const workflow: Pick<GitHubWorkflowArgs, 'jobs'> = Bun.YAML.parse(
        await Bun.file(`${cwd}/${path}`).text(),
      )
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        const first = job.steps[0]
        expect(first?.id, `${path}/${jobId}`).toBe(linuxNixSandboxFallbackStep.id)
        expect(first?.if, `${path}/${jobId}`).toBe("${{ runner.os == 'Linux' }}")
        expect(first?.run, `${path}/${jobId}`).toContain('sandbox-fallback = false')
        expect(job.steps.filter((step) => step.id === linuxNixSandboxFallbackStep.id)).toHaveLength(1)
        const labels = [job['runs-on']].flat().join(';')
        if (/linux|ubuntu/.test(labels)) linuxJobs++
        if (/macos|darwin/.test(labels)) macosJobs++
      }
    }
    expect(linuxJobs).toBeGreaterThan(0)
    expect(macosJobs).toBeGreaterThan(0)
  })

  it('refuses fork PR tool realization and uses only declared pinned Node in source-only jobs', () => {
    const jobs = repositoryCiWorkflow.data.jobs
    for (const [jobId, commandName] of [
      ['default-ref-policy', 'Check first-party default refs'],
      ['source-shape', 'Measure source shape: effect-utils'],
    ] as const) {
      const job = jobs[jobId]!
      const guardIndex = job.steps.findIndex(
        (step) => step.name === 'Log Linux sandbox prerequisites',
      )
      const commandIndex = job.steps.findIndex((step) => step.name === commandName)
      expect(guardIndex, jobId).toBeGreaterThan(-1)
      expect(commandIndex, jobId).toBeGreaterThan(guardIndex)
      expect(job.steps[guardIndex]?.env?.BUCK2_TS_PRIVILEGE_ALLOWED).toBe(
        `\${{ ${namespacePrivilegeTrustedPredicate} }}`,
      )
      expect(job.steps[guardIndex]?.run).toContain('exit 1')
      expect(JSON.stringify(job['runs-on'])).toContain(namespacePrivilegeTrustedPredicate)
      for (const step of job.steps.slice(0, guardIndex)) {
        expect(step.run ?? '', jobId).not.toMatch(/\bnix (?:build|shell|run|develop)\b/)
      }
      const script = job.steps[commandIndex]?.run ?? ''
      expect(script).toContain(
        'node_out="$(nix build --no-update-lock-file --no-link --print-out-paths .#buck2-node)"',
      )
      expect(script).toContain('"$node_out/bin/node" <<')
      expect(script).not.toContain('nixpkgs#')
      expect(script).not.toContain('command -v')
      expect(script).not.toContain('ensure_ci_measurement_tool')
      expect(script).not.toContain('nix shell')
      expect(script).not.toMatch(/(?:^|\n)node\s/)
    }
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
