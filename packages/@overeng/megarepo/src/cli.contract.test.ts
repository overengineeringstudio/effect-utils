import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('../bin/mr.ts', import.meta.url))
const workspaceRoot = mkdtempSync(join(tmpdir(), 'megarepo-cli-contract-'))
writeFileSync(join(workspaceRoot, 'megarepo.kdl'), 'members {\n}\n')

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

/**
 * CLI contract capture: `status` and `signal` are cross-major invariants; stdout/stderr help,
 * usage, and error prose are captured for review but may be re-baselined by the megarepo owner
 * during Effect 4 repair with an alignment-register entry.
 * ANSI control bytes are normalized, so colour/styling changes are not gated by this baseline.
 * The local-source version suffix is normalized, so version-string content is not gated by this
 * baseline.
 */
// LIVE-MIGRATION BRIDGE effect-3-4 — DELETE at contraction — https://github.com/overengineeringstudio/effect-utils/issues/925
const stripAnsi = (output: string) =>
  output.replace(
    // eslint-disable-next-line no-control-regex -- CLI contract snapshots intentionally normalize terminal control bytes.
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu,
    '',
  )

const normalizeOutput = (output: string) =>
  stripAnsi(output).replace(/ — running from local source \([^)]+\)/gu, '')
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
    stdout: normalizeOutput(result.stdout),
    stderr: normalizeOutput(result.stderr),
    // LIVE-MIGRATION END effect-3-4
  }
}

describe('megarepo CLI contract baselines (status/signal invariant, prose owner-rebaselinable)', () => {
  it.each([
    ['root help', ['--help']],
    ['store help', ['store', '--help']],
    ['version', ['--version']],
    ['missing required repo', ['add']],
    ['invalid shell', ['env', '--shell', 'nope']],
  ] as const)('%s', (_name, args) => {
    expect(runCli(...args)).toMatchSnapshot()
  })

  it.each([
    {
      name: 'dash-prefixed operand',
      args: ['add', '--', '--not-a-flag'],
      stdout:
        '{"_tag":"Error","error":"invalid_repo","message":"Invalid repo reference: --not-a-flag"}\n',
      stderr: 'AddCommandError: Invalid repo reference (mr 0.1.0)\n',
    },
    {
      name: 'parent flag-name collision',
      args: ['add', '--', '--cwd'],
      stdout: '{"_tag":"Error","error":"invalid_repo","message":"Invalid repo reference: --cwd"}\n',
      stderr: 'AddCommandError: Invalid repo reference (mr 0.1.0)\n',
    },
    {
      name: 'subcommand flag-name collision',
      args: ['add', '--', '--name'],
      stdout:
        '{"_tag":"Error","error":"invalid_repo","message":"Invalid repo reference: --name"}\n',
      stderr: 'AddCommandError: Invalid repo reference (mr 0.1.0)\n',
    },
    {
      name: 'multiple operands preserve order until positional arity is exhausted',
      args: ['add', '--', '--first', '--name', '--last'],
      stdout: '',
      stderr:
        `Received unknown argument: '--name'\n\n` +
        `Error: {"_tag":"InvalidValue","error":{"_tag":"Paragraph","value":` +
        `{"_tag":"Text","value":"Received unknown argument: '--name'"}}}\n`,
    },
    {
      name: 'empty trailing operands',
      args: ['add', '--'],
      stdout: '',
      stderr:
        'Missing argument <repo>\n\nError: {"_tag":"MissingValue","error":{"_tag":"Paragraph","value":{"_tag":"Text","value":"Missing argument <repo>"}}}\n',
    },
  ])('retains nested terminator argv: $name', ({ args, stdout, stderr }) => {
    // TODO(live-migration:effect-3-4): v4 beta.102 drops argv after `--` for nested commands
    // (effect#6690). Do NOT rebaseline — this failing is the gate working. Resolve by landing the
    // upstream fix or the local parser patch, then re-run; the values here should be unchanged.
    expect(runCli('--cwd', workspaceRoot, ...args)).toEqual({
      status: 1,
      signal: null,
      stdout,
      stderr,
    })
  })
})
