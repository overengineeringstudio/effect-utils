import { describe, expect, it } from 'bun:test'

import { Glob } from 'bun'

import autoReviewWorkflow from '../../.github/workflows/auto-review.yml.genie.ts'
import ciWorkflow, { empiricalProofJobs } from '../../.github/workflows/ci.yml.genie.ts'
import compiledWorkflow from '../../.github/workflows/compiled-products.yml.genie.ts'
import empiricalWorkflow from '../../.github/workflows/empirical-proofs.yml.genie.ts'
import storybookPlaysWorkflow from '../../.github/workflows/storybook-plays.yml.genie.ts'
import previewBuildWorkflow from '../../.github/workflows/storybook-preview-build.yml.genie.ts'
import previewDeployWorkflow from '../../.github/workflows/storybook-preview-deploy.yml.genie.ts'
import buck2TestAuthority from '../../buck2-test-authority.json' with { type: 'json' }
import {
  pipelineDevenvStepName,
  pipelineIdentityStepName,
} from '../../packages/@overeng/ci-tools/src/pipeline-job-names.ts'
import {
  collectWorkflowPolicyViolations,
  sameRepoPullRequestGuard,
} from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'
import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { defaultRefPolicyCheckStep } from './megarepo.ts'
import { pipelineCloseJob } from './pipeline-telemetry.ts'
import { fleetWorkflowPolicy } from './policy.ts'
import { publishedRefIf } from './published-ref.ts'
import {
  installNixStep,
  linuxSandboxPrerequisitesStep,
  namespaceRunner,
  pnpmInstallWithDiagnosticsStep,
  pnpmStateSetupStep,
  restoreNixCacheStep,
  saveNixCacheStep,
  standardSelfHostedPnpmCiPostSteps,
  standardSelfHostedPnpmCiPrepSteps,
} from './setup.ts'
import {
  buck2CiJobInstanceStep,
  ciPnpmHome,
  ciPnpmStore,
  ciWorkflow as composeCiWorkflow,
  ciJobAdmission,
  defaultRefPolicyVerdictStepId,
  linuxSandboxAdmissionStepId,
  withCiAdmissionCleanup,
  linuxNixSandboxFallbackConf,
  linuxNixSandboxFallbackStep,
  namespacePrivilegeTrustedPredicate,
  withNixRealisationTimeouts,
  withCiSourceRoot,
} from './shared.ts'
import {
  ciWorkflowResolveDevenvScript,
  ciWorkflowNixGcRaceRetryScript,
  preparationDiagnosticSeconds,
} from './support-files.ts'
import testPlatforms from './test-platforms.json' with { type: 'json' }

describe('Resolve devenv hang diagnostics', () => {
  it('streams stderr to the job and a retained repair log', () => {
    expect(ciWorkflowResolveDevenvScript).toContain('exec {build_stderr}> >(tee -a "$log" >&2)')
    expect(ciWorkflowResolveDevenvScript).toContain('2>&"$build_stderr"')
    expect(ciWorkflowResolveDevenvScript).toContain(
      'mktemp "$DIAG_ROOT/resolve-devenv.nix-build.XXXXXX.log"',
    )
    expect(ciWorkflowResolveDevenvScript).toContain('valid( store path)?" "$log"')
    expect(ciWorkflowResolveDevenvScript).not.toContain('rm -f "$log"')
  })

  it('observes before every generated resolution deadline without changing it', () => {
    expect(ciWorkflowNixGcRaceRetryScript).toContain(
      `CI_PREPARATION_DIAGNOSTIC_SECONDS:-${preparationDiagnosticSeconds}`,
    )
    for (const job of Object.values(ciWorkflow.data.jobs)) {
      for (const step of job.steps) {
        if (step.name !== pipelineDevenvStepName || step['timeout-minutes'] === undefined) continue
        const minutes = String(step['timeout-minutes']).match(/\d+/g)!.map(Number)
        expect(preparationDiagnosticSeconds).toBeLessThan(Math.min(...minutes) * 60)
      }
    }
  })

  it('redacts before persisting bounded process and prefetch evidence', () => {
    expect(ciWorkflowNixGcRaceRetryScript).toContain('stream.write(redact("\\n".join(snapshot))')
    expect(ciWorkflowNixGcRaceRetryScript).toContain(
      'token|password|secret|authorization|credential',
    )
    expect(ciWorkflowNixGcRaceRetryScript).toContain('[REDACTED_URL]')
    expect(ciWorkflowNixGcRaceRetryScript).toContain(
      'pid=,ppid=,pgid=,stat=,wchan:32=,etime=,args=',
    )
    expect(ciWorkflowNixGcRaceRetryScript).toContain('"locked-input-prefetch", "*.log"')
  })
})

describe('Nix substitution failure policy', () => {
  it('bounds stalled downloads in every generated shared install step on all platforms', () => {
    for (const definition of [
      ciWorkflow,
      compiledWorkflow,
      empiricalWorkflow,
      storybookPlaysWorkflow,
      previewBuildWorkflow,
      previewDeployWorkflow,
    ]) {
      const workflow: GitHubWorkflowArgs = definition.data
      const installs = Object.values(workflow.jobs).flatMap((job) =>
        job.steps.filter((step) => step.uses === installNixStep().uses),
      )
      expect(installs.length).toBeGreaterThan(0)
      for (const step of installs) {
        const lines = String(step.with?.['extra-conf']).split('\n')
        for (const setting of [
          'connect-timeout = 10',
          'stalled-download-timeout = 60',
          'download-attempts = 3',
        ])
          expect(lines.filter((line) => line === setting)).toHaveLength(1)
      }
    }
  })
})

describe('consumer root contracts', () => {
  it('runs the product contract suite through the Nix fetch retry wrapper', () => {
    const step = ciWorkflow.data.jobs['pr-a-inert-buck']!.steps.find(
      (step) => step.name === 'Check product publisher, manifest import, and from-source contracts',
    )!
    expect(step.run).toContain('run-with-nix-gc-race-retry.sh')
    expect(step.run).toContain('bash "$__genie_ci_retry_script"')
    expect(step.run).toContain('nix/buck2-products/from-source-contract.test.sh')
  })
})

describe('shared-runner Cachix upload boundary', () => {
  it('forbids automatic Cachix uploaders on fleet and potentially shared selectors', () => {
    for (const definition of [
      ciWorkflow,
      compiledWorkflow,
      empiricalWorkflow,
      storybookPlaysWorkflow,
      previewBuildWorkflow,
      previewDeployWorkflow,
      autoReviewWorkflow,
    ]) {
      const workflow: GitHubWorkflowArgs = definition.data
      for (const [id, job] of Object.entries(workflow.jobs)) {
        // Opaque/matrix selectors may select fleet runners: protect them too.
        if (
          [job['runs-on']]
            .flat()
            .every((label) =>
              /^(namespace-profile-|nscloud-|ubuntu-|macos-|windows-)/.test(label),
            ) === true
        )
          continue
        for (const step of job.steps) {
          if (step.uses?.startsWith('cachix/cachix-action@') === true) {
            expect(step.with?.authToken, id).toBeUndefined()
            expect(step.with?.signingKey, id).toBeUndefined()
            expect([true, 'true'], id).toContain(step.with?.skipPush)
          }
          expect(JSON.stringify({ run: step.run, with: step.with }), id).not.toMatch(
            /post-build-hook|cachix\s+(?:watch-store|daemon|authtoken)\b/,
          )
        }
      }
    }
  })

  it('isolates compiled-product push credentials and configuration without installing an action', async () => {
    expect(ciWorkflow.data.jobs).not.toHaveProperty('publish-compile-products')
    const job = compiledWorkflow.data.jobs['publish-compiled-products']!
    const push = job.steps.find(
      (step) => step.name === 'Publish Buck rules, retained shell, native and compiled products',
    )!
    expect(job.env?.CACHIX_AUTH_TOKEN).toBeUndefined()
    expect(push.env?.CACHIX_AUTH_TOKEN).toBe('${{ secrets.CACHIX_AUTH_TOKEN }}')
    expect(push.env?.XDG_CONFIG_HOME).toBe(
      '${{ runner.temp }}/compile-cachix-${{ github.run_id }}-${{ github.run_attempt }}',
    )
    for (const step of job.steps) {
      expect(step.uses ?? '').not.toContain('cachix/cachix-action')
      if (step !== push) expect(step.env?.CACHIX_AUTH_TOKEN).toBeUndefined()
    }
    const cleanup = job.steps.find(
      (step) => step.name === 'Remove isolated compile Cachix configuration',
    )!
    expect(cleanup.if).toContain('always()')
    expect(cleanup.run).toContain('rm -r -- "$config"')
    const script = await Bun.file(
      new URL('../ci-scripts/publish-compile-products.sh', import.meta.url),
    ).text()
    expect(script).toContain('cachix push "$cache" "${compile_paths[@]}"')
    expect(script).not.toMatch(/cachix\s+(?:authtoken|use|watch-store|daemon)\b/)
  })
})

