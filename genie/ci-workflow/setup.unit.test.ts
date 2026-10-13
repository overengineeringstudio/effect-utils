import { describe, expect, it } from 'bun:test'

import { Glob } from 'bun'

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
    expect(linuxSandboxPrerequisitesStep.env.BUCK2_TS_PRIVILEGE_ALLOWED).toBe(
      `\${{ ${namespacePrivilegeTrustedPredicate} }}`,
    )
    const script = linuxSandboxPrerequisitesStep.run
    expect(script).toContain('untrusted pull_request runs on an unprivileged Namespace runner')
    expect(script.indexOf('exit 1')).toBeLessThan(script.indexOf('nix config show'))
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
