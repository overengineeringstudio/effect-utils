import { describe, expect, it } from 'bun:test'

import {
  cargoClippyJob,
  cargoFmtJob,
  cargoNextestJob,
  cargoNextestStep,
  nixDevelopStep,
  plainFlakeGenieCheckJob,
  plainFlakeJob,
  plainFlakeSetupSteps,
} from './rust.ts'
import { namespaceRunner } from './setup.ts'

describe('plain-flake Rust CI', () => {
  it('retains each explicit privilege mode in caller-selected Namespace runners', () => {
    for (const namespacePrivilege of ['always', 'trusted', 'never'] as const) {
      const opts = {
        namespacePrivilege,
        runsOn: namespaceRunner({
          profile: 'namespace-profile-linux-x86-64',
          runId: '${{ github.run_id }}',
          privileged: namespacePrivilege,
        }),
      }
      const jobs = [
        plainFlakeJob({ ...opts, step: { run: 'nix build' } }),
        cargoFmtJob(opts),
        cargoClippyJob(opts),
        cargoNextestJob(opts),
        plainFlakeGenieCheckJob(opts),
      ]
      for (const job of jobs) {
        expect(job['runs-on']).toEqual(
          namespaceRunner({
            profile: 'namespace-profile-linux-x86-64',
            runId: '${{ github.run_id }}',
            privileged: namespacePrivilege,
          }),
        )
        expect(job).not.toHaveProperty('namespacePrivilege')
      }
    }
  })

  it('retains an explicit runner override without changing the Nix command', () => {
    const job = cargoFmtJob({ namespacePrivilege: 'trusted', runsOn: 'ubuntu-latest' })
    expect(job['runs-on']).toBe('ubuntu-latest')
    expect(job.steps.at(-1)?.run).toBe('nix develop -c cargo fmt --all -- --check')
  })

  it('keeps spaces, quotes, empty arguments and shell metacharacters inside argv', () => {
    expect(
      nixDevelopStep({
        name: 'Filtered tests',
        flake: '.#ci',
        command: [
          'cargo',
          'nextest',
          'run',
          '-E',
          "test(foo's name) | test(bar)",
          '',
          '$(touch /tmp/bad)',
        ],
      }).run,
    ).toBe(
      `nix develop '.#ci' -c cargo nextest run -E 'test(foo'"'"'s name) | test(bar)' '' '$(touch /tmp/bad)'`,
    )
  })

  it('retains zero retries and supports relative nextest concurrency', () => {
    expect(cargoNextestStep({ retries: 0, testThreads: 'num-cpus/2' }).run).toBe(
      'nix develop -c cargo nextest run --workspace --locked --retries 0 --test-threads num-cpus/2',
    )
    expect(
      cargoNextestStep({ retries: 3, testThreads: 8, extraArgs: ['--profile', 'ci'] }).run,
    ).toBe(
      'nix develop -c cargo nextest run --workspace --locked --retries 3 --test-threads 8 --profile ci',
    )
  })

  it('enables optional Cachix reads without authorizing uploads', () => {
    const cacheSteps = plainFlakeSetupSteps({ cachix: 'public-rust' })
    expect(cacheSteps.find((step) => step.uses === 'cachix/cachix-action@38b082610b782e7e93e209c35fd730d399dee866')?.with).toEqual({
      name: 'public-rust',
      skipPush: true,
    })
    expect(plainFlakeSetupSteps().some((step) => step.uses === 'cachix/cachix-action@38b082610b782e7e93e209c35fd730d399dee866')).toBe(
      false,
    )
  })
})
