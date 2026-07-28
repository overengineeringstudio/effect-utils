import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('../bin/ci-tools.ts', import.meta.url))

/**
 * CLI contract capture: `status` and `signal` are cross-major invariants; stdout/stderr help,
 * usage, and error prose are captured for review but may be re-baselined by the ci-tools owner
 * during Effect 4 repair with an alignment-register entry.
 * ANSI control bytes are normalized, so colour/styling changes are not gated by this baseline.
 */
const stripAnsi = (output: string) =>
  output.replace(
    // eslint-disable-next-line no-control-regex -- CLI contract snapshots intentionally normalize terminal control bytes.
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu,
    '',
  )

const normalizeOutput = (output: string) => stripAnsi(output)

const runCli = (...args: ReadonlyArray<string>) => {
  const result = spawnSync('bun', [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

  return {
    status: result.status,
    signal: result.signal,
    stdout: normalizeOutput(result.stdout),
    stderr: normalizeOutput(result.stderr),
  }
}

describe('ci-tools CLI contract baselines (status/signal invariant, prose owner-rebaselinable)', () => {
  it.each([
    ['root help', ['--help']],
    ['workflow-report help', ['workflow-report', '--help']],
    ['version', ['--version']],
    ['missing required bundle id', ['workflow-report', 'collect-bundle']],
    [
      'invalid deploy mode',
      ['deploy', 'netlify', '--target', 'web', '--artifact-dir', '/tmp', '--mode', 'nope'],
    ],
  ] as const)('%s', (_name, args) => {
    expect(runCli(...args)).toMatchSnapshot()
  })
})
