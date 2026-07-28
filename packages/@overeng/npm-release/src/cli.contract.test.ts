import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url))

/**
 * CLI contract capture: `status` and `signal` are cross-major invariants; stdout/stderr help,
 * usage, and error prose are captured for review but may be re-baselined by the npm-release owner
 * during Effect 4 repair with an alignment-register entry.
 */
// LIVE-MIGRATION BRIDGE effect-3-4 — DELETE at contraction — https://github.com/overengineeringstudio/effect-utils/issues/925
const normalizeLogTime = (output: string) =>
  output.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/gm, '[time]')
// LIVE-MIGRATION END effect-3-4

const runCli = (...args: ReadonlyArray<string>) => {
  const result = spawnSync('bun', [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

  return {
    status: result.status,
    signal: result.signal,
    // LIVE-MIGRATION BRIDGE effect-3-4 — DELETE at contraction — https://github.com/overengineeringstudio/effect-utils/issues/925
    stdout: normalizeLogTime(result.stdout),
    stderr: normalizeLogTime(result.stderr),
    // LIVE-MIGRATION END effect-3-4
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