describe('Nix realisation step timeouts', () => {
  it('uses the p95, maximum and noise floor without loosening an existing bound', () => {
    const jobs = withNixRealisationTimeouts(
      {
        setup: {
          'runs-on': 'ubuntu-latest',
          'timeout-minutes': 90,
          steps: [
            { name: 'Substitute', run: 'nix build .#tool' },
            { name: 'Already bounded', run: 'nix build .#tool', 'timeout-minutes': 2 },
            { name: 'Unrelated', run: 'echo done' },
            { name: 'Noise floor', run: 'nix build .#small' },
          ],
        },
      },
      {
        Substitute: { Linux: { p95: 21, max: 150 }, macOS: { p95: 101, max: 110 } },
        'Already bounded': { p95: 100, max: 200 },
        'Noise floor': { p95: 1, max: 2 },
      },
    )
    expect(jobs.setup!['timeout-minutes']).toBe(90)
    expect(jobs.setup!.steps[0]!['timeout-minutes']).toBe("${{ runner.os == 'macOS' && 6 || 5 }}")
    expect(jobs.setup!.steps[1]!['timeout-minutes']).toBe(2)
    expect(jobs.setup!.steps[2]!['timeout-minutes']).toBeUndefined()
    expect(jobs.setup!.steps[3]!['timeout-minutes']).toBe(2)
  })

  it('bounds every product bootstrap on Linux and macOS but leaves consumer policy alone', () => {
    const expected = {
      'Install Nix': "${{ runner.os == 'macOS' && 5 || 2 }}",
      'Provide cachix CLI from nixpkgs': 3,
      'Resolve devenv': "${{ runner.os == 'macOS' && 3 || 6 }}",
      'Prepare source generator dependency views': "${{ runner.os == 'macOS' && 25 || 26 }}",
    }
    for (const [id, job] of Object.entries(ciWorkflow.data.jobs)) {
      if (id === 'consumer-smoke') continue
      for (const step of job.steps) {
        if (step.name !== undefined && Object.hasOwn(expected, step.name) === true) {
          expect(step['timeout-minutes']).toBe(expected[step.name as keyof typeof expected])
        }
      }
    }
    expect(
      ciWorkflow.data.jobs['consumer-smoke']!.steps.find((step) => step.name === 'Resolve devenv')![
        'timeout-minutes'
      ],
    ).toBeUndefined()
    expect(
      ciWorkflow.data.jobs['build-products']!.steps.find(
        (step) => step.name === 'Build every published from-source product',
      )!['timeout-minutes'],
    ).toBe(17)
  })
})

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
      'test-megarepo-cold-gc',
      'bootstrap-cold-proof',
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

  it('keeps optional previews background and published products delivery', () => {
    for (const workflow of [previewBuildWorkflow, previewDeployWorkflow]) {
      for (const job of Object.values(workflow.data.jobs)) {
        expect(JSON.stringify(job['runs-on'])).toContain(';job.priority=4')
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

  it('keeps Namespace container admission off dedicated fleet jobs', () => {
    for (const id of ['test-live-alchemy-github', 'publish-manifest-pr', 'published-status']) {
      expect(
        ciWorkflow.data.jobs[id]!.steps.some((step) => step.id === linuxSandboxAdmissionStepId),
        id,
      ).toBe(false)
    }
    expect(
      ciWorkflow.data.jobs['test-integration-notion']!.steps.some(
        (step) => step.id === linuxSandboxAdmissionStepId,
      ),
    ).toBe(true)
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
  const composeSandboxWorkflow = (workflow: Parameters<typeof composeCiWorkflow>[0]) => {
    const policy = fleetWorkflowPolicy({
      repository: 'example/sandbox-fixture',
      workflow: 'Sandbox fixture',
      mode: 'report',
    })
    return composeCiWorkflow({
      ...workflow,
      policy: {
        ...policy,
        ledger: collectWorkflowPolicyViolations({ workflow, policy }),
      },
    })
  }

  const sandboxWorkflow = (
    runsOn: string | string[],
    capabilities?: Readonly<Record<string, 'supported'>>,
  ) =>
    composeSandboxWorkflow({
      trustTier: 'public',
      on: { push: { branches: ['main'] } },
      linuxNixSandboxCapabilities: capabilities,
      jobs: { build: { 'runs-on': runsOn, steps: [installNixStep()] } },
    })

  it('accepts privileged Namespace labels in both feature formats', () => {
    for (const runsOn of [
      'namespace-profile-linux-x86-64;container.privileged=true',
      [
        'nscloud-ubuntu-24.04-amd64-16x64-with-features',
        'namespace-features:container.privileged=true',
      ],
    ])
      expect(() => sandboxWorkflow(runsOn)).not.toThrow()
  })

  it('rejects unprivileged Namespace Linux installers with job-specific guidance', () => {
    for (const label of [
      'namespace-profile-linux-x86-64',
      'nscloud-ubuntu-24.04-amd64-16x64-with-features',
      'namespace-profile-linux-x86-64;container.privileged=false',
      'namespace-profile-linux-x86-64;container.privileged=trueish',
    ]) {
      expect(() => sandboxWorkflow(label)).toThrow(/CI job "build".*container\.privileged=true/)
      expect(() => sandboxWorkflow(label, { build: 'supported' })).toThrow()
    }
  })

  it('leaves self-hosted, hosted, macOS, and non-installer jobs unaffected', () => {
    for (const runsOn of [
      ['sh-linux-x64', 'nix'],
      ['self-hosted', 'linux'],
      'ubuntu-latest',
      'namespace-profile-macos-arm64',
    ])
      expect(() => sandboxWorkflow(runsOn)).not.toThrow()
    expect(() =>
      composeSandboxWorkflow({
        trustTier: 'public',
        on: { push: { branches: ['main'] } },
        jobs: {
          metadata: { 'runs-on': 'namespace-profile-linux-x86-64', steps: [{ run: 'true' }] },
        },
      }),
    ).not.toThrow()
  })

  it('checks every expression alternative without borrowing privilege from another branch', () => {
    const privileged = 'namespace-profile-linux-x86-64;container.privileged=true'
    const unprivileged = 'namespace-profile-linux-arm64'
    for (const branches of [
      `'${privileged}' || '${unprivileged}'`,
      `'${unprivileged}' || '${privileged}'`,
    ])
      expect(() => sandboxWorkflow(`\${{ github.run_attempt == 1 && ${branches} }}`)).toThrow(
        /lacks container/,
      )
    expect(() =>
      sandboxWorkflow(`\${{ github.run_attempt == 1 && '${privileged}' || 'ubuntu-latest' }}`),
    ).not.toThrow()
    expect(() =>
      sandboxWorkflow(
        `namespace-profile-linux-x86-64;github.run-id=\${{ github.run_id }};container.privileged=true`,
      ),
    ).not.toThrow()
  })

  it('fails closed for opaque runner expressions unless support is explicitly declared', () => {
    for (const expression of [
      '${{ matrix.runner }}',
      "${{ format('namespace-profile-{0};container.privileged=true', matrix.platform) }}",
      "${{ github.run_attempt == 1 && matrix.runner || 'ubuntu-latest' }}",
    ]) {
      expect(() => sandboxWorkflow(expression)).toThrow(
        /cannot statically determine.*linuxNixSandboxCapabilities/,
      )
      const workflow = sandboxWorkflow(expression, { build: 'supported' })
      expect(workflow.data).not.toHaveProperty('linuxNixSandboxCapabilities')
    }
  })

  it('fails closed on opaque interpolated features rather than trusting unused literals', () => {
    for (const runsOn of [
      "namespace-profile-linux-x86-64;${{ inputs.features || 'container.privileged=true' }}",
      [
        'nscloud-ubuntu-24.04-amd64-16x64-with-features',
        "namespace-features:${{ inputs.features || 'container.privileged=true' }}",
      ],
    ]) {
      expect(() => sandboxWorkflow(runsOn)).toThrow(/cannot statically determine/)
      if (typeof runsOn === 'string')
        expect(() => sandboxWorkflow(runsOn, { build: 'supported' })).toThrow(/lacks container/)
      else expect(() => sandboxWorkflow(runsOn, { build: 'supported' })).not.toThrow()
    }
    expect(() =>
      sandboxWorkflow(
        namespaceRunner({
          profile: 'namespace-profile-linux-x86-64',
          runId: '${{ github.run_id }}',
          privileged: 'trusted',
        }).slice(),
      ),
    ).not.toThrow()
  })

  it('rejects privilege features attached through the wrong runner label format', () => {
    for (const runsOn of [
      ['namespace-profile-linux-x86-64', 'namespace-features:container.privileged=true'],
      [
        'namespace-profile-linux-x86-64',
        'nscloud-ubuntu-24.04-amd64-16x64;container.privileged=true',
      ],
      'nscloud-ubuntu-24.04-amd64-16x64-with-features;container.privileged=true',
    ]) {
      expect(() => sandboxWorkflow(runsOn)).toThrow(/supported label format/)
      expect(() => sandboxWorkflow(runsOn, { build: 'supported' })).toThrow(
        /supported label format/,
      )
    }
  })

  it('resolves separate feature-label alternatives before validating their machine label', () => {
    const machine = 'nscloud-ubuntu-24.04-amd64-16x64-with-features'
    const privileged = 'namespace-features:container.privileged=true'
    expect(() =>
      sandboxWorkflow([
        machine,
        `\${{ github.run_attempt == 1 && '${privileged}' || '${privileged};github.run-id=42' }}`,
      ]),
    ).not.toThrow()
    for (const branches of [
      `'${privileged}' || 'namespace-features:container.privileged=false'`,
      `'namespace-features:container.privileged=false' || '${privileged}'`,
    ]) {
      expect(() =>
        sandboxWorkflow([machine, `\${{ github.run_attempt == 1 && ${branches} }}`]),
      ).toThrow(/lacks container/)
    }
    expect(() =>
      sandboxWorkflow([
        `\${{ github.run_attempt == 1 && '${machine}' || 'ubuntu-latest' }}`,
        `\${{ github.run_attempt == 1 && '${privileged}' || '${privileged};github.run-id=42' }}`,
      ]),
    ).not.toThrow()
  })

  it('does not let attestations hide static privilege facts behind opaque affinity', () => {
    for (const runsOn of [
      'namespace-profile-linux-x86-64;container.privileged=false;github.run-id=${{ github.run_attempt }}',
      'namespace-profile-linux-x86-64;github.run-id=${{ github.run_attempt }}',
      [
        'nscloud-ubuntu-24.04-amd64-16x64-with-features',
        'namespace-features:container.privileged=false;github.run-id=${{ github.run_attempt }}',
      ],
    ])
      expect(() => sandboxWorkflow(runsOn, { build: 'supported' })).toThrow(/container\.privileged/)
    expect(() =>
      sandboxWorkflow(
        'namespace-profile-linux-x86-64;container.privileged=true;github.run-id=${{ github.run_attempt }}',
        { build: 'supported' },
      ),
    ).not.toThrow()
  })

  it('excludes known macOS and self-hosted machines before checking opaque feature values', () => {
    for (const runsOn of [
      'namespace-profile-macos-arm64;github.run-id=${{ github.run_attempt }}',
      ['namespace-profile-macos-arm64', 'namespace-features:${{ inputs.features }}'],
      ['sh-linux-x64;github.run-id=${{ github.run_attempt }}', 'nix'],
    ])
      expect(() => sandboxWorkflow(runsOn)).not.toThrow()
  })

  it('applies an explicit self-hosted constraint to all dynamic selector labels', () => {
    expect(() => sandboxWorkflow(['self-hosted', '${{ matrix.runner }}'])).not.toThrow()
  })

  it('rejects static false feature alternatives even beside attested opaque labels', () => {
    const machine = 'nscloud-ubuntu-24.04-amd64-16x64-with-features'
    for (const feature of [
      'namespace-features:container.privileged=false',
      "${{ github.run_attempt == 1 && 'namespace-features:container.privileged=true' || 'namespace-features:container.privileged=false' }}",
      'namespace-features:github.run-id=42',
    ])
      expect(() =>
        sandboxWorkflow([machine, feature, '${{ matrix.extraLabel }}'], { build: 'supported' }),
      ).toThrow(/container\.privileged/)
    expect(() =>
      sandboxWorkflow(
        "${{ github.run_attempt == 1 && 'namespace-profile-linux-x86-64' || matrix.runner }}",
        {
          build: 'supported',
        },
      ),
    ).toThrow(/lacks container/)
  })

  it('configures fresh installers only on Linux', () => {
    expect(linuxNixSandboxFallbackConf).toBe(
      [
        "${{ runner.os == 'Linux' && 'sandbox = true' || '' }}",
        "${{ runner.os == 'Linux' && 'sandbox-fallback = false' || '' }}",
      ].join('\n'),
    )
    expect(installNixStep().with['extra-conf']).toContain(linuxNixSandboxFallbackConf)
    const hostedInstall = pipelineCloseJob({ jobs: {}, runsOn: 'ubuntu-latest' }).steps.find(
      (step) => step.uses === 'cachix/install-nix-action@75c75c31ebece974e48ebc36b4ad125bd97bd97b',
    )
    expect(hostedInstall?.with?.extra_nix_config).toBe(linuxNixSandboxFallbackConf)
  })

  it('configures Linux before any command, preserves inherited config, and skips macOS', () => {
    const macConfig = 'keep-derivations = true'
    const rendered = composeSandboxWorkflow({
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
    expect(linuxNixSandboxFallbackStep.run).toContain('sandbox = true\\nsandbox-fallback = false')
    expect(linuxNixSandboxFallbackStep.run).toContain('sandbox-fallback = false')
    const recomposed = composeSandboxWorkflow({
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
        expect(job.steps.filter((step) => step.id === linuxNixSandboxFallbackStep.id)).toHaveLength(
          1,
        )
        const labels = [job['runs-on']].flat().join(';')
        if (/linux|ubuntu/.test(labels) === true) linuxJobs++
        if (/macos|darwin/.test(labels) === true) macosJobs++
      }
    }
    expect(linuxJobs).toBeGreaterThan(0)
    expect(macosJobs).toBeGreaterThan(0)
  })

  it('refuses fork PR tool realization and uses only declared pinned Node in source-only jobs', () => {
    const jobs = ciWorkflow.data.jobs
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
      if (jobId === 'default-ref-policy') {
        expect(script).toMatch(
          /nix build --no-update-lock-file --no-link --print-out-paths 'github:NixOS\/nixpkgs\/[a-f0-9]{40}\?narHash=sha256-[A-Za-z0-9%]+#nodejs_24'/,
        )
        expect(script).not.toContain('.#')
        expect(script.split('\n')[1]).not.toMatch(
          /(?:path:|file:|git\+file:|\$\{?GITHUB_WORKSPACE)/,
        )
      } else {
        expect(script).toContain(
          'node_out="$(nix build --no-update-lock-file --no-link --print-out-paths .#buck2-node)"',
        )
        expect(job.needs).toContain('default-ref-policy')
      }
      expect(script).toContain('"$node_out/bin/node" <<')
      expect(script).not.toContain('nixpkgs#')
      expect(script).not.toContain('command -v')
      expect(script).not.toContain('ensure_ci_measurement_tool')
      expect(script).not.toContain('nix shell')
      expect(script).not.toMatch(/(?:^|\n)node\s/)
    }
  })

  it('realises the source-shape closure before the two-minute measurement budget', () => {
    for (const job of [
      ciWorkflow.data.jobs['source-shape']!,
      empiricalWorkflow.data.jobs['main-source-shape']!,
    ]) {
      const guardIndex = job.steps.findIndex(
        (step) => step.name === 'Log Linux sandbox prerequisites',
      )
      const realiseIndex = job.steps.findIndex(
        (step) => step.name === 'Realise source-shape tool closure',
      )
      const measureIndex = job.steps.findIndex(
        (step) => step.name === 'Measure source shape: effect-utils',
      )
      expect(realiseIndex).toBeGreaterThan(guardIndex)
      expect(measureIndex).toBeGreaterThan(realiseIndex)
      const realise = job.steps[realiseIndex]!
      const measure = job.steps[measureIndex]!
      expect(realise['timeout-minutes']).toBeUndefined()
      expect(realise.run).toBe('nix build --no-update-lock-file --no-link .#buck2-node')
      expect(measure.run).toContain(
        'nix build --no-update-lock-file --no-link --print-out-paths .#buck2-node',
      )
    }
    const requiredMeasurement = ciWorkflow.data.jobs['source-shape']!.steps.find(
      (step) => step.name === 'Measure source shape: effect-utils',
    )
    expect(requiredMeasurement?.['timeout-minutes']).toBe(2)
  })

  it('keeps checkout-controlled execution after the policy verdict and guards always cleanup', () => {
    const job = ciWorkflow.data.jobs['default-ref-policy']!
    const verdict = job.steps.findIndex((step) => step.id === defaultRefPolicyVerdictStepId)
    expect(verdict).toBeGreaterThan(-1)
    const checkoutReferences =
      /(?:\.#|git\+file:|path:|file:|genie\/|scripts\/|\.\/|GITHUB_WORKSPACE|CI_SOURCE_ROOT)/
    const inlineSetupScripts: Record<string, true> = {
      [linuxNixSandboxFallbackStep.run]: true,
      [linuxSandboxPrerequisitesStep({ privileged: 'trusted' }).run]: true,
      [buck2CiJobInstanceStep.run]: true,
    }
    for (const [index, step] of job.steps.entries()) {
      if (index < verdict) {
        expect(JSON.stringify(step), step.name ?? step.uses).not.toMatch(checkoutReferences)
        if (step.run !== undefined) {
          expect(inlineSetupScripts[step.run], step.name).toBe(true)
        }
      }
      if (
        step.if?.includes('always()') === true &&
        /(?:\.#|git\+file:)/.test(step.run ?? '') === true
      ) {
        expect(step.if, step.name).toContain(
          `steps.${defaultRefPolicyVerdictStepId}.outcome == 'success'`,
        )
      }
    }
    // Proof-disabled policy jobs retain pipeline identity after admission, but
    // must not add a native-evidence window for commands they never execute.
    const identity = job.steps.findIndex((entry) => entry.name === pipelineIdentityStepName)
    expect(identity).toBeGreaterThan(verdict)
    expect(job.steps.some((entry) => entry.name === 'Start Buck2 cache evidence window')).toBe(
      false,
    )
  })

  it('denies pipeline close local-flake execution on forks and failed source admission', () => {
    const job = ciWorkflow.data.jobs['pipeline-attempt-close']!
    expect(job['runs-on']).toBe('ubuntu-latest')
    const close = job.steps.find((step) => step.name === 'Link started job roots')!
    expect(close.if).toContain(namespacePrivilegeTrustedPredicate)
    expect(close.if).toContain("needs.default-ref-policy.result == 'success'")
    const expression = close
      .if!.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      .replace('needs.default-ref-policy', 'needs["default-ref-policy"]')
    const allowed = new Function('github', 'needs', 'always', `return (${expression})`)
    const repository = 'overengineeringstudio/effect-utils'
    for (const [headRepository, verdict, expected] of [
      [repository, 'success', true],
      [repository, 'failure', false],
      ['external-contributor/effect-utils', 'success', false],
      ['external-contributor/effect-utils', 'failure', false],
    ] as const) {
      expect(
        allowed(
          {
            event_name: 'pull_request',
            repository,
            event: { pull_request: { head: { repo: { full_name: headRepository } } } },
          },
          { 'default-ref-policy': { result: verdict } },
          () => true,
        ),
      ).toBe(expected)
    }
  })
})

describe('CI execution admission cleanup', () => {
  const workflows = [
    ciWorkflow,
    empiricalWorkflow,
    compiledWorkflow,
    storybookPlaysWorkflow,
    previewBuildWorkflow,
    previewDeployWorkflow,
    autoReviewWorkflow,
  ]

  it('blocks rejected quality admission while retaining admitted failure cleanup and Darwin', () => {
    const job = ciWorkflow.data.jobs.quality!
    expect(job.steps.find((step) => step.name === 'Log Linux sandbox prerequisites')?.id).toBe(
      linuxSandboxAdmissionStepId,
    )
    for (const name of ['Collect Buck2 cache evidence', 'Export completed job trace']) {
      const step = job.steps.find((entry) => entry.name === name)!
      const expression = step
        .if!.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
        .replace(/steps\.([A-Za-z0-9_-]+)/g, 'steps["$1"]')
      const allowed = new Function('runner', 'steps', 'always', `return (${expression})`)
      for (const [os, outcome, expected] of [
        ['Linux', 'failure', false],
        ['Linux', 'skipped', false],
        ['Linux', 'success', true],
        ['macOS', 'skipped', true],
      ] as const) {
        expect(
          allowed({ os }, { [linuxSandboxAdmissionStepId]: { outcome } }, () => true),
          `${name}/${os}/${outcome}`,
        ).toBe(expected)
      }
    }
  })

  it('covers every admission job and executable status cleanup in every generated workflow', () => {
    let admissionJobs = 0
    let executableCleanups = 0
    let safeUploads = 0
    for (const workflow of workflows) {
      for (const [jobId, job] of Object.entries(workflow.data.jobs)) {
        const guards = job.steps.filter(
          (step) =>
            step.name === 'Log Linux sandbox prerequisites' ||
            step.name === 'Check first-party default refs',
        )
        if (guards.length === 0) continue
        admissionJobs++
        for (const guard of guards) {
          expect(guard.id, jobId).toBe(
            guard.name === 'Log Linux sandbox prerequisites'
              ? linuxSandboxAdmissionStepId
              : defaultRefPolicyVerdictStepId,
          )
        }
        const lastAdmission = Math.max(...guards.map((guard) => job.steps.indexOf(guard)))
        for (const [index, step] of job.steps.entries()) {
          if (
            step.name === 'Start Buck2 cache evidence window' ||
            step.name === pipelineIdentityStepName
          ) {
            expect(index, `${jobId}/${step.name}`).toBeGreaterThan(lastAdmission)
          }
          if (/\b(?:always|failure|cancelled|success)\s*\(/.test(step.if ?? '') === false) continue
          if (/^actions\/(?:upload-artifact|cache\/save)@/.test(step.uses ?? '') === true) {
            safeUploads++
            expect(step.if, `${jobId}/${step.name}`).not.toContain(linuxSandboxAdmissionStepId)
            continue
          }
          executableCleanups++
          for (const guard of guards) {
            expect(step.if, `${jobId}/${step.name}`).toContain(
              `steps.${guard.id}.outcome == 'success'`,
            )
          }
        }
      }
    }
    expect(admissionJobs).toBeGreaterThan(0)
    expect(executableCleanups).toBeGreaterThan(0)
    expect(safeUploads).toBeGreaterThan(0)
  })

  it('keeps independent executable cleanup restricted to its trusted event admission', () => {
    const independentRoutes: Record<string, 'job' | 'step'> = {
      'pr-a-inert-buck': 'job',
      'build-products': 'job',
      'publish-products': 'job',
      'publish-compiled-products': 'job',
      'trusted-buck2-remote-cache-proof': 'job',
      'ci-measurements-report': 'job',
      'pipeline-attempt-close': 'step',
    }
    const seen = new Set<string>()
    for (const workflow of workflows) {
      for (const [jobId, job] of Object.entries(workflow.data.jobs)) {
        if (ciJobAdmission(job.steps).condition !== undefined) continue
        const cleanup = job.steps.filter(
          (step) =>
            /\b(?:always|failure|cancelled|success)\s*\(/.test(step.if ?? '') &&
            (step.run !== undefined || step.uses?.startsWith('./')),
        )
        // This proof-disabled publisher may clean credentials, not run native proof.
        if (jobId === 'publish-compiled-products')
          expect(cleanup.map((step) => step.name)).toEqual([
            'Remove isolated compile Cachix configuration',
          ])
        if (cleanup.length === 0) continue
        expect(independentRoutes[jobId], jobId).toBeDefined()
        seen.add(jobId)
        const condition = independentRoutes[jobId] === 'step' ? cleanup[0]!.if! : job.if!
        const expression = condition
          .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
          .replace(/needs\.([A-Za-z0-9_-]+)/g, 'needs["$1"]')
        const allowed = new Function(
          'github',
          'inputs',
          'needs',
          'always',
          'cancelled',
          `return (${expression})`,
        )
        const needs = Object.fromEntries(
          (typeof job.needs === 'string' ? [job.needs] : (job.needs ?? [])).map((id) => [
            id,
            { result: 'success', outputs: { tested: 'false' } },
          ]),
        )
        for (const [eventName, expected] of [
          ['pull_request', false],
          ['push', true],
        ] as const) {
          expect(
            allowed(
              {
                event_name: eventName,
                ref: 'refs/heads/main',
                repository: 'overengineeringstudio/effect-utils',
                event: { pull_request: { head: { repo: { full_name: 'fork/effect-utils' } } } },
              },
              { measurement_baseline_ref: '' },
              needs,
              () => true,
              () => false,
            ),
            `${jobId}/${eventName}`,
          ).toBe(expected)
        }
      }
    }
    expect([...seen].toSorted()).toEqual(Object.keys(independentRoutes).toSorted())
  })

  it('combines all admission prerequisites, is idempotent, and leaves independent jobs alone', () => {
    const independent = [
      { name: 'Independent trusted cleanup', if: '${{ always() }}', run: 'nix shell .#bun -c bun' },
    ]
    expect(withCiAdmissionCleanup(independent)).toBe(independent)
    const steps = [
      linuxSandboxPrerequisitesStep({ privileged: 'trusted' }),
      { id: defaultRefPolicyVerdictStepId, run: 'node pinned-policy-checker' },
      { name: 'Executable cleanup', if: 'always() || failure()', run: 'bash checkout-cleanup.sh' },
      { name: 'Safe upload', if: 'always()', uses: 'actions/upload-artifact@v4' },
    ]
    const guarded = withCiAdmissionCleanup(steps)
    expect(ciJobAdmission(steps).after).toBe(1)
    expect(withCiAdmissionCleanup(guarded)).toEqual(guarded)
    expect(guarded[3]).toEqual(steps[3])
    const expression = guarded[2]!
      .if!.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      .replace(/steps\.([A-Za-z0-9_-]+)/g, 'steps["$1"]')
    const allowed = new Function('runner', 'steps', 'always', 'failure', `return (${expression})`)
    for (const [namespace, verdict, expected] of [
      ['failure', 'success', false],
      ['success', 'failure', false],
      ['success', 'success', true],
    ] as const) {
      expect(
        allowed(
          { os: 'Linux' },
          {
            [linuxSandboxAdmissionStepId]: { outcome: namespace },
            [defaultRefPolicyVerdictStepId]: { outcome: verdict },
          },
          () => true,
          () => true,
        ),
      ).toBe(expected)
    }
  })
})

describe('Buck2 CI job instance projection', () => {
  it('initializes a fresh instance before any Buck-running job steps', () => {
    for (const definition of [
      ciWorkflow,
      compiledWorkflow,
      empiricalWorkflow,
      storybookPlaysWorkflow,
      previewBuildWorkflow,
      previewDeployWorkflow,
      autoReviewWorkflow,
    ]) {
      const workflow: GitHubWorkflowArgs = definition.data
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        if (job.env?.BUCK2_NO_REMOTE_CACHE !== '0') continue
        const initializers = job.steps.filter((step) => step.id === 'buck2-ci-job-instance')
        expect(initializers, jobId).toHaveLength(1)
        expect(job.steps[1], jobId).toBe(initializers[0]!)
        expect(initializers[0]!.run, jobId).toContain('BUCK2_CI_JOB_INSTANCE=%s')
        expect(initializers[0]!.run, jobId).toContain('/dev/urandom')
        expect(initializers[0]!.run, jobId).toContain('>> "$GITHUB_ENV"')
      }
    }
  })
})

describe('unit-test shell selection', () => {
  it('selects the narrow shell only at job scope for required unit-test jobs', () => {
    const workflow: GitHubWorkflowArgs = ciWorkflow.data
    expect(workflow.env?.EFFECT_UTILS_CI_TEST).toBeUndefined()
    expect(
      Object.entries(workflow.jobs)
        .filter(([, job]) => job.env?.EFFECT_UTILS_CI_TEST === '1')
        .map(([jobId]) => jobId)
        .toSorted(),
    ).toEqual(['test', 'test-macos', 'test-megarepo-store-gc'])

    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      expect(job.env?.EFFECT_UTILS_CI_TEST, jobId).toBe(
        ['test', 'test-macos', 'test-megarepo-store-gc'].includes(jobId) === true ? '1' : undefined,
      )
      for (const step of job.steps) {
        expect(step.env?.EFFECT_UTILS_CI_TEST, `${jobId}/${step.name ?? step.id}`).toBeUndefined()
      }
    }
  })
})

describe('required platform test classification', () => {
  it('classifies every aggregate source task exactly once with a rationale', () => {
    const suites = [...testPlatforms.darwin, ...testPlatforms.neutral]
    const tasks = suites.map(({ task }) => task)
    const aggregateTasks = [
      'test:buck2:unit',
      'test:buck2:library-closure',
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

describe('published consumer ref', () => {
  const publisher = ciWorkflow.data.jobs['publish-products']!
  const smoke = ciWorkflow.data.jobs['consumer-smoke']!
  const promotion = ciWorkflow.data.jobs['promote-published']!
  const steps = promotion.steps!

  it('reports only terminal upstream main-push status with the workflow token', () => {
    const reporter = ciWorkflow.data.jobs['published-status']!
    expect(reporter.needs).toEqual(['publish-products', 'consumer-smoke', 'promote-published'])
    expect(reporter.if).toBe(
      `always() && (${sameRepoPullRequestGuard()}) && github.repository == 'overengineeringstudio/effect-utils' && github.event_name == 'push' && github.ref == 'refs/heads/main'`,
    )
    expect(reporter.permissions).toEqual({ statuses: 'write' })
    expect(reporter['runs-on']).toEqual(['sh-linux-x64', 'nix'])
    expect(reporter.steps.every((step) => step.uses === undefined)).toBe(true)
    const report = reporter.steps.find((step) => step.name === 'Report published/current status')!
    expect(report.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      PUBLISH_RESULT: '${{ needs.publish-products.result }}',
      SMOKE_RESULT: '${{ needs.consumer-smoke.result }}',
      PROMOTE_RESULT: '${{ needs.promote-published.result }}',
    })
    expect(report.run).toContain('-f context=published/current')
    expect(report.run).not.toContain('pending')
    expect(report.run).toContain('-f description="${description:0:140}"')
    expect(report.run).toContain('"repos/$GITHUB_REPOSITORY/statuses/$GITHUB_SHA"')
    const advance = steps.find((step) => step.id === 'advance-published-ref')!.run!
    expect(advance).toContain('noop)\n')
    expect(advance).toContain(
      'is not newer than the published main parent)" >> "$GITHUB_STEP_SUMMARY"\n      exit 0',
    )
    expect(advance).toContain(
      '(Published-From: $GITHUB_SHA)" >> "$GITHUB_STEP_SUMMARY"\n        exit 0',
    )
  })

  it.each([
    ['success', 'success', 'success', 'success', 'Published contains'],
    ['success', 'success', 'failure', 'failure', 'promote-published failed'],
    ['success', 'success', 'skipped', 'error', 'promote-published=skipped'],
    ['success', 'success', 'cancelled', 'error', 'promote-published=cancelled'],
    ...['failure', 'skipped', 'cancelled'].flatMap((result) => [
      [result, 'success', 'skipped', 'error', `publish-products=${result}`],
      ['success', result, 'skipped', 'error', `consumer-smoke=${result}`],
    ]),
    [
      'failure',
      'cancelled',
      'skipped',
      'error',
      'publish-products=failure consumer-smoke=cancelled',
    ],
  ])(
    'maps publication=%s smoke=%s promotion=%s to %s',
    (publish, smokeResult, promote, state, description) => {
      const script = ciWorkflow.data.jobs['published-status']!.steps.find(
        (step) => step.name === 'Report published/current status',
      )!.run!
      // Capture the API request without network access, exercising the emitted Bash.
      const result = Bun.spawnSync(['bash', '-c', `gh() { printf '%s\\n' "$@"; }\n${script}`], {
        env: {
          ...process.env,
          PUBLISH_RESULT: publish!,
          SMOKE_RESULT: smokeResult!,
          PROMOTE_RESULT: promote!,
          GITHUB_REPOSITORY: 'overengineeringstudio/effect-utils',
          GITHUB_SHA: 'candidate',
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_RUN_ID: '123',
        },
      })
      expect(result.exitCode).toBe(0)
      const request = result.stdout.toString()
      expect(request).toContain(`state=${state}\n`)
      expect(request).toContain('context=published/current\n')
      expect(request).toContain(description!)
      expect(request).toContain('repos/overengineeringstudio/effect-utils/statuses/candidate\n')
    },
  )

  it('realises publication inputs before the unchanged build-and-push timeout', () => {
    const realiseIndex = publisher.steps.findIndex(
      (step) => step.name === 'Realise publish-products build inputs',
    )
    const publishIndex = publisher.steps.findIndex((step) => step.name === 'Publish products')
    const authIndex = publisher.steps.findIndex((step) => step.id === 'product-cachix-auth')
    const readIndex = publisher.steps.findIndex((step) => step.id === 'product-cachix-read')
    expect(readIndex).toBeGreaterThan(-1)
    expect(realiseIndex).toBeGreaterThan(readIndex)
    expect(authIndex).toBeGreaterThan(realiseIndex)
    expect(publishIndex).toBeGreaterThan(authIndex)
    expect(publisher.steps[readIndex]?.with).toEqual({
      name: 'overeng-effect-utils',
      skipPush: true,
    })
    expect(publishIndex).toBeGreaterThan(realiseIndex)
    const realise = publisher.steps[realiseIndex]!
    const publish = publisher.steps[publishIndex]!
    expect(realise['timeout-minutes']).toBeUndefined()
    expect(publish['timeout-minutes']).toBe(32)
    expect(realise.if).toBe(publish.if)
    expect(realise.env).toEqual({ GITHUB_TOKEN: publish.env?.GITHUB_TOKEN })
    expect(realise.env?.GITHUB_TOKEN).toBe('${{ github.token }}')
    expect(realise.env?.CACHIX_AUTH_TOKEN).toBeUndefined()
    for (const step of publisher.steps.slice(0, realiseIndex + 1)) {
      expect(step.env?.CACHIX_AUTH_TOKEN).toBeUndefined()
      expect(step.with?.authToken).toBeUndefined()
    }
    expect(realise.run).toBe(withCiSourceRoot('nix/buck2-products/publish.sh --realise-inputs'))
    expect(publish.run).toContain('nix/buck2-products/publish.sh --proposal "$proposal"')
  })

  it('skips known-superseded manifest writers before runner admission without gating consumers', () => {
    const writer = ciWorkflow.data.jobs['publish-manifest-pr']!
    expect(writer.if).toContain("needs.publish-products.outputs.manifest-writer-tip == 'true'")
    expect(publisher.outputs?.['manifest-writer-tip']).toBe(
      '${{ steps.manifest-writer-tip.outputs.manifest-writer-tip }}',
    )
    const tipIndex = publisher.steps.findIndex((step) => step.id === 'manifest-writer-tip')
    expect(tipIndex).toBeGreaterThan(
      publisher.steps.findIndex((step) => step.id === 'product-publication'),
    )
    // Also runs after the manifest-only fast path: no publication-scope condition.
    expect(publisher.steps[tipIndex]!.if).toBeUndefined()
    const dependents = Object.entries(ciWorkflow.data.jobs).filter(([, job]) =>
      job.needs?.includes('publish-manifest-pr'),
    )
    expect(dependents.map(([id]) => id)).toEqual(['pipeline-attempt-close'])
    expect(dependents[0]![1].if).toBe(
      "${{ !(github.event_name == 'workflow_dispatch' && inputs['measure-macos'] == true) && (always()) }}",
    )
    expect(JSON.stringify(dependents[0]![1])).not.toContain('needs.publish-manifest-pr.result')
    expect(JSON.stringify(ciWorkflow.data.jobs['published-status']!)).not.toContain(
      'publish-manifest-pr',
    )
  })

  it.each([
    ['current', 'a'.repeat(40), 0, 'true'],
    ['superseded', 'b'.repeat(40), 0, 'false'],
    ['network/API failure', '', 1, 'true'],
    ['failed lookup with partial output', 'b'.repeat(40), 1, 'true'],
    ['empty response', '', 0, 'true'],
    ['malformed response', 'null', 0, 'true'],
  ])('checks the canonical main tip, failing open for %s', (_, tip, status, enabled) => {
    const script = publisher.steps.find((step) => step.id === 'manifest-writer-tip')!.run!
    const result = Bun.spawnSync(
      [
        'bash',
        '-c',
        [
          'export GITHUB_OUTPUT="$(mktemp)"',
          'trap \'rm -f "$GITHUB_OUTPUT"\' EXIT',
          'gh() {',
          '  [ "$*" = "api repos/overengineeringstudio/effect-utils/git/ref/heads/main --jq .object.sha" ] || exit 99',
          '  printf "%s\\n" "$TIP"',
          '  return "$LOOKUP_STATUS"',
          '}',
          script,
          'cat "$GITHUB_OUTPUT"',
        ].join('\n'),
      ],
      {
        env: {
          ...process.env,
          TIP: tip!,
          LOOKUP_STATUS: String(status),
          GITHUB_SHA: 'a'.repeat(40),
          GITHUB_REPOSITORY: 'other/repository',
        },
      },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
    expect(result.stdout.toString()).toContain(`manifest-writer-tip=${enabled}\n`)
  })

  it('gates manifest PR writes on bootstrap drift or the daily safety net with the read-only token', () => {
    const writer = ciWorkflow.data.jobs['publish-manifest-pr']!
    expect(JSON.stringify(publisher.concurrency)).not.toContain('buck2-products-manifest-writer')
    expect(publisher.permissions?.['pull-requests']).toBe('read')
    expect(writer.needs).toEqual(['publish-products'])
    expect(writer.if).toContain("github.repository == 'overengineeringstudio/effect-utils'")
    for (const job of [smoke, promotion]) expect(job.needs).not.toContain('publish-manifest-pr')
    for (let index = 0; index < 4; index++)
      expect(writer.env?.[`MANIFEST_BASE64_${index}`]).toBe(
        `\${{ needs.publish-products.outputs.manifest-base64-${index} }}`,
      )
    expect(publisher.steps.some((step) => step.id === 'publisher-app-token')).toBe(false)
    const token = writer.steps.find((step) => step.id === 'publisher-app-token')!
    expect(token.if).toBe("steps.publisher-app-config.outputs.enabled == 'true'")
    const gateIndex = writer.steps.findIndex((step) => step.id === 'manifest-pr-gate')
    const appIndex = writer.steps.findIndex((step) => step.id === 'publisher-app-config')
    const proposeIndex = writer.steps.findIndex(
      (step) => step.name === 'Propose published product manifest',
    )
    expect(gateIndex).toBeLessThan(appIndex)
    expect(appIndex).toBeLessThan(proposeIndex)
    const gate = writer.steps[gateIndex]!
    expect(gate.run).toContain('source genie/ci-workflow/published-ref-decide.sh')
    expect(gate.run).toContain('decode_manifest > "$proposal"')
    expect(gate.env).toEqual({ GITHUB_TOKEN: '${{ github.token }}' })
    expect(gate.run).toContain('decision="$(manifest_pr_decide ')
    expect(gate.run).toContain('decision="$(manifest_pr_heal_decide ')
    expect(writer.steps[appIndex]!.if).toBe(
      "steps.manifest-pr-gate.outputs.decision == 'open' || steps.manifest-pr-gate.outputs.decision == 'close'",
    )
    const proposal = writer.steps[proposeIndex]!
    expect(proposal.if).toBe("steps.publisher-app-config.outputs.enabled == 'true'")
    expect(proposal.run).toContain('matching bootstrap proposals untouched')
    expect(writer.concurrency).toEqual({
      group: 'buck2-products-manifest-writer',
      'cancel-in-progress': false,
    })
    expect(proposal.run).toContain('decision="$(manifest_pr_writer_decide "$GITHUB_SHA")"')
    expect(proposal.run).toContain(
      'if [ "$decision" != open ]; then\n  echo "::notice::Manifest PR: $decision; superseded: a newer main run owns the proposal"\n  exit 0\nfi\ndecision="$(manifest_pr_writer_push "$GITHUB_REPOSITORY" "$branch")"\nif [ "$decision" = skip-queued ]; then exit 0; fi',
    )
    expect(proposal.env?.GITHUB_TOKEN).toBe('${{ github.token }}')
    expect(proposal.env?.GH_TOKEN).toBe('${{ steps.publisher-app-token.outputs.token }}')
    const publication = publisher.steps.find((step) => step.id === 'product-publication')!.run!
    expect(publication).toContain('Stale rows fall back by design')
    expect(publication).toContain('bootstrap_rows "$proposal" "$pins"')
  })

  it.each(['source', 'newer', 'unavailable'])(
    'guards stale-PR closure against main tip %s',
    (tip) => {
      const script = ciWorkflow.data.jobs['publish-manifest-pr']!.steps.find(
        (step) => step.name === 'Propose published product manifest',
      )!.run!.replace('${{ steps.manifest-pr-gate.outputs.decision }}', 'close')
      const result = Bun.spawnSync(
        [
          'bash',
          '-c',
          [
            'git() { [ "$TIP" != unavailable ] || return 1; printf "%s\\trefs/heads/main\\n" "$TIP"; }',
            'gh() { if [ "$1 $2" = "pr list" ]; then echo 123; else printf "mutation:%s\\n" "$*"; fi; }',
            script,
          ].join('\n'),
        ],
        { env: { ...process.env, TIP: tip, GITHUB_SHA: 'source', RUNNER_TEMP: '/tmp' } },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString().includes('mutation:pr close 123')).toBe(tip === 'source')
      if (tip === 'source')
        expect(result.stdout.toString()).toContain('Main already matches the latest run')
    },
  )

  it('joins same-SHA publication and consumer proofs before main-push promotion', () => {
    expect(promotion.needs).toEqual(['publish-products', 'consumer-smoke'])
    expect(promotion.if).toBe(publishedRefIf)
    expect(publisher.needs ?? []).not.toContain('consumer-smoke')
    expect(publisher.steps!.some((step) => step.id === 'advance-published-ref')).toBe(false)
    const advance = steps.find((step) => step.id === 'advance-published-ref')!
    const token = steps.find((step) => step.id === 'published-ref-token')!
    expect(advance).toBeDefined()
    expect(advance.if).toBe(publishedRefIf)
    expect(token.if).toBe(publishedRefIf)
    expect(publishedRefIf).toContain("github.repository == 'overengineeringstudio/effect-utils'")
    expect(publishedRefIf).toContain("github.event_name == 'push'")
    expect(publishedRefIf).toContain("github.ref == 'refs/heads/main'")
    for (const job of ['publish-products', 'consumer-smoke']) {
      expect(publishedRefIf).toContain(`needs['${job}'].result == 'success'`)
      expect(publishedRefIf).toContain(`needs['${job}'].outputs.current-sha == github.sha`)
    }
    expect(publisher.outputs?.['current-sha']).toBe(
      '${{ steps.publication-scope.outputs.current-sha || steps.product-publication.outputs.current-sha }}',
    )
    for (const id of ['publication-scope', 'product-publication']) {
      const producer = publisher.steps!.find((step) => step.id === id)!
      const script = producer.run as string
      expect(script).toContain('source genie/ci-workflow/published-ref-decide.sh')
      expect(script).toContain('manifest_outputs ')
      expect(script).toContain('echo "current-sha=$GITHUB_SHA"')
    }
    const publication = publisher.steps!.find((step) => step.id === 'product-publication')!.run!
    expect(publication.indexOf('echo "current-sha=$GITHUB_SHA"')).toBeLessThan(
      publication.indexOf('if cmp -s'),
    )
    for (const index of [0, 1, 2, 3]) {
      expect(publisher.outputs?.[`manifest-base64-${index}`]).toContain(
        `steps.product-publication.outputs.manifest-base64-${index}`,
      )
    }
  })

  it('runs the shared consumer harness without the root shell and emits success only afterward', () => {
    expect(smoke.if).toBe(publisher.if)
    expect(smoke['timeout-minutes']).toBe(10)
    expect(smoke.permissions).toEqual({ contents: 'read' })
    expect(smoke.outputs?.['current-sha']).toBe('${{ steps.consumer-smoke.outputs.current-sha }}')
    const smokeStep = smoke.steps!.find((step) => step.id === 'consumer-smoke')!
    const resolution = smoke.steps!.find((step) => step.name === pipelineDevenvStepName)!
    expect(resolution).toBeDefined()
    expect(resolution.run).toContain('resolve-devenv.sh')
    expect(smoke.steps!.indexOf(resolution)).toBeLessThan(smoke.steps!.indexOf(smokeStep))
    const command = smokeStep.run as string
    expect(command).toContain(
      'bash nix/fixtures/consumer-smoke/run.sh "$PWD" "${DEVENV_BIN:?DEVENV_BIN not set}"',
    )
    expect(command).not.toContain('tasks run')
    expect(command).not.toContain(' shell ')
    expect(command.indexOf('nix/fixtures/consumer-smoke/run.sh')).toBeLessThan(
      command.indexOf('echo "current-sha=$GITHUB_SHA"'),
    )
    expect(smoke.steps!.some((step) => String(step.run).includes('buck2:editor:bootstrap'))).toBe(
      false,
    )
    expect(steps.some((step) => step.uses?.includes('install-nix'))).toBe(false)
    expect(steps.some((step) => String(step.run).includes('devenv'))).toBe(false)
  })

  it('smokes the proposal tree and guards every promotion attempt against that tree', () => {
    expect(smoke.needs).toEqual(['publish-products'])
    expect(smoke.outputs?.['smoked-tree']).toBe('${{ steps.consumer-smoke.outputs.smoked-tree }}')
    const smokeStep = smoke.steps!.find((step) => step.id === 'consumer-smoke')!
    const command = smokeStep.run as string
    for (const index of [0, 1, 2, 3]) {
      expect(smokeStep.env?.[`MANIFEST_BASE64_${index}`]).toBe(
        `\${{ needs.publish-products.outputs.manifest-base64-${index} }}`,
      )
    }
    expect(command).toContain('decode_manifest > nix/buck2-products/manifest.json')
    expect(command.indexOf('git add nix/buck2-products/manifest.json')).toBeLessThan(
      command.indexOf('smoked_tree="$(git write-tree)"'),
    )
    expect(command.indexOf('smoked_tree="$(git write-tree)"')).toBeLessThan(
      command.indexOf('bash nix/fixtures/consumer-smoke/run.sh'),
    )
    expect(command.indexOf('bash nix/fixtures/consumer-smoke/run.sh')).toBeLessThan(
      command.indexOf('echo "smoked-tree=$smoked_tree"'),
    )
    const advance = steps.find((step) => step.id === 'advance-published-ref')!
    expect(advance.env?.SMOKED_TREE).toBe('${{ needs.consumer-smoke.outputs.smoked-tree }}')
    const guard =
      'git rev-parse "$commit^{tree}")" != "${SMOKED_TREE:?Missing consumer-smoked tree}"'
    expect(advance.run).toContain(guard)
    expect(advance.run!.indexOf('for attempt in 1 2 3; do')).toBeLessThan(
      advance.run!.indexOf(guard),
    )
    expect(advance.run!.indexOf(guard)).toBeLessThan(
      advance.run!.indexOf('git push --force-with-lease'),
    )
  })

  it('uses the publisher App and checks ancestry before and after a raced push', () => {
    const token = steps.find((step) => step.id === 'published-ref-token')!
    expect(token.with?.['app-id']).toBe('${{ vars.NIX_PUBLISHER_GITHUB_APP_ID }}')
    expect(token.with?.['permission-contents']).toBe('write')
    expect(Object.keys(token.with ?? {}).filter((key) => key.startsWith('permission-'))).toEqual([
      'permission-contents',
    ])
    const advance = steps.find((step) => step.id === 'advance-published-ref')!
    expect(advance.env?.GH_TOKEN).toBe('${{ steps.published-ref-token.outputs.token }}')
    expect(advance.run).toContain('source genie/ci-workflow/published-ref-decide.sh')
    expect(advance.run).toContain('for attempt in 1 2 3; do')
    expect(advance.run).toContain(
      'case "$(decide "$tip" "$GITHUB_SHA" refs/remotes/origin/main)" in',
    )
    expect(advance.run).toContain('git fetch --no-tags origin +refs/heads/main:')
    expect(advance.run).toContain('decode_manifest > "$proposal"')
    for (const index of [0, 1, 2, 3]) {
      expect(advance.env?.[`MANIFEST_BASE64_${index}`]).toBe(
        `\${{ needs.publish-products.outputs.manifest-base64-${index} }}`,
      )
    }
    expect(advance.run).toContain('parents: [$tip, $main]')
    expect(advance.run).toContain('Published-From: ')
    expect(advance.run).toContain('/git/trees')
    expect(advance.run).toContain('/git/commits')
    expect(advance.run).toContain('git diff --name-only "$GITHUB_SHA" "$commit"')
    expect(advance.run).toContain('[ "$changed" != nix/buck2-products/manifest.json ]')
    expect(advance.run).toContain(
      'git push --force-with-lease="refs/heads/published:$tip" origin "$commit:refs/heads/published"',
    )
    expect(advance.run).toContain('$GITHUB_STEP_SUMMARY')
  })
})

describe('shared default-ref policy configuration', () => {
  it('defaults effect-utils to published while accepting main', () => {
    const env = defaultRefPolicyCheckStep().env
    expect(env.DEFAULT_REF).toBe('main')
    expect(JSON.parse(env.DEFAULT_REF_POLICIES_JSON)).toEqual({
      'overengineeringstudio/effect-utils': {
        defaultRef: 'published',
        acceptedRefs: ['published', 'main'],
      },
    })
    const job = ciWorkflow.data.jobs['default-ref-policy']!
    const verdict = job.steps.find((step) => step.id === defaultRefPolicyVerdictStepId)!
    expect(verdict.env?.DEFAULT_REF_POLICIES_JSON).toBe(env.DEFAULT_REF_POLICIES_JSON)
    expect(JSON.parse(verdict.env?.DEFAULT_REFS_JSON ?? '{}')).toEqual({
      'livestorejs/livestore': 'dev',
    })
  })
})

describe('cold pnpm preparation', () => {
  it.each([true, false])(
    'prepares cold pnpm state and installs unconditionally with diagnostics enabled: %s',
    (includeDiagnostics) => {
      const prep = standardSelfHostedPnpmCiPrepSteps({ includeDiagnostics })
      const post = standardSelfHostedPnpmCiPostSteps({
        includeDiagnosticsArtifact: includeDiagnostics,
      })
      const isolationIndex = prep.findIndex((step) => step.name === pnpmStateSetupStep.name)
      const install = pnpmInstallWithDiagnosticsStep()
      const installIndex = prep.findIndex((step) => step.name === install.name)

      expect(isolationIndex).toBeGreaterThanOrEqual(0)
      expect(prep[isolationIndex]).toEqual(pnpmStateSetupStep)
      expect(pnpmStateSetupStep).not.toHaveProperty('if')
      expect(pnpmStateSetupStep.run).toContain(`mkdir -p "${ciPnpmStore}" "${ciPnpmHome}" .devenv`)
      expect(pnpmStateSetupStep.run).toContain(`ln -s "${ciPnpmStore}" "$member_store"`)
      for (const [name, path] of [
        ['PNPM_STORE_DIR', ciPnpmStore],
        ['PNPM_CONFIG_STORE_DIR', ciPnpmStore],
        ['PNPM_HOME', ciPnpmHome],
      ]) {
        expect(pnpmStateSetupStep.run).toContain(`echo "${name}=${path}" >> "$GITHUB_ENV"`)
      }
      expect(installIndex).toBeGreaterThan(isolationIndex)
      expect(prep[installIndex]).toEqual(install)
      expect(prep[installIndex]).not.toHaveProperty('if')
      expect(install.run).toContain('pnpm:install')
      expect(install.run).not.toContain('cache-hit')
      expect([...prep, ...post].map((step) => step.name)).not.toContain('Restore pnpm state')
      expect([...prep, ...post].map((step) => step.name)).not.toContain('Save pnpm state')
      expect(
        [...prep, ...post].filter(
          (step) =>
            'uses' in step &&
            typeof step.uses === 'string' &&
            step.uses.startsWith('actions/cache/'),
        ),
      ).toEqual([restoreNixCacheStep(), saveNixCacheStep()])
    },
  )
})

describe('Nix cache stable paths', () => {
  it('uses identical stable restore/save paths for Nix caches', () => {
    const nixRestore = restoreNixCacheStep()
    const nixSave = saveNixCacheStep()
    expect(nixRestore.with.path).toBe(nixSave.with.path)
    expect(nixRestore.with.path).not.toContain('github.run_id')
  })
})
