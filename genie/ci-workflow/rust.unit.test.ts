import { describe, expect, it } from 'bun:test'

import { cargoNextestStep, nixDevelopStep, plainFlakeSetupSteps } from './rust.ts'

describe('plain-flake Rust CI', () => {
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
    expect(cacheSteps.find((step) => step.uses === 'cachix/cachix-action@v17')?.with).toEqual({
      name: 'public-rust',
      skipPush: true,
    })
    expect(plainFlakeSetupSteps().some((step) => step.uses === 'cachix/cachix-action@v17')).toBe(
      false,
    )
  })
})
