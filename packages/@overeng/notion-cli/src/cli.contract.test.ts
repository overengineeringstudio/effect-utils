import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url))

/**
 * CLI contract capture: `status` and `signal` are cross-major invariants; stdout/stderr help,
 * usage, and error prose are captured for review but may be re-baselined by the notion-cli owner
 * during Effect 4 repair with an alignment-register entry.
 * ANSI control bytes are normalized, so colour/styling changes are not gated by this baseline.
 * The local-source version suffix and log timestamps are normalized, so version-string content and
 * log timing are not gated by this baseline.
 */
// LIVE-MIGRATION BRIDGE effect-3-4 B7 — DELETE at contraction — https://github.com/overengineeringstudio/effect-utils/issues/925
const stripAnsi = (output: string) =>
  output.replace(
    // eslint-disable-next-line no-control-regex -- CLI contract snapshots intentionally normalize terminal control bytes.
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu,
    '',
  )

const normalizeOutput = (output: string) =>
  stripAnsi(output)
    .replace(/ — running from local source \([^)]+\)/gu, '')
    .replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/gmu, '[time]')
// LIVE-MIGRATION END effect-3-4

const runCli = (...args: ReadonlyArray<string>) => {
  const result = spawnSync('bun', [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

  return {
    status: result.status,
    signal: result.signal,
    // LIVE-MIGRATION BRIDGE effect-3-4 B7 — DELETE at contraction — https://github.com/overengineeringstudio/effect-utils/issues/925
    stdout: normalizeOutput(result.stdout),
    stderr: normalizeOutput(result.stderr),
    // LIVE-MIGRATION END effect-3-4
  }
}

describe('notion-cli CLI contract baselines (status/signal invariant, prose owner-rebaselinable)', () => {
  it.each([
    ['root help', ['--help']],
    ['db help', ['db', '--help']],
    ['version', ['--version']],
    ['missing required database id', ['db', 'info']],
    ['invalid integer', ['md', 'status', '--concurrency', 'nope', 'page.nmd']],
  ] as const)('%s', (_name, args) => {
    expect(runCli(...args)).toMatchSnapshot()
  })
})
