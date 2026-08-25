import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { normalizeCliOutput } from '@overeng/utils-dev/cli-contract'
import { describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url))

/**
 * CLI contract capture: `status` and `signal` are cross-major invariants; stdout/stderr help,
 * usage, and error prose are captured for review but may be re-baselined by the npm-release owner
 * during Effect 4 repair with an alignment-register entry.
 */

const runCli = (...args: ReadonlyArray<string>) => {
  const result = spawnSync('bun', [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

  return {
    status: result.status,
    signal: result.signal,
    stdout: normalizeCliOutput(result.stdout, { time: true }),
    stderr: normalizeCliOutput(result.stderr, { time: true }),
  }
}

describe('npm-release CLI contract baselines (status/signal invariant, prose owner-rebaselinable)', () => {
  it.each([
    ['root help', ['--help']],
    ['verify help', ['verify', '--help']],
    ['version', ['--version']],
    ['missing required plan', ['verify']],
    ['invalid integer', ['verify', '--plan', 'plan.json', '--attempts', 'nope']],
  ] as const)('%s', (_name, args) => {
    expect(runCli(...args)).toMatchSnapshot()
  })
})
